import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { isImageBuffer } from '../templates/image-palette';
import type { WebFetchTool } from '../tools/web-fetch';
import type { ImageCandidate } from './types';

/**
 * ACQUIRING a licensed picture: the step that turns a candidate into bytes the project may keep. It happens only when the USER chose the
 * picture, and only when its license allows what a campaign does with it. The provenance that comes back (who made it, where it is, under
 * which license, which credit line) is stored with the asset and travels with every creative built from it.
 *
 * A REFERENCE_ONLY candidate, a blocked license, or a picture whose license needs a check that the user has not confirmed, is refused here:
 * this is the one gate through which a third-party picture can enter a campaign.
 */

export interface Provenance {
  provider: string;
  providerImageId: string;
  pageUrl: string;
  creator: string | null;
  creatorUrl: string | null;
  license: string;
  licenseUrl: string | null;
  attribution: string | null;
  attributionRequired: boolean;
  /** cleared by the provider's license, or confirmed by the user after checking the source */
  licenseBasis: 'provider_license' | 'user_reviewed';
  width: number;
  height: number;
  sha256: string;
  acquiredAt: string;
}

export type AcquireFailure = 'reference_only' | 'license_blocked' | 'review_required' | 'host_not_allowed' | 'download_failed' | 'not_an_image' | 'too_small';

export type AcquireResult = { ok: true; data: Buffer; mimeType: string; provenance: Provenance } | { ok: false; code: AcquireFailure; message: string };

/** The only hosts a provider's files are downloaded from. Openverse works come from many publishers: those go through the same public-address checks. */
const DOWNLOAD_HOSTS: Record<string, readonly string[] | null> = { pixabay: ['pixabay.com'], pexels: ['pexels.com'], openverse: null };

export const MIN_STOCK_SIDE = 900;

export async function acquireLicensedImage(c: ImageCandidate, deps: { web: Pick<WebFetchTool, 'fetchAsset'>; reviewConfirmed?: boolean; now?: () => Date; signal?: AbortSignal }): Promise<AcquireResult> {
  if (c.kind !== 'LICENSED_STOCK' || !c.downloadUrl) return { ok: false, code: 'reference_only', message: 'This picture is shown for inspiration only. It is never downloaded or used in a creative.' };
  if (c.license.status === 'blocked' || !c.license.commercialUse || !c.license.derivatives) return { ok: false, code: 'license_blocked', message: `The license (${c.license.license}) does not allow this picture to be used in advertising. ${c.license.reasons[0] ?? ''}`.trim() };
  if (c.license.status === 'needs_review' && !deps.reviewConfirmed) return { ok: false, code: 'review_required', message: `Check the license at the source before using this picture: ${c.license.reasons.join(' ')}`.slice(0, 600) };
  const allowed = DOWNLOAD_HOSTS[c.provider];
  let host: string;
  try {
    host = new URL(c.downloadUrl).hostname;
  } catch {
    return { ok: false, code: 'host_not_allowed', message: 'The download address is not valid.' };
  }
  if (allowed === undefined || (allowed && !allowed.some((h) => host === h || host.endsWith(`.${h}`)))) return { ok: false, code: 'host_not_allowed', message: 'The picture is not hosted by its provider, so it was not downloaded.' };
  const r = await deps.web.fetchAsset(c.downloadUrl, { kind: 'image', maxBytes: 8 * 1024 * 1024, signal: deps.signal });
  if (!r.ok) return { ok: false, code: 'download_failed', message: `The picture could not be downloaded (${r.message}).` };
  if (!isImageBuffer(r.body)) return { ok: false, code: 'not_an_image', message: 'The file is not a PNG, JPEG, WebP or GIF picture.' };
  let meta: sharp.Metadata;
  try {
    meta = await sharp(r.body, { limitInputPixels: 60_000_000, failOn: 'error' }).metadata();
  } catch {
    return { ok: false, code: 'not_an_image', message: 'The picture could not be read.' };
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (Math.max(w, h) < MIN_STOCK_SIDE) return { ok: false, code: 'too_small', message: `The picture is only ${w}x${h} pixels; at least ${MIN_STOCK_SIDE} on the long side is needed so it stays sharp in a creative.` };
  return {
    ok: true,
    data: r.body,
    mimeType: r.contentType,
    provenance: {
      provider: c.provider,
      providerImageId: c.id,
      pageUrl: c.pageUrl,
      creator: c.creator,
      creatorUrl: c.creatorUrl,
      license: c.license.license,
      licenseUrl: c.license.licenseUrl,
      attribution: c.license.attribution,
      attributionRequired: c.license.attributionRequired,
      licenseBasis: c.license.status === 'cleared' ? 'provider_license' : 'user_reviewed',
      width: w,
      height: h,
      sha256: createHash('sha256').update(r.body).digest('hex'),
      acquiredAt: (deps.now?.() ?? new Date()).toISOString(),
    },
  };
}

/** The credit lines of a campaign: one line per licensed picture that carries an attribution (required or customary). Empty when there are none. */
export function creditsText(items: readonly Pick<Provenance, 'provider' | 'attribution' | 'pageUrl' | 'license' | 'attributionRequired'>[]): string {
  const lines = items
    .filter((p) => p.attribution)
    .map((p) => `${p.attribution} (${p.license}${p.attributionRequired ? ', credit required' : ''}) ${p.pageUrl}`);
  return lines.length ? ['Image credits', '', ...lines, ''].join('\n') : '';
}
