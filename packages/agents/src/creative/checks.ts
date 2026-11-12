import { normalizeText } from '../discovery/input';
import { scrubFigures } from '../strategy/policy';
import type { F1Context } from '../audit/context';
import type { CreativeBoard } from './board';
import type { F3Context } from './context';
import { CREATIVE_FORMATS } from './formats';
import { foldDiacritics, promiseMatches } from './lexicon';
import { limitsFor } from './limits';
import type { ReviewFindingRecord, Rubric } from './schemas';

/**
 * Deterministic quality checks (the Quality Reviewer's first pass; no model call). They catch what code can prove:
 * claims the strategy forbade, money/percentage figures that exist in no source, promise words (guarantee, award, testimonial,
 * customer counts...) the supplied material does not support, invented web addresses and dates, text longer than a platform allows,
 * the same text copied across platforms, wrong dimensions, text that does not fit, unreadable contrast, a missing logo, pictures without
 * cleared rights and deliverables that do not exist. Judgment calls (tone, relevance, visual quality) are left to the model review.
 */
export type RawFinding = Omit<ReviewFindingRecord, 'id' | 'round' | 'status' | 'resolvedInRound'>;

/** Word tokens without punctuation: "results." and "results" are the same word. */
export const wordTokens = (s: string) => new Set(normalizeText(s).replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter((t) => t.length > 2));
const tokens = wordTokens;

export function corpusOf(f1: F1Context, f3: F3Context, extra: string[] = []): string {
  return normalizeText(`${JSON.stringify(f1.report)} ${JSON.stringify({ ...f3.report, evidence: undefined, creativeBrief: { ...f3.report.creativeBrief, claimsToAvoid: [] } })} ${extra.join(' ')}`);
}

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

const scriptText = (v: CreativeBoard['variants'][number]) => (v.videoScript ? [v.videoScript.hook, ...v.videoScript.scenes.flatMap((s) => [s.onScreenText, s.voiceover])].join(' . ') : '');

export function claimFindings(args: { board: CreativeBoard; f1: F1Context; f3: F3Context; extraCorpus?: string[]; language?: string; /** The websites the USER supplied (may be empty). When given, any other web or e-mail address in the copy is an invention. */ allowedUrls?: (string | null | undefined)[] }): RawFinding[] {
  const { board, f1, f3 } = args;
  const corpus = corpusOf(f1, f3, args.extraCorpus);
  const corpusFolded = foldDiacritics(corpus);
  const avoid = f3.report.creativeBrief.claimsToAvoid.map((c) => ({ claim: c.claim, tokens: tokens(c.claim), reason: c.reason }));
  const out: RawFinding[] = [];
  const push = (f: Omit<RawFinding, 'responsibleAgent' | 'source'>) => out.push({ ...f, responsibleAgent: 'copywriter', source: 'deterministic' });
  for (const v of board.variants) {
    const text = `${v.headline} . ${v.body} . ${v.description ?? ''} . ${v.ctaText} . ${v.hashtags.join(' ')} . ${scriptText(v)}`;
    const ut = tokens(text);
    for (const a of avoid) {
      if (a.tokens.size < 2) continue;
      const hit = [...a.tokens].filter((t) => ut.has(t)).length / a.tokens.size;
      if (hit >= 0.75) push({ kind: 'unsupported_claim', severity: 'blocker', assetRef: v.id, finding: `The text repeats a claim the strategy says must not be made: "${a.claim.slice(0, 120)}".`, evidence: a.reason.slice(0, 280), suggestedCorrection: 'Remove the claim or replace it with something the supplied material supports.' });
    }
    const figs = scrubFigures(text, corpus);
    if (figs.removed.length) push({ kind: 'unsupported_claim', severity: 'major', assetRef: v.id, finding: `The text contains figure(s) that appear nowhere in the supplied material: ${figs.removed.slice(0, 3).join(', ')}.`, evidence: 'Invented prices, percentages or performance numbers must not appear in advertising.', suggestedCorrection: 'Delete the figure or replace it with a statement the material supports.' });
    if (args.allowedUrls) {
      const bad = unsupportedDestinations(text, args.allowedUrls);
      if (bad.length) push({ kind: 'unsupported_claim', severity: 'blocker', assetRef: v.id, finding: `The text shows a web or e-mail address the project does not have: ${bad.slice(0, 3).join(', ')}.`, evidence: 'LaunchPilot never invents a destination. Only a website the user supplied may appear in a creative.', suggestedCorrection: 'Remove the address. Use a call to action that names an action ("Learn more", "Get started"), not a place.' });
    }
    const dates = unsupportedDates(text, corpus);
    if (dates.length) push({ kind: 'unsupported_claim', severity: 'major', assetRef: v.id, finding: `The text names a date that appears nowhere in the supplied material: ${dates.slice(0, 3).join(', ')}.`, evidence: 'Dates and deadlines can only come from the user; an invented one would be published as a promise.', suggestedCorrection: 'Remove the date or the deadline.' });
    for (const m of promiseMatches(text, args.language)) {
      const phrase = normalizeText(foldDiacritics(m.phrase));
      if (phrase && !corpusFolded.includes(phrase)) {
        push({ kind: 'unsupported_claim', severity: m.hard ? 'blocker' : 'major', assetRef: v.id, finding: `"${m.phrase.slice(0, 60)}" is a promise or proof claim that the supplied material does not support.`, evidence: 'The phrase is not in the business research or the strategy.', suggestedCorrection: 'Remove it or state only what the material supports.' });
        break; // one finding per unit is enough to act on
      }
    }
    if (v.claims.some((c) => c.support === 'hypothesis') && /\b(is|are|will|guarantee)/i.test(v.body)) push({ kind: 'unsupported_claim', severity: 'minor', assetRef: v.id, finding: 'The copy contains a claim its author marked as an unsupported hypothesis.', evidence: v.claims.filter((c) => c.support === 'hypothesis').map((c) => c.text).join(' | ').slice(0, 280), suggestedCorrection: 'State it as a question or remove it.' });
  }
  return out;
}

const PLACEMENT_LABEL: Record<string, string> = { social_post: 'post', web_ad: 'web banner ad', display_ad: 'display ad', billboard: 'billboard', flyer: 'flyer' };

/** Copy longer than its platform allows (platform maximum: major) or shows before truncation (recommendation: minor). */
export function channelFindings(board: CreativeBoard): RawFinding[] {
  const out: RawFinding[] = [];
  for (const v of board.variants) {
    for (const l of limitsFor(v.channel, v.placement)) {
      const value = l.field === 'hashtags' ? v.hashtags.length : l.field === 'post' ? [v.body, ...v.hashtags].join(' ').trim().length : (v[l.field] ?? '').length;
      if (value <= l.max) continue;
      const what = l.field === 'hashtags' ? `${value} hashtags` : l.field === 'post' ? `${value} characters in total` : `a ${l.field} of ${value} characters`;
      out.push({
        kind: 'channel_mismatch',
        severity: l.kind === 'platform_max' ? 'major' : 'minor',
        assetRef: v.id,
        finding: `The ${v.placement === 'social_post' ? v.channel : ''} ${PLACEMENT_LABEL[v.placement] ?? v.placement.replace('_', ' ')} has ${what}; ${l.kind === 'platform_max' ? 'the platform allows at most' : 'it works best with up to'} ${l.max}.`.replace(/\s+/g, ' ').trim(),
        evidence: l.note,
        suggestedCorrection: l.field === 'hashtags' ? `Keep at most ${l.max} hashtags.` : `Shorten the ${l.field === 'post' ? 'post' : l.field} to ${l.max} characters or fewer.`,
        responsibleAgent: 'copywriter',
        source: 'deterministic',
      });
    }
    if (v.placement === 'billboard' && v.headline.trim().split(/\s+/).length > 8) out.push({ kind: 'channel_mismatch', severity: 'minor', assetRef: v.id, finding: `The billboard headline has ${v.headline.trim().split(/\s+/).length} words; a billboard is read in a few seconds.`, evidence: 'Outdoor advertising works with about seven words.', suggestedCorrection: 'Cut the billboard headline to about seven words.', responsibleAgent: 'copywriter', source: 'deterministic' });
  }
  return out;
}

const GENERIC_VISUAL = /\b(stock photo|smiling (?:people|team|colleagues)|handshake|team (?:meeting|working)|laptop on (?:a |the )?desk|generic|lightbulb|rocket|globe|puzzle pieces?)\b/i;
const wordsOf = (s: string) => new Set(foldDiacritics(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
const jac = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((w) => b.has(w)).length;
  return inter / Math.max(1, a.size + b.size - inter);
};

/** Two concepts that say nearly the same thing, and a visual idea too thin or too much of a cliché to match a real picture to. */
export function conceptFindings(board: Pick<CreativeBoard, 'concepts'>): RawFinding[] {
  const out: RawFinding[] = [];
  const bag = board.concepts.map((c) => wordsOf(`${c.angle} ${c.keyMessage} ${c.visualIdea}`));
  for (let i = 0; i < board.concepts.length; i++) {
    for (let j = i + 1; j < board.concepts.length; j++) {
      const sim = jac(bag[i], bag[j]);
      if (sim >= 0.45) out.push({ kind: 'concept_overlap', severity: 'major', assetRef: board.concepts[j].id, finding: `Concepts "${board.concepts[i].name}" and "${board.concepts[j].name}" are nearly the same (${Math.round(sim * 100)}% shared wording).`, evidence: 'Word overlap of angle, key message and visual idea, measured.', suggestedCorrection: 'Give the later concept its own angle and key message.', responsibleAgent: 'copywriter', source: 'deterministic' });
    }
  }
  for (const c of board.concepts) {
    if (c.visualIdea.trim().length < 30 || GENERIC_VISUAL.test(c.visualIdea)) out.push({ kind: 'generic_concept', severity: 'minor', assetRef: c.id, finding: `The visual idea of "${c.name}" is too thin or too much of a cliché to choose a fitting picture.`, evidence: c.visualIdea.slice(0, 160), suggestedCorrection: 'Name a specific subject, setting and focal point that belong to this business.', responsibleAgent: 'copywriter', source: 'deterministic' });
  }
  return out;
}

const RUBRIC_KIND: Record<keyof Rubric, { kind: RawFinding['kind']; label: string; fix: string }> = {
  productAccuracy: { kind: 'strategy_mismatch', label: 'product accuracy', fix: 'Describe only what the business research supports; remove anything the material does not give.' },
  brandConsistency: { kind: 'brand_tone', label: 'brand consistency', fix: 'Bring the tone and wording in line with the brand direction of the creative brief.' },
  audienceRelevance: { kind: 'audience_mismatch', label: 'audience relevance', fix: 'Speak to the priority audience in its own terms and situation.' },
  objectiveAlignment: { kind: 'strategy_mismatch', label: 'alignment with the campaign objective', fix: 'Make every piece serve the objective and its call to action.' },
  originality: { kind: 'generic_concept', label: 'creative originality', fix: 'Replace interchangeable lines with an angle only this business can claim.' },
  crossChannelConsistency: { kind: 'inconsistent_messaging', label: 'cross-channel consistency', fix: 'Say the same thing, with the same next step, on every platform, ad and print piece.' },
  headlineStrength: { kind: 'weak_headline', label: 'headline strength', fix: 'Lead with a specific problem, a relevant question, a concrete benefit or a credible surprising observation (P1).' },
  specificity: { kind: 'generic_copy', label: 'specificity', fix: 'Replace abstract promises with evidenced facts and tangible situations of this business (P2, P6).' },
  clarity: { kind: 'unclear_copy', label: 'clarity', fix: 'Shorter sentences, concrete words, active voice, only the jargon the audience needs (P12).' },
  ctaQuality: { kind: 'weak_cta', label: 'call-to-action quality', fix: 'One clear next step that really exists, worded for each format (P11).' },
  platformFit: { kind: 'channel_mismatch', label: 'platform fit', fix: 'Write natively for each platform and format: length, opening, tone and structure.' },
  principleFit: { kind: 'principle_misuse', label: 'use of the copywriting principles', fix: 'Apply the few planned principles naturally; drop any that are forced or not supported by evidence.' },
};

/**
 * A rubric score of 2 or less becomes a finding unless a specific issue of that kind already explains it. Scores are clamped to 1-5 first.
 * The finding names no variant (the reviewer judged the whole), so it cannot be rewritten silently: it stays visible.
 */
export function scoreFindings(scores: Rubric | null | undefined, already: Pick<RawFinding, 'kind'>[]): RawFinding[] {
  if (!scores) return [];
  const out: RawFinding[] = [];
  for (const key of Object.keys(RUBRIC_KIND) as (keyof Rubric)[]) {
    // a criterion the review did not score (older rubrics) is not a weakness
    if (typeof scores[key] !== 'number') continue;
    const score = Math.max(1, Math.min(5, Math.round(Number(scores[key]) || 0)));
    const m = RUBRIC_KIND[key];
    if (score <= 2 && !already.some((a) => a.kind === m.kind)) out.push({ kind: m.kind, severity: 'major', assetRef: null, finding: `The reviewer scored ${m.label} ${score} of 5.`, evidence: 'Rubric score of the model review (1 unusable, 3 acceptable, 5 excellent).', suggestedCorrection: m.fix, responsibleAgent: 'copywriter', source: 'llm_text' });
  }
  return out;
}

/** A missing call to action, and the same text copied across platforms (each platform needs its own wording). */
export function consistencyFindings(board: CreativeBoard): RawFinding[] {
  const out: RawFinding[] = [];
  for (const v of board.variants) if (!v.ctaText.trim()) out.push({ kind: 'weak_cta', severity: 'major', assetRef: v.id, finding: 'The copy has no call to action text.', evidence: 'ctaText is empty.', suggestedCorrection: 'Add a clear call to action.', responsibleAgent: 'copywriter', source: 'deterministic' });
  const posts = board.variants.filter((v) => v.placement === 'social_post');
  for (const c of board.concepts) {
    const mine = posts.filter((p) => p.conceptId === c.id);
    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length; j++) {
        const a = mine[i];
        const b = mine[j];
        const sim = jac(wordsOf(a.body), wordsOf(b.body));
        if (sim >= 0.8) out.push({ kind: 'repetitive', severity: 'major', assetRef: b.id, finding: `The ${b.channel} post of "${c.name}" repeats the ${a.channel} post almost word for word (${Math.round(sim * 100)}% shared wording).`, evidence: 'Word overlap of the two post texts, measured.', suggestedCorrection: `Rewrite the ${b.channel} post for its own platform: another hook, length and tone.`, responsibleAgent: 'copywriter', source: 'deterministic' });
        else if (a.headline.trim().toLowerCase() === b.headline.trim().toLowerCase()) out.push({ kind: 'repetitive', severity: 'minor', assetRef: b.id, finding: `The ${b.channel} and ${a.channel} posts of "${c.name}" use the same hook.`, evidence: a.headline.slice(0, 120), suggestedCorrection: 'Give each platform its own hook.', responsibleAgent: 'copywriter', source: 'deterministic' });
      }
    }
  }
  return out;
}

/** Measured problems of the rendered creatives and missing deliverables. */
export function assetFindings(args: { board: CreativeBoard; hasLogo: boolean; hasPalette: boolean }): RawFinding[] {
  const { board } = args;
  const out: RawFinding[] = [];
  const current = board.assets.filter((a) => a.kind === 'layout' && a.status !== 'superseded');
  for (const a of current) {
    const fmt = a.format ? CREATIVE_FORMATS[a.format] : undefined;
    if (!fmt || fmt.width !== a.width || fmt.height !== a.height) out.push({ kind: 'wrong_dimensions', severity: 'blocker', assetRef: a.id, finding: `The exported image is ${a.width}×${a.height}, not the ${fmt ? `${fmt.width}×${fmt.height}` : 'expected'} of format ${a.format}.`, evidence: 'Measured from the exported file.', suggestedCorrection: 'Render the creative again at the exact format size.', responsibleAgent: 'layout', source: 'deterministic' });
    for (const f of a.flags) {
      if (f === 'text_overflow') out.push({ kind: 'text_overflow', severity: 'major', assetRef: a.id, finding: 'The text does not fit its area at a readable size.', evidence: 'The fitting loop reached the minimum font size.', suggestedCorrection: 'Render again without the supporting line or with a roomier template.', responsibleAgent: 'layout', source: 'deterministic' });
      else if (f.startsWith('low_contrast')) out.push({ kind: 'low_contrast', severity: 'major', assetRef: a.id, finding: `Text contrast is low (${f.replace('low_contrast_', '')}:1, needs 4.5:1).`, evidence: 'Measured from the image behind the text.', suggestedCorrection: 'Render again with another template of the collection.', responsibleAgent: 'layout', source: 'deterministic' });
      else if (f === 'logo_unreadable') out.push({ kind: 'logo', severity: 'minor', assetRef: a.id, finding: 'The supplied logo could not be read, so the business name was drawn instead.', evidence: 'Image decoding failed.', suggestedCorrection: 'Upload the logo again as PNG.', responsibleAgent: 'layout', source: 'deterministic' });
      else if (f === 'cta_truncated') out.push({ kind: 'weak_cta', severity: 'minor', assetRef: a.id, finding: 'The call to action text was too long and was shortened.', evidence: 'Button width limit.', suggestedCorrection: 'Use a shorter call to action.', responsibleAgent: 'copywriter', source: 'deterministic' });
    }
  }
  if (args.hasLogo && current.length && !current.some((a) => a.flags.includes('logo_applied'))) out.push({ kind: 'logo', severity: 'major', assetRef: null, finding: 'A logo was supplied, but no creative carries it.', evidence: 'No rendered creative has the logo_applied marker.', suggestedCorrection: 'Use templates of the collection that have a logo area.', responsibleAgent: 'layout', source: 'deterministic' });
  for (const c of board.concepts) {
    if (!board.layouts.some((l) => l.conceptId === c.id)) out.push({ kind: 'layout_unavailable', severity: 'major', assetRef: c.id, finding: `Concept "${c.name}" has no rendered creative.`, evidence: board.skippedLayouts.filter((s) => s.conceptId === c.id).map((s) => `${s.format}: ${s.reason}`).join(' | ').slice(0, 280) || 'Nothing was rendered.', suggestedCorrection: 'Render its creatives again.', responsibleAgent: 'layout', source: 'deterministic' });
  }
  if (!args.hasPalette) out.push({ kind: 'brand_color', severity: 'info', assetRef: null, finding: 'No brand colors were supplied, so the palette comes from the template collection.', evidence: 'No measured palette and no approved design palette.', suggestedCorrection: 'Approve a palette in the campaign design.', responsibleAgent: 'layout', source: 'deterministic' });
  return out;
}

/**
 * The template quality report as findings. A creative that can be rendered again is a Creative Designer problem; a picture that is not an
 * approved, rights-cleared source is a blocker the Visual Researcher owns (it is never repaired by pretending).
 */
export function templateFindings(args: { board: CreativeBoard }): RawFinding[] {
  const tq = args.board.templateQuality;
  if (!tq) return [];
  const out: RawFinding[] = [];
  for (const i of tq.issues) {
    const item = i.slotId ? args.board.selection?.items.find((s) => s.slotId === i.slotId) : undefined;
    const ref = i.assetId ?? item?.conceptId ?? null;
    if (i.kind === 'missing_render') out.push({ kind: 'layout_unavailable', severity: i.repairable ? 'major' : 'minor', assetRef: i.repairable ? (item?.conceptId ?? ref) : ref, finding: i.message.slice(0, 300), evidence: 'Template check: the planned creative has no valid file.', suggestedCorrection: i.repairable ? 'Render the creative again.' : 'Add an approved picture or choose a collection that can draw this format.', responsibleAgent: 'layout', source: 'deterministic' });
    else if (i.kind === 'unreadable_file' || i.kind === 'wrong_dimensions') out.push({ kind: 'wrong_dimensions', severity: 'blocker', assetRef: i.assetId, finding: i.message.slice(0, 300), evidence: 'Template check: the stored file was opened and measured.', suggestedCorrection: 'Render the creative again.', responsibleAgent: 'layout', source: 'deterministic' });
    else if (i.kind === 'ineligible_source') out.push({ kind: 'source_rights', severity: 'blocker', assetRef: i.assetId, finding: i.message.slice(0, 300), evidence: 'Template check: every picture must be an approved, rights-cleared source.', suggestedCorrection: 'Remove the picture from the creative or clear its rights in the image library.', responsibleAgent: 'visual', source: 'deterministic' });
    else if (i.kind === 'duplicate_output') out.push({ kind: 'repetitive', severity: 'major', assetRef: i.assetId, finding: i.message.slice(0, 300), evidence: 'Template check: byte comparison of the rendered files.', suggestedCorrection: 'Render it again with another template of the collection.', responsibleAgent: 'layout', source: 'deterministic' });
    else if (i.kind === 'missing_lineage' || i.kind === 'design_mismatch') out.push({ kind: 'other', severity: 'major', assetRef: i.assetId, finding: i.message.slice(0, 300), evidence: 'Template check: lineage and design.', suggestedCorrection: 'Render the creative again with its source and template recorded.', responsibleAgent: 'layout', source: 'deterministic' });
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
