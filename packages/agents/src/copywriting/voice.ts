import { z } from 'zod';

/**
 * THE BRAND VOICE PROFILE: how ONE company writes, inferred deterministically (no model call) from what the project already knows: the
 * user's override in the campaign setup, the strategist's tone of voice, the brand notes of the business research, the business type and
 * industry, and (only as a soft hint) the visual collection. When the evidence is thin, conservative defaults are used and the profile says so:
 * it never pretends to know the brand. The company's real voice and audience always win over a template stereotype (a dark collection does not
 * make a business a luxury brand).
 */
export const VOICE_TONES = ['professional', 'conversational', 'playful', 'premium', 'technical'] as const;
export type VoiceTone = (typeof VOICE_TONES)[number];

export const BrandVoice = z.object({
  tone: z.enum(VOICE_TONES),
  formality: z.enum(['formal', 'neutral', 'casual']),
  directness: z.enum(['restrained', 'balanced', 'direct']),
  emotionalIntensity: z.enum(['calm', 'moderate', 'high']),
  technicalDepth: z.enum(['plain', 'moderate', 'expert']),
  /** Two to four personality words, e.g. "calm, precise, reliable". */
  personality: z.array(z.string()).max(4),
  preferredTerms: z.array(z.string()).max(10),
  /** Expressions and claims never to use (generic hype, the user's own list, the strategy's claims to avoid). */
  forbiddenExpressions: z.array(z.string()).max(24),
  humor: z.enum(['off', 'light']),
  /** regulated = finance, legal, health, insurance, tax, governance...: conservative claim language, no humor. */
  sensitivity: z.enum(['standard', 'regulated']),
  language: z.string(),
  audience: z.string().nullable(),
  /** How much the profile rests on real evidence about the brand. low = mostly defaults. */
  evidenceConfidence: z.enum(['low', 'medium', 'high']),
  /** Where each decision came from, for the review and debugging. */
  basis: z.array(z.string()).max(10),
});
export type BrandVoice = z.infer<typeof BrandVoice>;

/** What the user may set in the campaign setup (all optional). */
export const VoiceOverride = z.object({
  tone: z.enum(VOICE_TONES).nullable().optional(),
  humor: z.boolean().nullable().optional(),
  preferredTerms: z.array(z.string().max(60)).max(10).optional(),
  avoid: z.array(z.string().max(80)).max(12).optional(),
});
export type VoiceOverride = z.infer<typeof VoiceOverride>;

export interface VoiceInput {
  language: string;
  audience: string | null;
  industry: string | null;
  category: string | null;
  businessType: string | null;
  offering: string | null;
  /** brand.style and brand.notes of the business research */
  brandStyle: string | null;
  brandNotes: string | null;
  /** the strategist's tone of voice (creative brief) */
  toneOfVoice: string | null;
  /** 0..1, the business research's overall confidence */
  researchConfidence: number | null;
  /** the approved template collection id, a soft hint only */
  collectionId: string | null;
  override?: VoiceOverride | null;
}

/** Hype and empty phrases no campaign should use (English and German; the per-language checks live in checks.ts). */
export const GENERIC_EXPRESSIONS = ['world-class', 'industry-leading', 'best-in-class', 'cutting-edge', 'revolutionary', 'game-changer', 'next level', 'innovative solutions', 'one-stop shop', 'unlock your potential', 'seamless', 'synergy'];

const REGULATED = /\b(financ\w*|bank(s|ing)?|asset manag\w*|wealth|invest\w*|funds?|trustees?|fiduciar\w*|insur\w*|pensions?|tax(es|ation)?|audit(s|ing|ors?)?|complian\w*|governance|regulat\w*|legal|law|lawyers?|law firms?|attorneys?|notar\w*|health\w*|medic\w*|clinics?|hospitals?|pharma\w*|dental|dentists?|therap\w*|psycholog\w*|crypto\w*|securities|vermogen\w*|treuhand\w*|versicher\w*|steuer\w*|rechts\w*|anwalt\w*|gesundheit\w*|arzt|praxis|finanz\w*|revision|pflege\w*)\b/i;
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const has = (s: string | null | undefined, re: RegExp) => !!s && re.test(fold(s));

const TONE_WORDS: [VoiceTone, RegExp][] = [
  ['playful', /\b(playful|fun|witty|humou?r|cheeky|quirky|verspielt|locker|witzig)\b/i],
  ['premium', /\b(premium|luxur|exclusive|refined|elegant|sophisticat|hochwertig|exklusiv|edel)\b/i],
  ['technical', /\b(technical|precise|engineer|developer|data-driven|technisch|präzise)\b/i],
  ['conversational', /\b(friendly|warm|conversational|casual|approachable|personal|freundlich|nahbar|persönlich|du-form)\b/i],
  ['professional', /\b(professional|formal|serious|authoritative|trustworthy|sachlich|seriös|professionell|vertrauens)\b/i],
];

const toneOfText = (s: string | null | undefined): VoiceTone | null => {
  if (!s) return null;
  for (const [tone, re] of TONE_WORDS) if (re.test(s)) return tone;
  return null;
};

/** A soft hint from the collection: it only shapes directness and intensity, never the tone itself. */
const COLLECTION_HINT: Record<string, { directness: BrandVoice['directness']; emotionalIntensity: BrandVoice['emotionalIntensity'] }> = {
  bold_startup: { directness: 'direct', emotionalIntensity: 'high' },
  dynamic_events: { directness: 'direct', emotionalIntensity: 'high' },
  premium_editorial: { directness: 'restrained', emotionalIntensity: 'calm' },
  luxury_hospitality: { directness: 'restrained', emotionalIntensity: 'calm' },
  minimal_tech: { directness: 'balanced', emotionalIntensity: 'calm' },
  modern_corporate: { directness: 'balanced', emotionalIntensity: 'calm' },
  soft_organic: { directness: 'balanced', emotionalIntensity: 'moderate' },
  lifestyle_human: { directness: 'balanced', emotionalIntensity: 'moderate' },
  clean_ecommerce: { directness: 'direct', emotionalIntensity: 'moderate' },
  contemporary_geometric: { directness: 'balanced', emotionalIntensity: 'moderate' },
};

const PERSONALITY: Record<VoiceTone, string[]> = {
  professional: ['clear', 'competent', 'reliable'],
  conversational: ['warm', 'helpful', 'down-to-earth'],
  playful: ['light', 'confident', 'friendly'],
  premium: ['restrained', 'confident', 'precise'],
  technical: ['precise', 'practical', 'honest'],
};

const clip = (list: string[], n: number) => [...new Set(list.map((s) => s.trim()).filter(Boolean))].slice(0, n);

/** Infers the Brand Voice Profile. Pure and deterministic. */
export function inferBrandVoice(i: VoiceInput): BrandVoice {
  const basis: string[] = [];
  const o = i.override ?? {};
  const businessText = [i.industry, i.category, i.offering].filter(Boolean).join(' ');
  const regulated = has(businessText, REGULATED);
  if (regulated) basis.push('Regulated or sensitive industry detected from the research: conservative claim language, no humor.');

  const b2b = i.businessType === 'software' || i.businessType === 'agency' || /\b(b2b|business|companies|firms|managers|professionals|unternehmen|firmen)\b/i.test(`${i.audience ?? ''} ${businessText}`);
  let tone: VoiceTone;
  let evidence = 0;
  if (o.tone) {
    tone = o.tone;
    basis.push(`Tone "${tone}" set by the user for this campaign.`);
    evidence += 2;
  } else {
    const fromBrief = toneOfText(i.toneOfVoice);
    const fromBrand = toneOfText(`${i.brandStyle ?? ''} ${i.brandNotes ?? ''}`);
    if (fromBrief) {
      tone = fromBrief;
      basis.push(`Tone "${tone}" from the strategy's tone of voice ("${(i.toneOfVoice ?? '').slice(0, 80)}").`);
      evidence += 1;
    } else if (fromBrand) {
      tone = fromBrand;
      basis.push(`Tone "${tone}" from the brand notes of the business research.`);
      evidence += 1;
    } else {
      tone = regulated || b2b ? 'professional' : 'conversational';
      basis.push(`No stated brand voice: conservative default "${tone}" for a ${regulated || b2b ? 'professional / business' : 'consumer'} audience.`);
    }
    if (fromBrief && fromBrand && fromBrief === fromBrand) evidence += 1;
  }
  // a playful or premium tone is never inferred for a regulated business; the user may still choose it
  if (regulated && !o.tone && (tone === 'playful' || tone === 'premium')) {
    basis.push(`"${tone}" softened to "professional" for a regulated industry.`);
    tone = 'professional';
  }

  const hint = i.collectionId ? COLLECTION_HINT[i.collectionId] : undefined;
  if (hint) basis.push(`The "${i.collectionId}" collection only nudges directness and intensity; the tone comes from the brand.`);
  const formality: BrandVoice['formality'] = tone === 'playful' || tone === 'conversational' ? (regulated ? 'neutral' : 'casual') : regulated || tone === 'premium' ? 'formal' : 'neutral';
  const directness: BrandVoice['directness'] = tone === 'premium' ? 'restrained' : hint?.directness ?? (tone === 'playful' ? 'direct' : 'balanced');
  const emotionalIntensity: BrandVoice['emotionalIntensity'] = regulated ? 'calm' : tone === 'premium' || tone === 'technical' ? 'calm' : hint?.emotionalIntensity ?? 'moderate';
  const technicalDepth: BrandVoice['technicalDepth'] = tone === 'technical' || (regulated && b2b) ? 'expert' : b2b || regulated ? 'moderate' : 'plain';

  const humorAllowed = o.humor === false ? false : o.humor === true ? !regulated : !regulated && (tone === 'playful' || tone === 'conversational');
  if (o.humor === true && regulated) basis.push('Humor was requested but stays off in a regulated industry.');

  const confidence = (i.researchConfidence ?? 0) >= 0.7 ? 1 : 0;
  const level = evidence + confidence >= 3 ? 'high' : evidence + confidence >= 1 ? 'medium' : 'low';
  if (level === 'low') basis.push('Little evidence about the brand voice: the profile is a cautious default, not a known brand style.');

  return BrandVoice.parse({
    tone,
    formality,
    directness,
    emotionalIntensity,
    technicalDepth,
    personality: PERSONALITY[tone],
    preferredTerms: clip(o.preferredTerms ?? [], 10),
    forbiddenExpressions: clip([...(o.avoid ?? []), ...GENERIC_EXPRESSIONS], 24),
    humor: humorAllowed ? 'light' : 'off',
    sensitivity: regulated ? 'regulated' : 'standard',
    language: i.language,
    audience: i.audience,
    evidenceConfidence: level,
    basis: basis.slice(0, 10),
  });
}

/** One line for prompts. */
export const voiceLine = (v: BrandVoice) =>
  `${v.tone}, ${v.formality}, ${v.directness}, emotional intensity ${v.emotionalIntensity}, technical depth ${v.technicalDepth}; personality: ${v.personality.join(', ')}; humor ${v.humor}; ${v.sensitivity === 'regulated' ? 'REGULATED industry: conservative claims' : 'standard claim language'}; evidence about the voice: ${v.evidenceConfidence}`;
