import { z } from 'zod';
import { limitsFor, type TextLimit } from '../creative/limits';
import type { CopyDirection } from './direction';
import { COMBINATIONS, COPY_PURPOSES, PRINCIPLE_IDS, PRINCIPLES, type CopyPurpose, type PrincipleId } from './principles';
import { BrandVoice } from './voice';

/**
 * THE COPYWRITING PLAN of one campaign (deterministic, no model call). It turns the strategist's copy direction, the campaign objective, the
 * Brand Voice Profile and the evidence into: the campaign purpose, the principle combination, the principles that are EXCLUDED and why
 * (no fake urgency, no invented limitation, no humor where it does not belong), and per placement (each platform, ads, print) the few principles
 * that fit, the length budget from the maintained platform limits (limits.ts, never hard-coded in prompts) and what the format needs.
 * The Content Writer applies it, the Quality Reviewer checks against it, and the package stores it for debugging.
 */
const Pid = z.enum(PRINCIPLE_IDS);

export const PlacementPlan = z.object({
  /** "social:x", "social:linkedin", ..., "web_ad", "display_ad", "billboard", "flyer" */
  key: z.string(),
  label: z.string(),
  principles: z.array(Pid),
  limits: z.string(),
  guidance: z.string(),
});
export type PlacementPlan = z.infer<typeof PlacementPlan>;

export const CopyPlan = z.object({
  version: z.literal(1),
  purpose: z.enum(COPY_PURPOSES),
  purposeBasis: z.enum(['strategist', 'objective', 'default']),
  goal: z.string(),
  primary: z.array(Pid),
  optional: z.array(Pid),
  excluded: z.array(z.object({ id: Pid, reason: z.string() })),
  placements: z.array(PlacementPlan),
  evidence: z.object({ urgency: z.string().nullable(), limitation: z.string().nullable(), proofPoints: z.array(z.string()) }),
  voice: BrandVoice,
  notes: z.array(z.string()),
});
export type CopyPlan = z.infer<typeof CopyPlan>;

interface PlacementSpec {
  key: string;
  label: string;
  channel: string;
  placement: string;
  /** the principles that suit the format, in order of fit */
  affinity: PrincipleId[];
  max: number;
  guidance: string;
}

const SOCIAL: Record<string, PlacementSpec> = {
  x: { key: 'social:x', label: 'X post', channel: 'x', placement: 'social_post', affinity: ['P1', 'P9', 'P6', 'P12', 'P13'], max: 3, guidance: 'A concise hook and ONE specific insight or observation; self-contained; hashtags only when useful.' },
  linkedin: { key: 'social:linkedin', label: 'LinkedIn post', channel: 'linkedin', placement: 'social_post', affinity: ['P3', 'P9', 'P4', 'P6', 'P7', 'P12', 'P10'], max: 4, guidance: 'Professional relevance, a practical insight or outcome, credible authority; may end with a genuine discussion question. Not a press release; no recycled hooks.' },
  instagram: { key: 'social:instagram', label: 'Instagram post', channel: 'instagram', placement: 'social_post', affinity: ['P1', 'P6', 'P7', 'P11', 'P13'], max: 4, guidance: 'A strong first line, a visual narrative that matches the rendered picture, an emotional or practical benefit, a concise caption and one clear call to action.' },
  facebook: { key: 'social:facebook', label: 'Facebook post', channel: 'facebook', placement: 'social_post', affinity: ['P3', 'P6', 'P4', 'P12', 'P11'], max: 4, guidance: 'Accessible language, context, a relatable situation, useful information and natural engagement; no clickbait.' },
  tiktok: { key: 'social:tiktok', label: 'TikTok cover + video concept', channel: 'tiktok', placement: 'social_post', affinity: ['P1', 'P6', 'P3', 'P11', 'P13'], max: 4, guidance: 'The hook is the cover-image text and the first spoken line (the first two seconds); the video concept has short shots with on-screen text; the caption is short. It is a script to film: never say a video was made.' },
};

const OTHER: PlacementSpec[] = [
  { key: 'web_ad', label: 'Web banner ad', channel: 'google_search', placement: 'web_ad', affinity: ['P1', 'P4', 'P2', 'P11'], max: 3, guidance: 'Attention, ONE benefit, ONE action, minimal clutter.' },
  { key: 'display_ad', label: 'Display ad', channel: 'google_search', placement: 'display_ad', affinity: ['P1', 'P2', 'P4', 'P11'], max: 3, guidance: 'Attention, ONE benefit, ONE action, minimal clutter.' },
  { key: 'billboard', label: 'Billboard', channel: 'organic_content', placement: 'billboard', affinity: ['P1', 'P7', 'P12', 'P11'], max: 2, guidance: 'ONE strong idea in very few words, understood at a glance; no body text (the design places the brand); a call to action only when it is short.' },
  { key: 'flyer', label: 'Flyer', channel: 'organic_content', placement: 'flyer', affinity: ['P1', 'P4', 'P6', 'P2', 'P11', 'P10', 'P5'], max: 5, guidance: 'A headline, the clear benefit, a short supporting explanation, relevant evidence and one call to action.' },
];

const PURPOSE_WORDS: [CopyPurpose, RegExp][] = [
  ['conversion', /\b(lead|leads|sale|sales|sell|book|booking|bookings|sign.?ups?|register|registrations?|enrol\w*|buy|purchase|conversion\w*|enquir\w*|inquir\w*|appointments?|anfrage\w*|termin\w*|buchung\w*|verkauf\w*|anmeldung\w*|prodaj\w*|prijav\w*)\b/i],
  ['leadership', /\b(thought.?leader\w*|leadership|authority|expert\w*|position\w* as|reputation|fuhrung\w*|kompetenz\w*|ekspert\w*)\b/i],
  ['trust', /\b(trust|credib\w*|confidence|vertrauen|glaubwurd\w*|poverenj\w*)\b/i],
  ['engagement', /\b(educat\w*|inform\w*|engag\w*|communit\w*|explain\w*|guide|tips|wissen|aufklar\w*|edukac\w*)\b/i],
  ['product', /\b(product|feature|new service|launch of|range|collection|produkt\w*|proizvod\w*)\b/i],
  ['awareness', /\b(awareness|visib\w*|known|reach|introduc\w*|launch|bekannt\w*|sichtbar\w*|prepozn\w*|vidljiv\w*)\b/i],
];

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

export function purposeOf(objective: string | null | undefined): CopyPurpose | null {
  if (!objective) return null;
  const t = fold(objective);
  for (const [p, re] of PURPOSE_WORDS) if (re.test(t)) return p;
  return null;
}

export const limitsLine = (limits: TextLimit[]) =>
  limits.length ? limits.map((l) => `${l.field} <= ${l.max}${l.field === 'hashtags' ? ' hashtags' : ' characters'} (${l.kind === 'platform_max' ? 'platform maximum' : 'recommended'})`).join('; ') : 'no fixed limit: keep it tight';

export interface CopyPlanInput {
  objective: string | null;
  direction: CopyDirection | null;
  voice: BrandVoice;
  platforms: string[];
  hasWebsite: boolean;
  /** Facts the USER entered in the campaign design (an offer, a date): they are real evidence for urgency. */
  userFacts?: { offer?: string; offerDetail?: string; date?: string } | null;
}

/** Builds the campaign's copywriting plan. Pure and deterministic. */
export function planCopywriting(i: CopyPlanInput): CopyPlan {
  const d = i.direction;
  const fromObjective = purposeOf(i.objective);
  const purpose: CopyPurpose = d?.purpose ?? fromObjective ?? (i.voice.sensitivity === 'regulated' ? 'trust' : 'awareness');
  const purposeBasis = d?.purpose ? 'strategist' : fromObjective ? 'objective' : 'default';
  const combo = COMBINATIONS[purpose];
  const notes: string[] = [];
  const uf = i.userFacts ?? {};
  const userUrgency = [uf.offer && `offer "${uf.offer}${uf.offerDetail ? ` ${uf.offerDetail}` : ''}"`, uf.date && `date "${uf.date}"`].filter(Boolean).join(', ');
  const urgency = d?.urgency ? `${d.urgency.text} [${d.urgency.findingId}]` : userUrgency ? `Stated by the user in the campaign design: ${userUrgency}. Use it exactly as given.` : null;

  const excluded: CopyPlan['excluded'] = [];
  if (!urgency) excluded.push({ id: 'P8', reason: 'No verified deadline, season, capacity or offer in the material: no urgency or scarcity of any kind; use a clear value and call to action instead.' });
  if (!d?.limitation) excluded.push({ id: 'P5', reason: 'No documented limitation or trade-off in the material: no damaging admission (none may be invented).' });
  if (i.voice.humor === 'off') excluded.push({ id: 'P13', reason: i.voice.sensitivity === 'regulated' ? 'Regulated or sensitive industry: no humor.' : 'The brand voice is not playful: no humor.' });
  const out = new Set(excluded.map((e) => e.id));

  const primary = combo.primary.filter((p) => !out.has(p));
  const optional = [...new Set([...combo.optional, ...(d?.principles ?? [])])].filter((p) => !out.has(p) && !primary.includes(p));
  const proofPoints = (d?.proofPoints ?? []).filter((p) => p.trim()).slice(0, 5);

  if (!proofPoints.length) notes.push('No proven differentiator or credential in the material: P2 = a specific verified feature or useful outcome, never a "unique", "best" or "leading" claim; P9 = implied authority only (useful insight), no credentials.');
  else notes.push('Direct authority (credentials, proof) may be used ONLY with the listed proof points; everything else is implied authority.');
  if (!i.hasWebsite) notes.push('No destination exists (no website): every call to action names an action, never a link, and the missing destination is reported in missingInformation.');
  if (i.voice.sensitivity === 'regulated') notes.push('Regulated industry: conservative claim language ("can help", "designed to"), no guarantees, no outcome promises; keep the precise terms the audience expects.');
  if (i.voice.technicalDepth === 'expert') notes.push('Expert audience: precise terminology is allowed where it is needed; clarity means clear structure, not dumbed-down words.');
  if (i.voice.evidenceConfidence === 'low') notes.push('The brand voice is a cautious default: write clearly and neutrally rather than imitating a style that is not evidenced.');

  const wanted = new Set<PrincipleId>([...primary, ...optional]);
  const placementOf = (s: PlacementSpec): PlacementPlan => {
    const fit = s.affinity.filter((p) => !out.has(p));
    const chosen = [...fit.filter((p) => wanted.has(p)), ...fit.filter((p) => !wanted.has(p))].slice(0, s.max);
    return { key: s.key, label: s.label, principles: chosen, limits: limitsLine(limitsFor(s.channel, s.placement)), guidance: s.guidance };
  };
  const placements = [...i.platforms.map((p) => SOCIAL[p]).filter((s): s is PlacementSpec => !!s), ...OTHER].map(placementOf);

  return CopyPlan.parse({
    version: 1,
    purpose,
    purposeBasis,
    goal: combo.goal,
    primary,
    optional,
    excluded,
    placements,
    evidence: { urgency, limitation: d?.limitation ? `${d.limitation.text} [${d.limitation.findingId}]` : null, proofPoints },
    voice: i.voice,
    notes,
  });
}

/** The compact plan the Content Writer and the Quality Reviewer receive (ids only; the guidance itself is in their system instruction). */
export function planForPrompt(p: CopyPlan, d: CopyDirection | null) {
  return {
    purpose: `${p.purpose}: ${p.goal}`,
    primaryPrinciples: p.primary,
    optionalPrinciples: p.optional,
    excluded: p.excluded.map((e) => `${e.id} ${PRINCIPLES[e.id].name}: ${e.reason}`),
    ...(d ? { mainProblem: d.mainProblem, practicalBenefit: d.practicalBenefit, emotionalBenefit: d.emotionalBenefit, desiredAction: d.desiredAction } : {}),
    proofPoints: p.evidence.proofPoints,
    urgency: p.evidence.urgency,
    limitation: p.evidence.limitation,
    voice: { tone: p.voice.tone, formality: p.voice.formality, directness: p.voice.directness, emotionalIntensity: p.voice.emotionalIntensity, technicalDepth: p.voice.technicalDepth, personality: p.voice.personality, humor: p.voice.humor, sensitivity: p.voice.sensitivity, preferredTerms: p.voice.preferredTerms, neverUse: p.voice.forbiddenExpressions, evidence: p.voice.evidenceConfidence },
    placements: p.placements.map((x) => ({ placement: x.key, principles: x.principles, limits: x.limits, guidance: x.guidance })),
    notes: p.notes,
  };
}
