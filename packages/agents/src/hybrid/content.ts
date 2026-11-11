import type { ConceptRecord, CopyVariantRecord } from '../creative/schemas';
import type { CreativeContent } from '../templates/schema';
import type { TemplateSlot } from './plan';
import type { TemplateContent } from './records';
import type { HybridFacts } from './settings';

/** The text a creative shows is the approved copy of the concept: the headline, a trimmed supporting line and the call to action. */
export const supportingTextOf = (v: Pick<CopyVariantRecord, 'description' | 'body'>) => {
  const t = (v.description ?? v.body).replace(/\s+/g, ' ').trim();
  return t.length <= 110 ? t : `${t.slice(0, 107).replace(/\s+\S*$/, '')}…`;
};

const pickVariant = (variants: CopyVariantRecord[], conceptId: string, channel: string) =>
  variants.find((v) => v.conceptId === conceptId && v.channel === channel && v.placement === 'paid_ad') ?? variants.find((v) => v.conceptId === conceptId && v.channel === channel) ?? variants.find((v) => v.conceptId === conceptId);

/** The content for a slot, from the concept's real copy. null when the concept has no copy at all (nothing to place, nothing invented). */
export function contentForSlot(slot: Pick<TemplateSlot, 'conceptId' | 'channel'>, concepts: Pick<ConceptRecord, 'id' | 'name'>[], variants: CopyVariantRecord[]): TemplateContent | null {
  const v = pickVariant(variants, slot.conceptId, slot.channel);
  if (!v) return null;
  const concept = concepts.find((c) => c.id === slot.conceptId);
  const eyebrow = concept && concept.name.length <= 40 && concept.name.trim().toLowerCase() !== v.headline.trim().toLowerCase() ? concept.name.trim() : null;
  return { headline: v.headline.trim(), support: supportingTextOf(v) || null, cta: v.ctaText.trim() || null, eyebrow, variantId: v.id };
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
