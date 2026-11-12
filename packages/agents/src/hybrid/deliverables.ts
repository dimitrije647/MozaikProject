import { needsFacts } from '../collections/registry';
import { CREATIVE_FORMATS } from '../creative/formats';
import { CAMPAIGN_PLATFORMS, isCampaignPlatform, type DeliverableKind, type CampaignPlatform } from '../creative/schemas';
import type { ChannelId } from '../strategy/channels';
import { formatClassOf, type TemplateDef } from '../templates/schema';
import type { TemplateSlot } from './plan';

/**
 * THE DELIVERABLES PLAN (pure, deterministic, no model). It decides what one campaign delivers, instead of a fixed creative quota:
 *
 *   social   one post visual per concept for each platform (X, TikTok cover, Facebook, Instagram, LinkedIn), in the platform's primary format
 *   ads      a web banner and a display ad for the lead concept(s)
 *   print    a billboard and a flyer for the lead concept
 *
 * A deliverable is planned only when the chosen collection can really draw its format with the content the campaign has. One it cannot draw is
 * listed in `notPlanned` with the reason: it is never replaced by another shape, stretched or faked.
 */

interface Spec {
  kind: DeliverableKind;
  label: string;
  channel: ChannelId;
  /** Preference order: the first format the collection can draw is used. */
  formats: string[];
  folder: string;
}

export const PLATFORM_DELIVERABLES: Record<CampaignPlatform, Spec> = {
  x: { kind: 'social_post', label: 'X post', channel: 'x', formats: ['x_post', 'instagram_square'], folder: 'social/x' },
  tiktok: { kind: 'social_post', label: 'TikTok cover (9:16)', channel: 'tiktok', formats: ['story'], folder: 'social/tiktok' },
  facebook: { kind: 'social_post', label: 'Facebook post', channel: 'facebook', formats: ['facebook_feed', 'instagram_square'], folder: 'social/facebook' },
  instagram: { kind: 'social_post', label: 'Instagram post', channel: 'instagram', formats: ['instagram_portrait', 'instagram_square'], folder: 'social/instagram' },
  linkedin: { kind: 'social_post', label: 'LinkedIn post', channel: 'linkedin', formats: ['linkedin_feed', 'instagram_square'], folder: 'social/linkedin' },
};

/** Campaign-level deliverables and how many lead concepts get one. Ads carry the nominal ad channel, print the nominal print channel. */
export const CAMPAIGN_DELIVERABLES: (Spec & { concepts: number })[] = [
  { kind: 'web_ad', label: 'Web banner ad', channel: 'google_search', formats: ['web_banner'], folder: 'ads/web', concepts: 2 },
  { kind: 'display_ad', label: 'Display ad', channel: 'google_search', formats: ['display_square', 'promo_16x9'], folder: 'ads/display', concepts: 2 },
  { kind: 'billboard', label: 'Billboard', channel: 'organic_content', formats: ['billboard'], folder: 'print/billboards', concepts: 1 },
  { kind: 'flyer', label: 'Flyer', channel: 'organic_content', formats: ['flyer'], folder: 'print/flyers', concepts: 1 },
];

export const MAX_DELIVERABLES = 24;

export const folderOf = (kind: DeliverableKind, channel: string): string => (kind === 'social_post' ? `social/${channel}` : (CAMPAIGN_DELIVERABLES.find((d) => d.kind === kind)?.folder ?? 'other'));

export interface DeliverablesInput {
  concepts: { id: string; name: string }[];
  /** The social platforms to write for (default: all five). Other channel ids are ignored. */
  platforms?: readonly string[];
  /** The templates the campaign may use (the chosen collection's). */
  library: readonly TemplateDef[];
  /** Whether approved pictures exist (photo-only templates are then drawable). */
  hasPicture: boolean;
  /** The facts the user gave (templates that need one are drawable only with it). */
  facts: Record<string, string | undefined>;
  /** Whether copy exists for this concept and deliverable (a deliverable without copy is not planned). Default: always. */
  hasCopy?: (conceptId: string, kind: DeliverableKind, channel: ChannelId) => boolean;
}

export interface NotPlanned {
  kind: DeliverableKind;
  label: string;
  format: string;
  conceptId: string | null;
  reason: string;
}

export interface DeliverablesPlan {
  platforms: CampaignPlatform[];
  slots: TemplateSlot[];
  notPlanned: NotPlanned[];
  rules: string[];
  warnings: string[];
}

export function planDeliverables(input: DeliverablesInput): DeliverablesPlan {
  const platforms = (input.platforms?.length ? CAMPAIGN_PLATFORMS.filter((p) => input.platforms!.includes(p)) : [...CAMPAIGN_PLATFORMS]).filter(isCampaignPlatform);
  const have = new Set(Object.entries(input.facts).filter(([, v]) => (v ?? '').trim()).map(([k]) => k));
  const usable = input.library.filter((t) => t.status === 'active' && needsFacts(t).every((r) => have.has(r)) && (input.hasPicture || !t.requires.includes('image')));
  const drawable = (formatId: string) => {
    const f = CREATIVE_FORMATS[formatId];
    if (!f) return false;
    const cls = formatClassOf(f.width, f.height);
    return usable.some((t) => t.classes.includes(cls));
  };
  const hasCopy = input.hasCopy ?? (() => true);
  const slots: TemplateSlot[] = [];
  const notPlanned: NotPlanned[] = [];
  const warnings: string[] = [];
  const indexOf = new Map<string, number>();
  const add = (spec: Spec, concept: { id: string; name: string }) => {
    const formatId = spec.formats.find(drawable);
    if (!formatId) {
      notPlanned.push({ kind: spec.kind, label: spec.label, format: spec.formats[0], conceptId: concept.id, reason: `The chosen template collection has no template that can draw ${CREATIVE_FORMATS[spec.formats[0]]?.label ?? spec.formats[0]} with the content this campaign has.` });
      return;
    }
    if (!hasCopy(concept.id, spec.kind, spec.channel)) {
      notPlanned.push({ kind: spec.kind, label: spec.label, format: formatId, conceptId: concept.id, reason: 'The Content Writer produced no copy for it.' });
      return;
    }
    if (slots.length >= MAX_DELIVERABLES) {
      notPlanned.push({ kind: spec.kind, label: spec.label, format: formatId, conceptId: concept.id, reason: `The campaign already has ${MAX_DELIVERABLES} deliverables (the upper limit of one campaign).` });
      return;
    }
    const f = CREATIVE_FORMATS[formatId];
    const index = (indexOf.get(concept.id) ?? 0) + 1;
    indexOf.set(concept.id, index);
    slots.push({
      slotId: spec.kind === 'social_post' ? `${concept.id}-${spec.channel}` : `${concept.id}-${spec.kind.replace('_', '-')}`,
      conceptId: concept.id,
      conceptName: concept.name,
      index,
      channel: spec.channel,
      formatId,
      width: f.width,
      height: f.height,
      formatClass: formatClassOf(f.width, f.height),
      variationId: null,
      source: 'none',
      kind: spec.kind,
      label: spec.label,
      folder: spec.folder,
      fixedFormat: spec.kind !== 'social_post',
    });
  };
  // the campaign-level deliverables first (lead concepts), so the upper limit never drops a billboard or a flyer in favour of one more post
  for (const spec of CAMPAIGN_DELIVERABLES) for (const c of input.concepts.slice(0, Math.max(1, spec.concepts))) add(spec, c);
  for (const c of input.concepts) for (const p of platforms) add(PLATFORM_DELIVERABLES[p], c);
  // stable order for people: concept by concept, social first
  const kindRank: Record<DeliverableKind, number> = { social_post: 0, web_ad: 1, display_ad: 2, billboard: 3, flyer: 4 };
  const conceptRank = new Map(input.concepts.map((c, i) => [c.id, i]));
  slots.sort((a, b) => (conceptRank.get(a.conceptId) ?? 0) - (conceptRank.get(b.conceptId) ?? 0) || kindRank[a.kind!] - kindRank[b.kind!] || platforms.indexOf(a.channel as CampaignPlatform) - platforms.indexOf(b.channel as CampaignPlatform));
  const byConcept = new Map<string, number>();
  for (const s of slots) {
    const n = (byConcept.get(s.conceptId) ?? 0) + 1;
    byConcept.set(s.conceptId, n);
    s.index = n;
  }
  if (notPlanned.length) warnings.push(`${notPlanned.length} deliverable(s) could not be planned; each one is listed with the reason.`);
  return {
    platforms,
    slots,
    notPlanned,
    rules: [
      'One post visual per concept for each social platform, in the platform\'s primary format (TikTok: a 9:16 cover image; the video itself is a script, never generated).',
      'A web banner and a display ad for the lead concepts, a billboard and a flyer for the lead concept.',
      `At most ${MAX_DELIVERABLES} deliverables per campaign.`,
      'A format the chosen collection cannot draw is reported, never replaced by another shape or stretched.',
    ],
    warnings,
  };
}
