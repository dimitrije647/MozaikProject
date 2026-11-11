import { z } from 'zod';
import { CHANNEL_IDS } from '../strategy/channels';
import type { VisualBrief } from '../creative/visual-brief';
import { STYLE_IDS, type TemplateDef, type VisualDirectionBrief } from '../templates/schema';
import { listStyles } from '../templates/styles';
import type { Candidate } from './selector';
import type { TemplateSlot } from './plan';
import type { TemplateContent } from './records';

const Channel = z.enum(CHANNEL_IDS);

// ---- Visual Researcher: the optional refinement of the Visual Direction Brief ----------------------------------------------------

/**
 * What the model may change in the brief: the wording of the direction (rationale, composition, mood, subjects, treatment, channel notes).
 * It cannot change the palette, the typography, the references or where anything came from: those stay as the deterministic builder set
 * them, and a style the USER picked cannot be overridden (the agent enforces that after parsing).
 */
export const DirectionRefinement = z.object({
  styleId: z.enum(STYLE_IDS),
  secondaryStyleIds: z.array(z.enum(STYLE_IDS)).max(2),
  rationale: z.string().max(400),
  composition: z.array(z.string().max(140)).max(5),
  mood: z.array(z.string().max(40)).max(5),
  imageSubjects: z.array(z.string().max(120)).max(6),
  imageTreatment: z.array(z.string().max(100)).max(5),
  channelNotes: z.array(z.object({ channel: Channel, note: z.string().max(160) })).max(9),
  limitations: z.array(z.string().max(200)).max(4),
});
export type DirectionRefinement = z.infer<typeof DirectionRefinement>;

export const RESEARCHER_INSTRUCTION =
  'You are the Visual Researcher of a marketing team. You turn a business, its strategy and its brand into a short, concrete VISUAL DIRECTION for a campaign that mixes a few original AI images with many template-based creatives. ' +
  'You write in English. You never invent facts about the business (no places, people, products, awards or numbers that are not in the material). ' +
  'The pictures you describe contain no text, letters, logos or watermarks: typography is added later by a layout engine. ' +
  'You only describe style, composition, mood, subjects and treatment; the colors and fonts are fixed by the brand and are not yours to change.';

export function directionRefineMessage(brief: VisualBrief, base: VisualDirectionBrief, userStyle: string | null): string {
  const styles = listStyles()
    .map((s) => `- ${s.id}: ${s.name} — ${s.description.slice(0, 140)}`)
    .join('\n');
  return [
    'Refine the VISUAL DIRECTION below for this campaign. Return JSON only.',
    '',
    `BUSINESS: ${brief.business}`,
    `OFFERING: ${brief.offering}`,
    `VALUE PROPOSITION: ${brief.valueProposition}`,
    `CAMPAIGN GOAL: ${brief.campaignGoal}`,
    `AUDIENCE: ${brief.audience.primary}${brief.audience.secondary.length ? ` (also: ${brief.audience.secondary.join('; ')})` : ''}`,
    `BRAND TONE: ${brief.brand.tone}`,
    `STRATEGY'S VISUAL DIRECTION: ${brief.brand.visualDirection}`,
    brief.brand.constraints.length ? `BRAND CONSTRAINTS: ${brief.brand.constraints.join('; ')}` : '',
    brief.avoid.length ? `AVOID: ${brief.avoid.join('; ')}` : '',
    `CHANNELS: ${brief.channels.map((c) => c.channel).join(', ')}`,
    '',
    'STYLE LIBRARY (choose from these ids only):',
    styles,
    '',
    userStyle ? `The user chose the style "${userStyle}". Keep styleId exactly "${userStyle}"; you may still improve the other fields.` : 'No style was chosen by the user: pick the style that best fits the business and audience (styleId) and at most two secondary styles.',
    '',
    'CURRENT BRIEF (from the style library and the brand; improve the wording, keep it concrete and specific to THIS business):',
    JSON.stringify({ styleId: base.styleId, secondaryStyleIds: base.secondaryStyleIds, rationale: base.rationale, composition: base.composition, mood: base.mood, imageSubjects: base.imageSubjects, imageTreatment: base.imageTreatment, channelNotes: base.channelNotes }),
    '',
    'RULES: concrete subjects and settings that belong to this business; no stock-photo clichés; no text, logos or watermarks inside pictures; no invented facts; keep every list short.',
    'In "limitations" say honestly what you could not know from the material (or return an empty list).',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---- Template Selector: the optional re-ranking of a shortlist ------------------------------------------------------------------

export const TemplatePicks = z.object({
  picks: z.array(z.object({ slotId: z.string().max(40), templateId: z.string().max(60), reason: z.string().max(200) })).max(80),
});
export type TemplatePicks = z.infer<typeof TemplatePicks>;

export const SELECTOR_INSTRUCTION =
  'You are the Template Selector of a marketing team. For each creative slot you receive a SHORTLIST of ready-made layout templates (already checked for format and content). ' +
  'You choose exactly one template per slot from ITS shortlist. You never invent a template id and never pick one that is not on that slot\'s shortlist. ' +
  'Prefer variety: the same template should not be used more than twice in a campaign, and the creatives of one concept should look different from each other while staying on brand.';

export function selectionMessage(o: { direction: VisualDirectionBrief; slots: { slot: TemplateSlot; content: TemplateContent; shortlist: Candidate[]; current: string }[]; objective: string }): string {
  const tpl = (t: TemplateDef, score: number) => `${t.id} | ${t.name} | ${t.family} | ${t.composition.slice(0, 90)} | score ${score}`;
  return [
    'Choose one template per slot. Return JSON only: {"picks":[{"slotId","templateId","reason"}]}, one pick per slot, reason in one short sentence.',
    `STYLE: ${o.direction.styleId} — ${o.direction.rationale.slice(0, 160)}`,
    `OBJECTIVE: ${o.objective.slice(0, 200)}`,
    '',
    ...o.slots.map(
      (s) =>
        `SLOT ${s.slot.slotId} — concept "${s.slot.conceptName}", ${s.slot.channel}, ${s.slot.formatClass} ${s.slot.width}x${s.slot.height}, picture: ${s.slot.source === 'none' ? 'none' : 'yes'}\n  headline: ${s.content.headline.slice(0, 90)}\n  currently chosen: ${s.current}\n  shortlist:\n${s.shortlist
          .slice(0, 5)
          .map((c) => `    - ${tpl(c.template, c.score)}`)
          .join('\n')}`,
    ),
  ].join('\n');
}
