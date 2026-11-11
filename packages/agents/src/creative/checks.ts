import { normalizeText } from '../discovery/input';
import { scrubFigures } from '../strategy/policy';
import type { F1Context } from '../audit/context';
import type { CreativeBoard } from './board';
import type { F3Context } from './context';
import { CREATIVE_FORMATS } from './formats';
import { foldDiacritics, promiseMatches } from './lexicon';
import { conceptResultFromVariations } from './image-results';
import { limitsFor } from './limits';
import type { LandingContent, ReviewFindingRecord, Rubric } from './schemas';

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

// ---- invented destinations and dates ---------------------------------------------------------------------------------------------------------
// A project may have no website at all. Then no creative may show a web address, e-mail address or a calendar date, because the only source of
// such a fact is the user: a model-written "jigjoy.com" or "until 31 May" is an invention, not a proposal.

const TLDS = 'com|net|org|io|ai|app|co|rs|me|dev|shop|store|online|site|xyz|info|biz|eu|de|hr|ba|ch|at|fr|es|it|uk|us|tv|club|studio|agency|tech|cloud|page|link|ly';
const URL_RE = new RegExp(`(?:https?:\\/\\/[^\\s)>\\]]+|\\bwww\\.[a-z0-9-]+\\.[a-z]{2,}[^\\s)>\\]]*|[a-z0-9._%+-]+@[a-z0-9-]+\\.[a-z.]{2,}|\\b[a-z0-9][a-z0-9-]{1,}\\.(?:${TLDS})\\b(?:\\/[^\\s)>\\]]*)?)`, 'gi');

const hostOf = (raw: string): string | null => {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
};

/** Web or e-mail addresses in the text that are not (on) a website the user supplied. */
export function unsupportedDestinations(text: string, allowedUrls: (string | null | undefined)[]): string[] {
  const allowed = new Set(allowedUrls.map((u) => (u ? hostOf(u) : null)).filter((h): h is string => !!h));
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const found = m[0].replace(/[.,;:!?]+$/, '');
    const host = found.includes('@') ? found.split('@')[1]!.toLowerCase() : hostOf(found);
    if (!host) continue;
    if ([...allowed].some((a) => host === a || host.endsWith(`.${a}`))) continue;
    out.push(found);
  }
  return [...new Set(out)];
}

const MONTHS = [
  'january|february|march|april|may|june|july|august|september|october|november|december',
  'jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec',
  'januar|februar|mart|maj|juni|juli|avgust|septembar|oktobar|novembar|decembar|siječnja|veljače|ožujka|travnja|svibnja|lipnja|srpnja|kolovoza|rujna|listopada|studenoga|prosinca|januara|februara|marta|aprila|maja|juna|jula|avgusta|septembra|oktobra|novembra|decembra',
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|gennaio|febbraio|aprile|maggio|giugno|luglio|settembre|ottobre|dicembre|märz|dezember',
].join('|');
const DATE_RE = new RegExp(`(?:\\b\\d{1,2}[./-]\\d{1,2}[./-](?:\\d{4}|\\d{2})\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\.?\\s+(?:(?:of|de|del)\\s+)?(?:${MONTHS})\\b|\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b)`, 'giu');

/** Calendar dates in the text that appear in no supplied material. */
export function unsupportedDates(text: string, corpus: string): string[] {
  const squash = (s: string) => foldDiacritics(s).replace(/\s+/g, '');
  const known = squash(corpus);
  const out: string[] = [];
  for (const m of text.matchAll(DATE_RE)) if (!known.includes(squash(m[0]))) out.push(m[0]);
  return [...new Set(out)];
}

export function claimFindings(args: { board: CreativeBoard; f1: F1Context; f3: F3Context; extraCorpus?: string[]; language?: string; /** The websites the USER supplied (may be empty). When given, any other web or e-mail address in the copy is an invention. */ allowedUrls?: (string | null | undefined)[] }): RawFinding[] {
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
    if (args.allowedUrls) {
      const bad = unsupportedDestinations(u.text, args.allowedUrls);
      if (bad.length) out.push({ kind: 'unsupported_claim', severity: 'blocker', assetRef: u.ref, finding: `The text shows a web or e-mail address the project does not have: ${bad.slice(0, 3).join(', ')}.`, evidence: 'LaunchPilot never invents a destination. Only a website the user supplied may appear in a creative.', suggestedCorrection: 'Remove the address. Use a call to action that names an action ("Learn more", "Get started"), not a place.', responsibleAgent: u.owner === 'landing' ? 'landing' : 'copywriter', source: 'deterministic' });
    }
    const dates = unsupportedDates(u.text, corpus);
    if (dates.length) out.push({ kind: 'unsupported_claim', severity: 'major', assetRef: u.ref, finding: `The text names a date that appears nowhere in the supplied material: ${dates.slice(0, 3).join(', ')}.`, evidence: 'Dates and deadlines can only come from the user; an invented one would be published as a promise.', suggestedCorrection: 'Remove the date or the deadline.', responsibleAgent: u.owner === 'landing' ? 'landing' : 'copywriter', source: 'deterministic' });
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

const GENERIC_VISUAL = /\b(stock photo|smiling (?:people|team|colleagues)|handshake|team (?:meeting|working)|laptop on (?:a |the )?desk|generic|lightbulb|rocket|globe|puzzle pieces?)\b/i;
const wordsOf = (s: string) => new Set(foldDiacritics(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
const jac = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((w) => b.has(w)).length;
  return inter / Math.max(1, a.size + b.size - inter);
};

/**
 * Deterministic concept checks (no model): two concepts that say nearly the same thing, and a visual idea too thin or too much of a cliché
 * to give an image anything concrete to show. They need no call and run before the images are paid for.
 */
export function conceptFindings(board: Pick<CreativeBoard, 'concepts'>): RawFinding[] {
  const out: RawFinding[] = [];
  const bag = board.concepts.map((c) => wordsOf(`${c.angle} ${c.keyMessage} ${c.visualIdea}`));
  for (let i = 0; i < board.concepts.length; i++) {
    for (let j = i + 1; j < board.concepts.length; j++) {
      const sim = jac(bag[i], bag[j]);
      if (sim >= 0.45) out.push({ kind: 'concept_overlap', severity: 'major', assetRef: board.concepts[j].id, finding: `Concepts "${board.concepts[i].name}" and "${board.concepts[j].name}" are nearly the same (${Math.round(sim * 100)}% shared wording).`, evidence: 'Word overlap of angle, key message and visual idea, measured.', suggestedCorrection: 'Give the later concept its own angle, key message and picture.', responsibleAgent: 'copywriter', source: 'deterministic' });
    }
  }
  for (const c of board.concepts) {
    if (c.visualIdea.trim().length < 30 || GENERIC_VISUAL.test(c.visualIdea)) out.push({ kind: 'generic_concept', severity: 'minor', assetRef: c.id, finding: `The visual idea of "${c.name}" is too thin or too much of a cliché to direct an image.`, evidence: c.visualIdea.slice(0, 160), suggestedCorrection: 'Name a specific subject, setting and focal point that belong to this business.', responsibleAgent: 'copywriter', source: 'deterministic' });
  }
  return out;
}

const RUBRIC_KIND: Record<keyof Rubric, { kind: RawFinding['kind']; owner: RawFinding['responsibleAgent']; label: string; fix: string }> = {
  productAccuracy: { kind: 'strategy_mismatch', owner: 'copywriter', label: 'product accuracy', fix: 'Describe only what the product report supports; remove anything the material does not give.' },
  brandConsistency: { kind: 'brand_tone', owner: 'copywriter', label: 'brand consistency', fix: 'Bring the tone and wording in line with the brand direction of the creative brief.' },
  audienceRelevance: { kind: 'audience_mismatch', owner: 'copywriter', label: 'audience relevance', fix: 'Speak to the priority audience in its own terms and situation.' },
  objectiveAlignment: { kind: 'strategy_mismatch', owner: 'copywriter', label: 'alignment with the campaign objective', fix: 'Make every variant serve the objective and its call to action.' },
  originality: { kind: 'generic_concept', owner: 'copywriter', label: 'creative originality', fix: 'Replace interchangeable lines with an angle only this business can claim.' },
  crossChannelConsistency: { kind: 'inconsistent_messaging', owner: 'landing', label: 'cross-channel consistency', fix: 'Say the same thing, with the same next step, in the ads and on the landing page.' },
};

/**
 * A rubric score of 2 or less becomes a finding unless a specific issue of that kind already explains it. Scores are clamped to 1-5 first.
 * The finding names no variant (the reviewer judged the whole), so the Fixer cannot rewrite it silently: it stays visible as unresolved.
 */
export function scoreFindings(scores: Rubric | null | undefined, already: Pick<RawFinding, 'kind'>[]): RawFinding[] {
  if (!scores) return [];
  const out: RawFinding[] = [];
  for (const key of Object.keys(RUBRIC_KIND) as (keyof Rubric)[]) {
    const score = Math.max(1, Math.min(5, Math.round(Number(scores[key]) || 0)));
    const m = RUBRIC_KIND[key];
    if (score <= 2 && !already.some((a) => a.kind === m.kind)) out.push({ kind: m.kind, severity: 'major', assetRef: null, finding: `The reviewer scored ${m.label} ${score} of 5.`, evidence: 'Rubric score of the model review (1 unusable, 3 acceptable, 5 excellent).', suggestedCorrection: m.fix, responsibleAgent: m.owner, source: 'llm_text' });
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
    // several images per concept: every planned image that did not become an AI image is reported (one finding per concept)
    const planned = board.variations.filter((v) => v.conceptId === c.id);
    const missing = planned.filter((v) => v.status !== 'generated');
    if (args.imageGeneration && planned.length && missing.length && planned.some((v) => v.status === 'generated')) {
      const failed = missing.filter((v) => v.status === 'failed').length;
      const blocked = missing.filter((v) => v.status === 'blocked_by_budget').length;
      out.push({ kind: 'visual_irrelevant', severity: failed ? 'major' : 'minor', assetRef: c.id, finding: `Concept "${c.name}": ${missing.length} of ${planned.length} planned AI images are missing (${failed} failed, ${blocked} stopped by the budget, ${missing.length - failed - blocked} not requested).`, evidence: (missing.find((v) => v.status === 'failed') ?? missing[0]).explanation ?? 'See the image list.', suggestedCorrection: 'Generate the missing images with an image-only continuation (it reuses the strategy, copy and the images that succeeded).', responsibleAgent: 'visual', source: 'deterministic' });
    }
    if (args.imageGeneration && board.assets.some((a) => a.conceptId === c.id && a.kind === 'image' && a.source === 'brand_gradient' && a.status !== 'superseded')) {
      const res = board.imageResults.find((r) => r.conceptId === c.id) ?? (board.variations.length ? conceptResultFromVariations(c, board.variations, null, '') : undefined);
      // an image that FAILED is a real defect of the campaign; a budget the user chose is a limitation (minor), not a failure
      const failed = !res || res.outcome === 'failed';
      out.push({ kind: 'visual_irrelevant', severity: failed ? 'major' : 'minor', assetRef: c.id, finding: `Concept "${c.name}" has no AI image: its layouts use a brand-colored background.`, evidence: res?.explanation ?? 'The image request failed or was over budget.', suggestedCorrection: res?.stage === 'budget' ? 'Raise the image limit for the next run if every concept should have its own picture.' : 'Fix the cause named above and run the creative round again (regeneration is off unless you enable it).', responsibleAgent: 'visual', source: 'deterministic' });
    }
  }
  if (!args.hasPalette) out.push({ kind: 'brand_color', severity: 'info', assetRef: null, finding: 'No brand colors were supplied, so a neutral palette was used.', evidence: 'F1 has no measured palette and no logo was uploaded.', suggestedCorrection: 'Upload a logo so brand colors can be derived.', responsibleAgent: 'layout', source: 'deterministic' });
  return out;
}

/**
 * Hybrid Production: the Template Quality Reviewer's report as findings. A creative that could be rendered again is a layout problem
 * (the Fixer renders it again); one whose ORIGINAL image does not exist cannot be repaired by a layout and is reported against the
 * Visual Creator, so it stays visible instead of being "fixed" by pretending.
 */
export function templateFindings(args: { board: CreativeBoard }): RawFinding[] {
  const tq = args.board.templateQuality;
  if (!tq) return [];
  const out: RawFinding[] = [];
  for (const i of tq.issues) {
    const item = i.slotId ? args.board.selection?.items.find((s) => s.slotId === i.slotId) : undefined;
    const conceptRef = item?.conceptId ?? null;
    if (i.kind === 'missing_render') {
      out.push(
        i.repairable
          ? { kind: 'layout_unavailable', severity: 'major', assetRef: conceptRef ?? i.assetId, finding: i.message.slice(0, 300), evidence: 'Template Quality Reviewer: the planned creative has no valid file.', suggestedCorrection: 'Render the template creative again.', responsibleAgent: 'layout', source: 'deterministic' }
          : { kind: 'visual_irrelevant', severity: 'major', assetRef: conceptRef ?? i.assetId, finding: i.message.slice(0, 300), evidence: 'Template Quality Reviewer: the original image this creative needs does not exist.', suggestedCorrection: 'Generate the missing originals with an image-only continuation; the template creatives are then rendered without running the strategy again.', responsibleAgent: 'visual', source: 'deterministic' },
      );
    } else if (i.kind === 'unreadable_file') out.push({ kind: 'wrong_dimensions', severity: 'blocker', assetRef: i.assetId, finding: i.message.slice(0, 300), evidence: 'Template Quality Reviewer opened the stored file.', suggestedCorrection: 'Render the template creative again.', responsibleAgent: 'layout', source: 'deterministic' });
    else if (i.kind === 'duplicate_output' || i.kind === 'missing_lineage') out.push({ kind: 'other', severity: 'major', assetRef: i.assetId, finding: i.message.slice(0, 300), evidence: 'Template Quality Reviewer: lineage / uniqueness check.', suggestedCorrection: 'Render the template creative again with its source and template recorded.', responsibleAgent: 'layout', source: 'deterministic' });
  }
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
