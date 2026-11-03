import type { F1Context } from '../audit/context';
import type { CreativeInput, F3Context } from './context';

/**
 * The VISUAL BRIEF: what the Visual Creator and the image prompt need to know about the business, gathered from F1 (the product), F2/F3
 * (the strategy and its creative brief) and the run's input. Nothing here is written by a model and nothing is invented: every field is
 * copied or trimmed from a stored report. Before this existed the Visual Creator saw only the strategy block; it never saw what the
 * product actually is, so its pictures stayed generic.
 */
export interface VisualBrief {
  business: string;
  /** What the business offers and the problem it solves, in the product report's own words. */
  offering: string;
  valueProposition: string;
  /** The first campaign goal of the strategy. */
  campaignGoal: string;
  audience: { primary: string; secondary: string[]; segments: string[] };
  brand: { tone: string; visualDirection: string; constraints: string[]; palette: string[]; observed: string[] };
  /** Where the audience is: pictures should feel local and believable without inventing a specific real place. */
  locale: { geography: string[]; language: string };
  channels: { channel: string; role: string; formats: string[] }[];
  /** Claims and themes the strategy says to stay away from (they must not appear in any picture either). */
  avoid: string[];
}

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const strs = (v: unknown, n: number, max: number): string[] => (Array.isArray(v) ? v.map((x) => clip(typeof x === 'string' ? x : (x as { text?: unknown } | null)?.text, n)).filter(Boolean).slice(0, max) : []);

export function buildVisualBrief(f1: F1Context, f3: F3Context, input: CreativeInput, palette: string[]): VisualBrief {
  const r = f3.report;
  const b = r.creativeBrief;
  const pc = r.productContext;
  const manifest = f1.report.productManifest as unknown as Record<string, unknown>;
  const observed = f1.findings
    .filter((f) => f.category === 'visual' || f.category === 'communication')
    .slice(0, 5)
    .map((f) => clip(f.statement, 200))
    .filter(Boolean);
  return {
    business: pc.name || input.projectName,
    offering: [clip(pc.offering, 300), clip(manifest.problem, 240)].filter(Boolean).join(' · '),
    valueProposition: clip(r.valueProposition.text, 300),
    campaignGoal: clip(r.campaignGoals[0]?.goal ?? b.objective, 240),
    audience: { primary: clip(b.audiencePrimary, 200), secondary: strs(b.audienceSecondary, 160, 3), segments: r.priorityAudiences.slice(0, 3).map((a) => clip(`${a.segmentName} (${a.priority})`, 120)) },
    brand: { tone: clip(b.toneOfVoice, 160), visualDirection: clip(b.visualDirection, 400), constraints: strs(b.brandConstraints, 200, 5), palette: palette.slice(0, 4), observed },
    locale: { geography: strs(pc.geography, 80, 4), language: input.language },
    channels: r.channels.filter((c) => input.channels.includes(c.channel)).map((c) => ({ channel: c.channel, role: c.role, formats: strs(c.formats, 60, 3) })),
    avoid: [...strs(b.claimsToAvoid.map((c) => c.claim), 160, 5), ...strs(r.positioning.crowdedThemesToAvoid, 120, 4)],
  };
}
