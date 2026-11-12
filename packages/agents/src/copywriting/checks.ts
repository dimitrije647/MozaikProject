import type { RawFinding } from '../creative/checks';
import type { CopyVariantRecord } from '../creative/schemas';
import type { CopyPlan } from './plan';
import { PRINCIPLES, isPrincipleId } from './principles';

/**
 * Deterministic COPY-CRAFT checks of the Quality Reviewer (no model call). They catch what code can see in the words themselves: generic
 * slogans and empty superlatives, artificial urgency without evidence, principles the plan excluded, repetitive openings, the same call to
 * action everywhere, sentences too long for the audience, unnecessary jargon, an overloaded billboard and a forced "P.S.". Judgment (is the
 * headline strong, is the angle specific) stays with the model review. English and German phrase lists; other languages fall back to the
 * structural checks (repetition, CTA, sentence length, billboard).
 */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const GENERIC: RegExp[] = [
  /\bworld[- ]class\b/, /\bindustry[- ]leading\b/, /\bbest[- ]in[- ]class\b/, /\bcutting[- ]edge\b/, /\brevolutionar(y|ise|ize)\b/, /\bgame[- ]?chang(er|ing)\b/,
  /\bnext[- ]level\b/, /\binnovative solutions?\b/, /\bone[- ]stop[- ]shop\b/, /\bunlock (your|the) (full )?potential\b/, /\bunleash\b/, /\bseamless(ly)?\b/,
  /\bin today'?s (fast[- ]paced|digital|ever[- ]changing)\b/, /\bthe (world'?s|very) best\b/, /\bnumber one\b/, /\bsecond to none\b/, /\bdream big\b/,
  /\bbest version of yourself\b/, /\bsky'?s the limit\b/, /\bpassion for excellence\b/, /\bwe are (your|the) (trusted )?partner\b/, /\byour (trusted )?partner for\b/,
  /\binnovative losungen?\b/, /\bmassgeschneiderte losungen?\b/, /\bweltweit fuhrend\w*\b/, /\bbranchenfuhrend\w*\b/, /\berstklassig\w*\b/, /\brevolutionar\w*\b/, /\bihr (zuverlassiger )?partner fur\b/,
];

const URGENCY: RegExp[] = [
  /\blimited time\b/, /\bonly today\b/, /\btoday only\b/, /\blast chance\b/, /\bhurry\b/, /\bact (now|fast)\b/, /\bdon'?t miss out\b/, /\bwhile (supplies|stocks?) last\b/,
  /\bonly \d+ (seats?|spots?|places?|left)\b/, /\bends (soon|tonight|today)\b/, /\bselling fast\b/, /\b(spots?|seats?) are filling\b/, /\bbefore it'?s too late\b/,
  /\bnur heute\b/, /\bletzte chance\b/, /\bjetzt zugreifen\b/, /\bnur noch \d+\b/, /\bbegrenzte? (platze|anzahl|zeit)\b/, /\bsolange der vorrat\b/,
];

const JARGON = /\b(synerg\w*|leverag\w*|paradigm\w*|holistic\w*|disrupt\w*|empower\w*|ecosystem\w*|best practices?|value[- ]add\w*|scalab\w*|robust)\b/g;

const sentences = (s: string) => s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.split(/\s+/).length > 2);
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const textOf = (v: CopyVariantRecord) => `${v.headline}\n${v.body}${v.description && v.description !== v.body ? `\n${v.description}` : ''}`;
const where = (v: CopyVariantRecord) => (v.placement === 'social_post' ? `${v.channel} post` : v.placement.replace('_', ' '));

const f = (kind: RawFinding['kind'], severity: RawFinding['severity'], v: CopyVariantRecord | null, finding: string, evidence: string, suggestedCorrection: string): RawFinding => ({
  kind,
  severity,
  assetRef: v?.id ?? null,
  finding: finding.slice(0, 300),
  evidence: evidence.slice(0, 300),
  suggestedCorrection: suggestedCorrection.slice(0, 300),
  responsibleAgent: 'copywriter',
  source: 'deterministic',
});

export interface CraftInput {
  variants: CopyVariantRecord[];
  plan: CopyPlan | null;
  /** the research and strategy text: a phrase that is the business's own wording (a product name...) is not flagged */
  corpus?: string;
}

export function copyCraftFindings({ variants, plan, corpus = '' }: CraftInput): RawFinding[] {
  const out: RawFinding[] = [];
  const own = fold(corpus);
  const forbidden = (plan?.voice.forbiddenExpressions ?? []).map(fold).filter((x) => x.length > 2);
  const excluded = new Map((plan?.excluded ?? []).map((e) => [e.id, e.reason]));
  const expert = plan?.voice.technicalDepth === 'expert';

  for (const v of variants) {
    const t = fold(textOf(v));
    // 1. generic slogans, empty superlatives and the voice's forbidden expressions
    const generic = GENERIC.map((re) => t.match(re)?.[0]).filter((m): m is string => !!m && !own.includes(m));
    const banned = forbidden.filter((x) => t.includes(x) && !own.includes(x));
    const hits = [...new Set([...generic, ...banned])];
    if (hits.length) out.push(f('generic_copy', v.placement === 'social_post' ? 'minor' : 'major', v, `The ${where(v)} uses generic or forbidden wording: "${hits.slice(0, 3).join('", "')}".`, 'Phrase list of the copywriting checks and the brand voice profile.', 'Replace it with a specific, evidenced statement about this business (P2) or a tangible situation (P6).'));
    // 2. artificial urgency without evidence
    const urgent = URGENCY.map((re) => t.match(re)?.[0]).filter((m): m is string => !!m);
    if (urgent.length && !plan?.evidence.urgency) out.push(f('false_urgency', 'major', v, `The ${where(v)} creates urgency ("${urgent[0]}") that no deadline, season, capacity or offer in the material supports.`, 'The copywriting plan has no verified urgency (P8 excluded).', 'Remove the pressure; give the real value and a clear next step instead.'));
    // 3. principles the plan excluded
    for (const p of (v.principles ?? []).filter(isPrincipleId)) {
      if (excluded.has(p)) out.push(f('principle_misuse', p === 'P13' ? 'minor' : 'major', v, `The ${where(v)} applies ${p} (${PRINCIPLES[p].name}) although the plan excludes it.`, excluded.get(p)!, p === 'P5' ? 'Remove the admitted limitation unless the research documents it.' : p === 'P8' ? 'Remove the urgency.' : 'Remove the joke; keep the message credible.'));
    }
    // 4. clarity: sentences too long for the audience, jargon
    const longest = Math.max(0, ...sentences(v.body).map((s) => words(s).length));
    if (longest > (expert ? 40 : 30)) out.push(f('unclear_copy', 'minor', v, `The ${where(v)} has a sentence of ${longest} words.`, `Longest sentence in the text; the limit for this audience is ${expert ? 40 : 30} words.`, 'Split it into short, active sentences (P12).'));
    const jargon = [...new Set(t.match(JARGON) ?? [])];
    if (jargon.length >= (expert ? 3 : 2)) out.push(f('unclear_copy', 'minor', v, `The ${where(v)} leans on jargon: ${jargon.slice(0, 4).join(', ')}.`, 'Buzzword list of the copywriting checks.', 'Say concretely what happens for the reader instead.'));
    // 5. billboard: one idea, very few words, no body
    if (v.placement === 'billboard') {
      const n = words(v.headline).length;
      if (n > 8) out.push(f('channel_mismatch', 'major', v, `The billboard headline has ${n} words; a billboard is read in a few seconds.`, 'Billboards carry one idea in about seven words.', 'Cut it to one strong idea of at most seven words.'));
      if (v.body.trim()) out.push(f('channel_mismatch', 'minor', v, 'The billboard has body text that cannot be read from a distance.', 'A billboard shows its headline (and at most a short call to action).', 'Leave the body empty.'));
    }
  }

  // 6. a forced "P.S.": more than one post, or in a format with no room for it
  const ps = variants.filter((v) => /(^|\s)p\.\s?s\./i.test(v.body));
  const psMisplaced = ps.filter((v) => ['billboard', 'display_ad', 'web_ad'].includes(v.placement) || v.channel === 'x');
  for (const v of psMisplaced) out.push(f('channel_mismatch', 'minor', v, `The ${where(v)} has a "P.S.", which this format has no room for.`, 'P10 is a strong final line; a P.S. only fits longer formats.', 'Replace it with a strong final line or remove it.'));
  if (ps.length - psMisplaced.length > 1) out.push(f('repetitive', 'minor', ps[1], `${ps.length} pieces end with a "P.S.": it is forced into the campaign rather than chosen.`, 'P10 is optional and should not appear in every message.', 'Keep a P.S. in at most one piece; end the others with a strong final line.'));

  // 7. repetitive openings across the social posts
  const posts = variants.filter((v) => v.placement === 'social_post');
  const openings = new Map<string, CopyVariantRecord[]>();
  for (const v of posts) {
    const key = words(fold(v.body).replace(/[^\p{L}\p{N}\s]+/gu, ' ')).slice(0, 3).join(' ');
    if (key.split(' ').length === 3) openings.set(key, [...(openings.get(key) ?? []), v]);
  }
  for (const [key, list] of openings) if (list.length >= 3) out.push(f('repetitive', 'minor', list[2], `${list.length} posts open with the same words ("${key}…").`, `Posts ${list.map((v) => v.id).join(', ')}.`, 'Give each platform its own opening that fits how people read there.'));
  const hookStarts = new Map<string, number>();
  for (const v of posts) {
    const w = words(fold(v.headline))[0];
    if (w && w.length > 2) hookStarts.set(w, (hookStarts.get(w) ?? 0) + 1);
  }
  for (const [w, n] of hookStarts) if (n >= Math.max(3, Math.ceil(posts.length * 0.6))) out.push(f('repetitive', 'minor', null, `${n} of ${posts.length} hooks start with "${w}".`, 'First word of every post hook.', 'Vary the hooks: a question, a concrete situation, a sharp contrast, a useful observation.'));

  // 8. the same call to action on everything, with no strategic reason
  const ctas = variants.map((v) => fold(v.ctaText).trim()).filter(Boolean);
  if (ctas.length >= 6 && new Set(ctas).size === 1) out.push(f('weak_cta', 'minor', null, `Every piece of copy uses the same call to action ("${variants[0].ctaText}").`, `${ctas.length} pieces, one CTA text.`, 'Keep ONE primary action, but word it for each format (a billboard, a LinkedIn post and a flyer are read differently).'));

  return out;
}
