/**
 * THE COPYWRITING FRAMEWORK: twelve established copywriting principles (plus optional humor) and the combinations that serve each campaign
 * purpose. This file is the ONE canonical source of the guidance: agents exchange only the short ids (P1..P13); the full wording appears once,
 * in the system instructions of the Content Writer and the Quality Reviewer (see principleGuide).
 *
 * The principles are universal tools, not brand language. A campaign uses a few of them well, never all of them at once: a concise ad that
 * applies three principles naturally beats a long message forcing ten. Principles that need evidence (urgency, limitations, credentials) are
 * only planned when the research or the user supplied that evidence (see plan.ts).
 */
export const PRINCIPLE_IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11', 'P12', 'P13'] as const;
export type PrincipleId = (typeof PRINCIPLE_IDS)[number];
export const isPrincipleId = (v: unknown): v is PrincipleId => typeof v === 'string' && (PRINCIPLE_IDS as readonly string[]).includes(v);

/** What a principle needs before it may be used. `none` = always usable; the others need a supporting fact in the material. */
export type PrincipleEvidence = 'none' | 'facts' | 'urgency' | 'limitation' | 'humor';

export interface Principle {
  id: PrincipleId;
  name: string;
  /** What good application looks like (one line). */
  use: string;
  /** What it must never become (one line). */
  avoid: string;
  evidence: PrincipleEvidence;
}

export const PRINCIPLES: Readonly<Record<PrincipleId, Principle>> = {
  P1: { id: 'P1', name: 'Killer headline', evidence: 'none', use: 'earn attention with a specific problem, a relevant question, a concrete benefit, a credible surprising observation or a sharp contrast', avoid: 'generic slogans, empty superlatives, clickbait, sensationalism, a headline the content does not deliver' },
  P2: { id: 'P2', name: 'Say what only you can say', evidence: 'facts', use: 'the real difference: a capability, process, team experience, method or proof from the research; if no difference is known, a specific verified feature or useful outcome', avoid: '"best", "most trusted", "industry-leading", "revolutionary" or any unique selling point the material does not prove' },
  P3: { id: 'P3', name: 'Call out the right audience', evidence: 'none', use: 'make the intended reader recognize themselves: their role, situation, problem, responsibility or goal', avoid: 'writing for everyone; borrowing the tone of a different audience' },
  P4: { id: 'P4', name: 'Reason why', evidence: 'none', use: 'say why it matters, why the problem exists, why this helps, why the claim is credible or why the next step is worth it; only the reasons the evidence supports', avoid: 'reasons that do not follow from the material; stacking every reason into one message' },
  P5: { id: 'P5', name: 'Damaging admission', evidence: 'limitation', use: 'an authentic, documented limitation that builds trust (not for everyone, needs effort, depends on the customer, a deliberate trade-off)', avoid: 'inventing a weakness, exclusion or policy to seem honest' },
  P6: { id: 'P6', name: "Show, don't tell", evidence: 'none', use: 'replace abstract promises with a tangible situation: a scenario, a before/after, an observable change, a realistic outcome', avoid: 'invented testimonials, measured savings or results' },
  P7: { id: 'P7', name: 'Tie benefits to status', evidence: 'none', use: "show how the benefit changes the reader's standing: in control, prepared, trusted, respected, reliable, capable, building something that lasts (for a diver: a confident diver; for a team: delivering without chaos)", avoid: 'luxury or ego clichés the audience does not aspire to; manipulative flattery' },
  P8: { id: 'P8', name: 'Genuine urgency or scarcity', evidence: 'urgency', use: 'a REAL deadline, season, capacity limit, event date or documented offer from the material', avoid: 'fake countdowns, limited seats, deadlines or pressure; without real urgency use a clear value and call to action instead' },
  P9: { id: 'P9', name: 'Implied authority', evidence: 'none', use: 'show competence through a useful observation, a diagnostic question, a clearly explained method or accurate insight that a first-time reader understands without knowing the brand; add explicit credentials (direct authority) only when the research verifies them', avoid: 'declaring expertise; invented credentials, partners, awards, media mentions or years of experience' },
  P10: { id: 'P10', name: 'Powerful ending', evidence: 'none', use: 'a final line (or a P.S. where the format allows) that adds a memorable insight, a reminder or one last practical benefit', avoid: 'forcing a "P.S." into every post' },
  P11: { id: 'P11', name: 'Clear call to action', evidence: 'none', use: 'one primary next step that really exists (read, book, explore, register, download, request)', avoid: 'invented links, discounts, free assessments, products or registration pages; several competing actions' },
  P12: { id: 'P12', name: 'Third-grade clarity', evidence: 'none', use: 'short sentences, concrete words, active voice, clear structure, little jargon, at the precision the audience needs', avoid: 'childish wording or dropping necessary technical precision' },
  P13: { id: 'P13', name: 'Humor (optional)', evidence: 'humor', use: 'a natural, intelligent, relevant line that fits the brand personality ("Hope is not a risk strategy.")', avoid: 'jokes in sensitive, regulated or serious contexts; humor at the expense of credibility' },
};

/** The communication purpose of a campaign (or of one message). */
export const COPY_PURPOSES = ['awareness', 'trust', 'engagement', 'conversion', 'leadership', 'product'] as const;
export type CopyPurpose = (typeof COPY_PURPOSES)[number];

export interface PrincipleCombination {
  label: string;
  goal: string;
  primary: PrincipleId[];
  optional: PrincipleId[];
}

/** Starting patterns, not formulas: plan.ts adapts them to the evidence, the voice and each placement. */
export const COMBINATIONS: Readonly<Record<CopyPurpose, PrincipleCombination>> = {
  awareness: { label: 'Awareness / attention', goal: 'Stop the scroll and establish relevance.', primary: ['P1', 'P3', 'P6'], optional: ['P7', 'P9'] },
  trust: { label: 'Trust / credibility', goal: 'Establish believable expertise and differentiation.', primary: ['P2', 'P4', 'P9'], optional: ['P5', 'P6'] },
  engagement: { label: 'Engagement / education', goal: 'Give useful information worth reading or sharing.', primary: ['P3', 'P4', 'P6', 'P12'], optional: ['P9'] },
  conversion: { label: 'Conversion', goal: 'Encourage a meaningful next step.', primary: ['P1', 'P4', 'P11'], optional: ['P7', 'P8', 'P2'] },
  leadership: { label: 'Leadership / professional positioning', goal: 'Make the reader feel prepared, capable and professionally confident.', primary: ['P3', 'P7', 'P9', 'P12'], optional: ['P2', 'P10'] },
  product: { label: 'Product promotion', goal: 'Connect a real product benefit to a useful customer outcome.', primary: ['P2', 'P6', 'P11'], optional: ['P1', 'P4', 'P8'] },
};

/**
 * The canonical guidance as compact text, placed ONCE in a system instruction: `full` for the Content Writer (how to apply each principle),
 * `review` for the Quality Reviewer (what each principle must never become).
 */
export function principleGuide(mode: 'full' | 'review' = 'full'): string {
  const lines = PRINCIPLE_IDS.map((id) => {
    const p = PRINCIPLES[id];
    return mode === 'full' ? `${id} ${p.name}: ${p.use}. Never: ${p.avoid}.` : `${id} ${p.name}: never ${p.avoid}.`;
  });
  return `COPYWRITING PRINCIPLES (the ids used in <copy_plan> and in the "principles" fields)\n${lines.join('\n')}`;
}
