import type { ConceptRecord, CopyVariantRecord } from '../creative/schemas';
import type { CreativeContent } from '../templates/schema';
import type { TemplateSlot } from './plan';
import type { TemplateContent } from './records';
import type { HybridFacts } from './settings';

/** The text a creative shows is the approved copy of the concept: the headline, the supporting line written for the visual (else a trimmed body) and the call to action. */
export const supportingTextOf = (v: Pick<CopyVariantRecord, 'description' | 'body'> & { visualLine?: string | null }) => {
  // the Content Writer's own line for the visual comes first: a cut-off caption is a last resort (older campaigns)
  const t = (v.visualLine || v.description || v.body).replace(/\s+/g, ' ').trim();
  return t.length <= 110 ? t : `${t.slice(0, 107).replace(/\s+\S*$/, '')}…`;
};

/**
 * The copy a slot shows. V4 slots name their deliverable: a social post uses that platform's post, an ad or print slot uses the ad or print copy
 * of its concept. Older slots (no kind) keep the earlier rule: the concept's paid ad for the channel, else any copy of the channel, else any copy.
 */
const pickVariant = (variants: CopyVariantRecord[], slot: Pick<TemplateSlot, 'conceptId' | 'channel' | 'kind'>) => {
  const mine = variants.filter((v) => v.conceptId === slot.conceptId);
  if (slot.kind === 'social_post') return mine.find((v) => v.placement === 'social_post' && v.channel === slot.channel);
  if (slot.kind) return mine.find((v) => v.placement === slot.kind);
  return mine.find((v) => v.channel === slot.channel && v.placement === 'paid_ad') ?? mine.find((v) => v.channel === slot.channel) ?? mine[0];
};

/** The content for a slot, from the concept's real copy. null when there is no copy for it (nothing to place, nothing invented). */
export function contentForSlot(slot: Pick<TemplateSlot, 'conceptId' | 'channel' | 'kind'>, concepts: Pick<ConceptRecord, 'id' | 'name'>[], variants: CopyVariantRecord[]): TemplateContent | null {
  const v = pickVariant(variants, slot);
  if (!v) return null;
  const concept = concepts.find((c) => c.id === slot.conceptId);
  const eyebrow = concept && concept.name.length <= 40 && concept.name.trim().toLowerCase() !== v.headline.trim().toLowerCase() ? concept.name.trim() : null;
  // a billboard carries its headline and nothing else that has to be read from a distance
  const support = slot.kind === 'billboard' ? null : supportingTextOf(v) || null;
  return { headline: v.headline.trim(), support, cta: v.ctaText.trim() || null, eyebrow: slot.kind === 'billboard' ? null : eyebrow, variantId: v.id };
}

/** What a forecast (before any copy exists) assumes: every slot will have a headline, a supporting line and a call to action. */
export function forecastContent(slot: Pick<TemplateSlot, 'conceptName'>): TemplateContent {
  return { headline: `Headline for ${slot.conceptName}`, support: 'Supporting line', cta: 'Call to action', eyebrow: slot.conceptName.length <= 40 ? slot.conceptName : null, variantId: null };
}

/** The renderer's content: the approved copy plus the brand name and ONLY the facts the user supplied. */
export function renderContent(content: TemplateContent, brandName: string, facts: HybridFacts, dropSupport = false): CreativeContent {
  const out: CreativeContent = { headline: content.headline };
  if (content.support && !dropSupport) out.support = content.support;
  if (content.cta) out.cta = content.cta;
  if (content.eyebrow) out.eyebrow = content.eyebrow;
  if (brandName) out.brand = brandName;
  for (const [k, v] of Object.entries(facts)) if (typeof v === 'string' && v.trim()) (out as Record<string, string>)[k] = v.trim();
  return out;
}
