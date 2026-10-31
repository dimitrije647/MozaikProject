import { normalizeText } from '../discovery/input';
import { scrubFigures } from '../strategy/policy';
import type { F1Context } from '../audit/context';
import type { CreativeBoard } from './board';
import type { F3Context } from './context';
import { CREATIVE_FORMATS } from './formats';
import { foldDiacritics, promiseMatches } from './lexicon';
import { limitsFor } from './limits';
import type { LandingContent, ReviewFindingRecord } from './schemas';

/**
 * Deterministic quality checks (the Reviewer's first pass; no model call). They catch what code can prove:
 * claims the strategy forbade, money/percentage figures that exist in no source, promise words (guarantee, award, testimonial,
 * customer counts...) in the campaign language that the supplied material does not support, text longer than a channel
 * allows or shows, wrong dimensions, text that does not fit, unreadable contrast, a missing or colliding logo, missing
 * deliverables, and a CTA that differs between the ads and the landing page.
 * Judgment calls (tone, relevance, visual quality) are left to the model reviews.
 */
export type RawFinding = Omit<ReviewFindingRecord, 'id' | 'round' | 'status' | 'resolvedInRound'>;


/** Word tokens without punctuation: "results." and "results" are the same word. */
export const wordTokens = (s: string) => new Set(normalizeText(s).replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter((t) => t.length > 2));
const tokens = wordTokens;

export function corpusOf(f1: F1Context, f3: F3Context, extra: string[] = []): string {
  return normalizeText(`${JSON.stringify(f1.report)} ${JSON.stringify({ ...f3.report, evidence: undefined, creativeBrief: { ...f3.report.creativeBrief, claimsToAvoid: [] } })} ${extra.join(' ')}`);
}

const landingTexts = (l: LandingContent): { ref: string; text: string }[] => [
  { ref: 'landing', text: [l.seoTitle, l.metaDescription, l.hero.headline, l.hero.description, l.hero.ctaText, l.valueProposition].join(' . ') },
  ...l.benefits.map((b, i) => ({ ref: `landing`, text: `${b.title} ${b.text}${i < 0 ? '' : ''}` })),
  ...l.sections.map((s) => ({ ref: 'landing', text: `${s.title} ${s.body}` })),
  ...l.faq.map((f) => ({ ref: 'landing', text: `${f.q} ${f.a}` })),
  ...l.trustSignals.map((t) => ({ ref: 'landing', text: t.text })),
];

export function claimFindings(args: { board: CreativeBoard; f1: F1Context; f3: F3Context; extraCorpus?: string[]; language?: string }): RawFinding[] {
  const { board, f1, f3 } = args;
  const corpus = corpusOf(f1, f3, args.extraCorpus);
  const corpusFolded = foldDiacritics(corpus);
  const avoid = f3.report.creativeBrief.claimsToAvoid.map((c) => ({ claim: c.claim, tokens: tokens(c.claim), reason: c.reason }));
  const out: RawFinding[] = [];
  const units: { ref: string; text: string; owner: 'copywriter' | 'landing' }[] = [
    ...board.variants.map((v) => ({ ref: v.id, text: `${v.headline} . ${v.body} . ${v.description ?? ''} . ${v.ctaText} . ${v.hashtags.join(' ')}`, owner: 'copywriter' as const })),
    ...(board.landing ? landingTexts(board.landing).map((u) => ({ ...u, owner: 'landing' as const })) : []),
  ];
  for (const u of units) {
    const ut = tokens(u.text);
    for (const a of avoid) {
      if (a.tokens.size < 2) continue;
      const hit = [...a.tokens].filter((t) => ut.has(t)).length / a.tokens.size;
      if (hit >= 0.75) out.push({ kind: 'unsupported_claim', severity: 'blocker', assetRef: u.ref, finding: `The text repeats a claim the strategy says must not be made: "${a.claim.slice(0, 120)}".`, evidence: a.reason.slice(0, 280), suggestedCorrection: 'Remove the claim or replace it with something the supplied material supports.', responsibleAgent: u.owner === 'landing' ? 'landing' : 'copywriter', source: 'deterministic' });
    }
    const figs = scrubFigures(u.text, corpus);
    if (figs.removed.length) out.push({ kind: 'unsupported_claim', severity: 'major', assetRef: u.ref, finding: `The text contains figure(s) that appear nowhere in the supplied material: ${figs.removed.slice(0, 3).join(', ')}.`, evidence: 'Invented prices, percentages or performance numbers must not appear in advertising.', suggestedCorrection: 'Delete the figure or replace it with a statement the material supports.', responsibleAgent: u.owner === 'landing' ? 'landing' : 'copywriter', source: 'deterministic' });
    for (const m of promiseMatches(u.text, args.language)) {
      const phrase = normalizeText(foldDiacritics(m.phrase));
      if (phrase && !corpusFolded.includes(phrase)) {
        out.push({ kind: 'unsupported_claim', severity: m.hard ? 'blocker' : 'major', assetRef: u.ref, finding: `"${m.phrase.slice(0, 60)}" is a promise or proof claim that the supplied material does not support.`, evidence: 'The phrase is not in the Product Manifest, the audit or the strategy.', suggestedCorrection: 'Remove it or state only what the material supports.', responsibleAgent: u.owner === 'landing' ? 'landing' : 'copywriter', source: 'deterministic' });
        break; // one finding per unit is enough to act on
      }
    }
  }
  for (const v of board.variants) {
    if (v.claims.some((c) => c.support === 'hypothesis') && /\b(is|are|will|guarantee)/i.test(v.body)) out.push({ kind: 'unsupported_claim', severity: 'minor', assetRef: v.id, finding: 'The copy contains a claim its author marked as an unsupported hypothesis.', evidence: v.claims.filter((c) => c.support === 'hypothesis').map((c) => c.text).join(' | ').slice(0, 280), suggestedCorrection: 'State it as a question or remove it.', responsibleAgent: 'copywriter', source: 'deterministic' });
  }
  if (board.landing) {
    for (const t of board.landing.trustSignals) if (t.evidence === 'hypothesis') out.push({ kind: 'unsupported_claim', severity: 'blocker', assetRef: 'landing', finding: `A trust signal has no support in the material: "${t.text.slice(0, 100)}".`, evidence: 'Trust signals must come from F1/F2/F3 or the user.', suggestedCorrection: 'Remove the trust signal.', responsibleAgent: 'landing', source: 'deterministic' });
  }
  return out;
}

/** Copy longer than its channel allows (platform maximum: major) or shows before truncation (recommendation: minor). */
export function channelFindings(board: CreativeBoard): RawFinding[] {
  const out: RawFinding[] = [];
  for (const v of board.variants) {
    for (const l of limitsFor(v.channel, v.placement)) {
      const value = l.field === 'hashtags' ? v.hashtags.length : (v[l.field] ?? '').length;
      if (value <= l.max) continue;
      const what = l.field === 'hashtags' ? `${value} hashtags` : `a ${l.field} of ${value} characters`;
      out.push({
        kind: 'channel_mismatch',
        severity: l.kind === 'platform_max' ? 'major' : 'minor',
        assetRef: v.id,
        finding: `The ${v.channel.replace('_', ' ')} ${v.placement.replace('_', ' ')} has ${what}; the channel ${l.kind === 'platform_max' ? 'allows at most' : 'works best with up to'} ${l.max}.`,
        evidence: l.note,
        suggestedCorrection: l.field === 'hashtags' ? `Keep at most ${l.max} hashtags.` : `Shorten the ${l.field} to ${l.max} characters or fewer.`,
        responsibleAgent: 'copywriter',
        source: 'deterministic',
      });
    }
  }
  return out;
}

export function consistencyFindings(board: CreativeBoard): RawFinding[] {
  const out: RawFinding[] = [];
  for (const v of board.variants) if (!v.ctaText.trim()) out.push({ kind: 'weak_cta', severity: 'major', assetRef: v.id, finding: 'The copy has no call to action text.', evidence: 'ctaText is empty.', suggestedCorrection: 'Add a clear call to action.', responsibleAgent: 'copywriter', source: 'deterministic' });
  const l = board.landing;
  if (l && board.variants.length) {
    const types = new Set(board.variants.map((v) => v.ctaType));
    if (!types.has(l.ctaObjective)) out.push({ kind: 'cta_mismatch', severity: 'major', assetRef: 'landing', finding: `The landing page asks visitors to "${l.ctaObjective}", but none of the ads does (${[...types].join(', ')}).`, evidence: 'A visitor who clicks an ad must find the same next step.', suggestedCorrection: `Align the landing call to action with the ads (${[...types][0]}).`, responsibleAgent: 'landing', source: 'deterministic' });
    else if (types.size > 1 || [...types][0] !== l.ctaObjective) out.push({ kind: 'cta_mismatch', severity: 'minor', assetRef: 'landing', finding: 'Some ads use a different call to action than the landing page.', evidence: `ads: ${[...types].join(', ')}; landing: ${l.ctaObjective}`, suggestedCorrection: 'Use one primary call to action across ads and landing page.', responsibleAgent: 'copywriter', source: 'deterministic' });
  }
  return out;
}

export function assetFindings(args: { board: CreativeBoard; hasLogo: boolean; hasPalette: boolean; imageGeneration: boolean }): RawFinding[] {
  const { board } = args;
  const out: RawFinding[] = [];
  const current = board.assets.filter((a) => a.kind === 'layout' && a.status !== 'superseded');
  for (const a of current) {
    const fmt = a.format ? CREATIVE_FORMATS[a.format] : undefined;
    if (!fmt || fmt.width !== a.width || fmt.height !== a.height) out.push({ kind: 'wrong_dimensions', severity: 'blocker', assetRef: a.id, finding: `The exported image is ${a.width}×${a.height}, not the ${fmt ? `${fmt.width}×${fmt.height}` : 'expected'} of format ${a.format}.`, evidence: 'Measured from the exported file.', suggestedCorrection: 'Render the layout again at the exact format size.', responsibleAgent: 'layout', source: 'deterministic' });
    for (const f of a.flags) {
      if (f === 'text_overflow') out.push({ kind: 'text_overflow', severity: 'major', assetRef: a.id, finding: 'The text does not fit its area at a readable size.', evidence: 'The fitting loop reached the minimum font size.', suggestedCorrection: 'Re-render with a smaller headline scale or shorter text.', responsibleAgent: 'layout', source: 'deterministic' });
      else if (f.startsWith('low_contrast')) out.push({ kind: 'low_contrast', severity: 'major', assetRef: a.id, finding: `Text contrast against the image is low (${f.replace('low_contrast_', '')}:1, needs 4.5:1).`, evidence: 'Measured from the image behind the text.', suggestedCorrection: 'Re-render with a stronger readability scrim.', responsibleAgent: 'layout', source: 'deterministic' });
      else if (f === 'logo_collides_with_text') out.push({ kind: 'logo', severity: 'major', assetRef: a.id, finding: 'The logo overlaps the text block.', evidence: 'Geometry check.', suggestedCorrection: 'Move the logo to another corner.', responsibleAgent: 'layout', source: 'deterministic' });
      else if (f === 'logo_unreadable') out.push({ kind: 'logo', severity: 'minor', assetRef: a.id, finding: 'The supplied logo could not be read, so it was not placed.', evidence: 'Image decoding failed.', suggestedCorrection: 'Upload the logo again as PNG.', responsibleAgent: 'layout', source: 'deterministic' });
      else if (f === 'cta_truncated') out.push({ kind: 'weak_cta', severity: 'minor', assetRef: a.id, finding: 'The call to action text was too long and was shortened.', evidence: 'Button width limit.', suggestedCorrection: 'Use a shorter call to action.', responsibleAgent: 'copywriter', source: 'deterministic' });
      else if (f.startsWith('upscaled_') && Number(f.replace('upscaled_', '').replace('x', '')) > 1.4) out.push({ kind: 'poor_crop', severity: 'minor', assetRef: a.id, finding: `The base image was enlarged ${f.replace('upscaled_', '')} to fill this format.`, evidence: 'The crop needs upscaling, which softens detail.', suggestedCorrection: 'Accept, or request a base image in a closer aspect ratio.', responsibleAgent: 'visual', source: 'deterministic' });
    }
    if (args.hasLogo && !a.flags.includes('logo_applied') && !a.flags.includes('logo_unreadable')) out.push({ kind: 'logo', severity: 'major', assetRef: a.id, finding: 'A logo was supplied but is not on this asset.', evidence: 'No logo_applied marker.', suggestedCorrection: 'Re-render with the logo.', responsibleAgent: 'layout', source: 'deterministic' });
  }
  for (const c of board.concepts) {
    if (!board.layouts.some((l) => l.conceptId === c.id)) out.push({ kind: 'layout_unavailable', severity: 'major', assetRef: c.id, finding: `Concept "${c.name}" has no exported layout.`, evidence: board.skippedLayouts.filter((s) => s.conceptId === c.id).map((s) => `${s.format}: ${s.reason}`).join(' | ').slice(0, 280) || 'Nothing was rendered.', suggestedCorrection: 'Render the layouts again.', responsibleAgent: 'layout', source: 'deterministic' });
    if (args.imageGeneration && board.assets.some((a) => a.conceptId === c.id && a.kind === 'image' && a.source === 'brand_gradient')) out.push({ kind: 'visual_irrelevant', severity: 'info', assetRef: null, finding: `Concept "${c.name}" uses a brand-colored background because its AI image could not be produced.`, evidence: 'The image request failed or was over budget.', suggestedCorrection: 'Retry the campaign or enable image regeneration.', responsibleAgent: 'visual', source: 'deterministic' });
  }
  if (!args.hasPalette) out.push({ kind: 'brand_color', severity: 'info', assetRef: null, finding: 'No brand colors were supplied, so a neutral palette was used.', evidence: 'F1 has no measured palette and no logo was uploaded.', suggestedCorrection: 'Upload a logo so brand colors can be derived.', responsibleAgent: 'layout', source: 'deterministic' });
  return out;
}

/** De-duplicates findings (same kind, asset and opening words). */
export function dedupe(list: RawFinding[]): RawFinding[] {
  const seen = new Set<string>();
  return list.filter((f) => {
    const k = `${f.kind}|${f.assetRef}|${f.finding.slice(0, 40)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
