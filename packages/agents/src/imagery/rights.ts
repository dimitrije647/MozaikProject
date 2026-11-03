import type { ImageSourceKind, LicenseVerdict } from './types';

/**
 * RIGHTS OF A PICTURE IN THE PROJECT'S IMAGE LIBRARY. One picture, one rights record, and ONE function (`exportEligibility`) that says whether the
 * picture may appear in an exported creative. Rights are a HARD GATE: nothing below, not a score, not an approval click, not an automatic mode,
 * can make a picture eligible that the rules do not allow. Approval alone never overrides a third-party license.
 *
 *   upload    the user's own file. The user confirms the right to use it when uploading it.
 *   website   found on the project's own website. A website image is a CANDIDATE: it belongs to whoever made it. It becomes usable only when
 *             the project owner attests that they hold the rights.
 *   github    found in the project's repository. Public visibility is not permission to reuse a file commercially: same rule as a website image.
 *   social    a link to the brand's social profile. Platform content is never fetched by LaunchPilot; the link is shown so the owner can import
 *             a picture they own BY HAND (it then becomes an upload with a note). Never an asset by itself.
 *   stock     a licensed image provider. Usable when the provider's license clears advertising use (or the user checked the source).
 */
export const LIBRARY_SOURCES = ['upload', 'website', 'github', 'social', 'stock'] as const;
export type LibrarySource = (typeof LIBRARY_SOURCES)[number];

export const LIBRARY_SOURCE_LABELS: Record<LibrarySource, string> = {
  upload: 'My uploaded images',
  website: 'Website candidates',
  github: 'GitHub assets',
  social: 'Social media references',
  stock: 'Licensed stock images',
};

/**
 * cleared            the rights hold (own file, or a provider license that allows advertising use)
 * needs_attestation  the owner must affirm that they hold the rights (website, repository)
 * needs_review       the license must be checked at its source and confirmed (some stock licenses)
 * attested           the owner affirmed the rights
 * reference_only     to look at, never to use
 * blocked            the license does not allow advertising use
 */
export type RightsStatus = 'cleared' | 'needs_attestation' | 'needs_review' | 'attested' | 'reference_only' | 'blocked';

export type RightsVerification = 'user_owned' | 'provider_license' | 'user_attested' | 'user_reviewed' | 'unverified';

export interface ImageRights {
  source: LibrarySource;
  kind: ImageSourceKind;
  status: RightsStatus;
  /** the license in words: "Pixabay Content License", "Provided by the user", "No license stated: the owner's rights" */
  license: string;
  licenseUrl: string | null;
  verification: RightsVerification;
  /** LaunchPilot may store a copy of the file */
  downloadAllowed: boolean;
  /** use in advertising */
  commercialUse: boolean;
  /** cropping, resizing, text over the picture */
  derivatives: boolean;
  /** the ORIGINAL file may be included in an exported archive */
  redistributeOriginal: boolean;
  attributionRequired: boolean;
  attribution: string | null;
  /** the project owner approved the picture for this campaign */
  userApproved: boolean;
  attestedAt: string | null;
  reasons: string[];
}

export interface Eligibility {
  eligible: boolean;
  /** a plain sentence: why it is or is not eligible */
  reason: string;
}

/** THE gate. A picture enters an exported creative only through here. */
export function exportEligibility(r: ImageRights): Eligibility {
  if (r.kind === 'REFERENCE_ONLY' || r.status === 'reference_only') return { eligible: false, reason: 'Reference only: it is shown for inspiration and is never part of a creative.' };
  if (r.status === 'blocked') return { eligible: false, reason: `The license (${r.license}) does not allow use in advertising.` };
  if (r.status === 'needs_attestation') return { eligible: false, reason: 'Confirm that you hold the rights to use this picture in advertising before it can be used.' };
  if (r.status === 'needs_review') return { eligible: false, reason: 'Check the license at the source and confirm it before this picture can be used.' };
  if (r.verification === 'unverified') return { eligible: false, reason: 'The rights to this picture are not verified.' };
  if (!r.commercialUse) return { eligible: false, reason: 'The rights do not cover commercial use.' };
  if (!r.derivatives) return { eligible: false, reason: 'The rights do not cover cropping and laying text over the picture.' };
  if (!r.downloadAllowed) return { eligible: false, reason: 'A copy of the picture may not be stored.' };
  if (!r.userApproved) return { eligible: false, reason: 'You have not approved this picture for the campaign.' };
  return { eligible: true, reason: r.status === 'attested' ? 'You confirmed that you hold the rights.' : r.verification === 'provider_license' ? `Cleared by the ${r.license}.` : r.verification === 'user_reviewed' ? 'You checked the license at its source.' : 'Provided by you.' };
}

/** A candidate that could become eligible after the owner's confirmation (as opposed to one that never can). */
export const couldBecomeEligible = (r: ImageRights): boolean => r.kind !== 'REFERENCE_ONLY' && r.status !== 'reference_only' && r.status !== 'blocked';

// ---- builders: the rights a picture starts with, by where it came from ---------------------------------------------------------------------------

/** An uploaded file: the user provided it and confirmed the right to use it. */
export function uploadRights(o: { brandAsset?: boolean; note?: string } = {}): ImageRights {
  return {
    source: 'upload',
    kind: o.brandAsset ? 'BRAND_ASSET' : 'USER_PROVIDED',
    status: 'cleared',
    license: 'Provided by the user',
    licenseUrl: null,
    verification: 'user_owned',
    downloadAllowed: true,
    commercialUse: true,
    derivatives: true,
    redistributeOriginal: true,
    attributionRequired: false,
    attribution: null,
    userApproved: true,
    attestedAt: null,
    reasons: [o.note ?? 'Uploaded by the project owner, who confirms the right to use it.'],
  };
}

/** A picture found on the project's website or in its repository: a candidate until the owner attests the rights. */
export function candidateRights(source: 'website' | 'github', o: { license?: string | null; licenseUrl?: string | null; firstParty?: boolean; note?: string } = {}): ImageRights {
  return {
    source,
    kind: 'BRAND_ASSET',
    status: 'needs_attestation',
    license: o.license?.trim() ? o.license : source === 'website' ? 'No license stated: the rights belong to whoever made the picture' : 'Repository file: no reuse license for this file',
    licenseUrl: o.licenseUrl ?? null,
    verification: 'unverified',
    downloadAllowed: false,
    commercialUse: false,
    derivatives: false,
    redistributeOriginal: false,
    attributionRequired: false,
    attribution: null,
    userApproved: false,
    attestedAt: null,
    reasons: [
      source === 'website'
        ? o.firstParty === false
          ? 'This picture is served from another website. Being on your page does not make it yours: confirm that you hold the rights.'
          : 'Pictures on a website are not automatically free to reuse. Confirm that you own this picture or hold the rights to use it in advertising.'
        : 'A public repository does not grant permission to reuse its files commercially. Confirm that you own this file or hold the rights to use it in advertising.',
      ...(o.note ? [o.note] : []),
    ],
  };
}

/** A social profile link: the page may be opened by a person; nothing on it is fetched, stored or used. */
export function socialRights(platform: string): ImageRights {
  return {
    source: 'social',
    kind: 'REFERENCE_ONLY',
    status: 'reference_only',
    license: `${platform}: no reuse right granted by being public`,
    licenseUrl: null,
    verification: 'unverified',
    downloadAllowed: false,
    commercialUse: false,
    derivatives: false,
    redistributeOriginal: false,
    attributionRequired: false,
    attribution: null,
    userApproved: false,
    attestedAt: null,
    reasons: [`A public ${platform} post does not give anyone the right to use it in an advertisement. LaunchPilot never copies platform content. If you own a picture shown there, upload your own file.`],
  };
}

/** A stock result: the provider's license decides. */
export function stockRights(v: LicenseVerdict, o: { userApproved?: boolean; reviewConfirmed?: boolean } = {}): ImageRights {
  const ok = v.status !== 'blocked' && v.commercialUse && v.derivatives;
  const reviewed = v.status === 'needs_review' && o.reviewConfirmed === true;
  return {
    source: 'stock',
    kind: ok ? 'LICENSED_STOCK' : 'REFERENCE_ONLY',
    status: !ok ? 'blocked' : v.status === 'cleared' ? 'cleared' : reviewed ? 'cleared' : 'needs_review',
    license: v.license,
    licenseUrl: v.licenseUrl,
    verification: !ok ? 'unverified' : v.status === 'cleared' ? 'provider_license' : reviewed ? 'user_reviewed' : 'unverified',
    downloadAllowed: ok,
    commercialUse: v.commercialUse,
    derivatives: v.derivatives,
    redistributeOriginal: v.redistributeOriginal === true,
    attributionRequired: v.attributionRequired,
    attribution: v.attribution,
    userApproved: ok && o.userApproved === true,
    attestedAt: null,
    reasons: v.reasons,
  };
}

/** The owner affirms that they hold the rights (website, repository). Only a candidate that could ever be eligible can be attested. */
export function attestRights(r: ImageRights, o: { at: Date; approve?: boolean }): ImageRights {
  if (!couldBecomeEligible(r)) return r;
  if (r.source !== 'website' && r.source !== 'github') return r;
  return { ...r, status: 'attested', verification: 'user_attested', downloadAllowed: true, commercialUse: true, derivatives: true, redistributeOriginal: true, userApproved: o.approve !== false, attestedAt: o.at.toISOString(), license: 'Rights confirmed by the project owner', reasons: [...r.reasons, 'The project owner confirmed that they hold the rights to use this picture in advertising.'] };
}

/** A stock picture whose license needs a check at its source: the user checked it. */
export function confirmReview(r: ImageRights): ImageRights {
  if (r.source !== 'stock' || r.status !== 'needs_review') return r;
  return { ...r, status: 'cleared', verification: 'user_reviewed', userApproved: true };
}

export function approveRights(r: ImageRights, approved: boolean): ImageRights {
  return { ...r, userApproved: approved };
}

/** A short rights line for an asset record and the usage notes ("Pixabay Content License, credit: Image by X on Pixabay"). */
export function rightsSummary(r: Pick<ImageRights, 'license' | 'verification' | 'attribution' | 'attributionRequired' | 'source'>): string {
  const how = r.verification === 'user_owned' ? 'provided by the user' : r.verification === 'user_attested' ? 'rights confirmed by the owner' : r.verification === 'provider_license' ? 'licensed' : r.verification === 'user_reviewed' ? 'license checked by the user' : 'not verified';
  return `${r.license} (${how})${r.attribution ? `; credit: ${r.attribution}${r.attributionRequired ? ' (required)' : ''}` : ''}`.slice(0, 240);
}
