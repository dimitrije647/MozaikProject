import { z } from 'zod';
import { COPY_PURPOSES, PRINCIPLE_IDS } from './principles';

const text = (max: number) => z.string().max(max);

/** A fact that licenses an evidence-bound principle (P8 urgency, P5 limitation): the statement and the finding id it rests on. */
const EvidencedPoint = z.object({ text: text(220), findingId: z.string().max(24) });

/**
 * THE COPY DIRECTION: the Marketing Strategist's compact hand-off to the Content Writer, inside the creative brief. The strategist decides
 * WHY and WHAT to communicate (purpose, problem, benefits, next action, proof, suitable principles); the writer decides HOW. Every field is
 * required for strict structured outputs (absent = null / empty list). Urgency and limitation must cite a finding; the policy drops one
 * that cites nothing real (see strategy/policy.ts).
 */
export const CopyDirection = z.object({
  purpose: z.enum(COPY_PURPOSES),
  /** The ONE customer problem the campaign speaks to. */
  mainProblem: text(240),
  practicalBenefit: text(240),
  /** The status side of the benefit (in control, prepared, trusted, capable...), in the audience's own terms. */
  emotionalBenefit: text(240),
  /** The one next action that really exists. */
  desiredAction: text(200),
  /** Verified or user-stated facts the copy may use as proof (P2 / P9); never invented. */
  proofPoints: z.array(text(200)).max(5),
  /** A REAL deadline, season, capacity or offer from the material, else null (then no urgency is used). */
  urgency: EvidencedPoint.nullable(),
  /** A REAL, documented limitation or trade-off, else null (then no damaging admission is used). */
  limitation: EvidencedPoint.nullable(),
  /** 3 to 6 principle ids that suit this campaign. */
  principles: z.array(z.enum(PRINCIPLE_IDS)).max(6),
  rationale: text(300),
});
export type CopyDirection = z.infer<typeof CopyDirection>;
