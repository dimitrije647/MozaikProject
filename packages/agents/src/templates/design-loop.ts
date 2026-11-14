import { CRITICAL_CHECKS, nextRepair, needsAnotherTemplate, severityOf, visibilityScore, type PreflightResult, type RepairAction } from './preflight';
import type { RenderTune, TemplateRenderResult } from './schema';

type OkRender = Extract<TemplateRenderResult, { ok: true }>;

export interface DesignAttempt {
  templateId: string;
  res: OkRender;
  pre: PreflightResult;
  tune: RenderTune;
  /** every repair applied to reach this attempt (cumulative) */
  actions: RepairAction[];
}

/**
 * An attempt without a CRITICAL failure (a cut face, cut text, an unreadable logo...) beats one with it; then fewer/lighter failures win; with the
 * same failures, the attempt where the people and the picture stay more visible wins.
 */
export function isBetter(a: DesignAttempt, b: DesignAttempt): boolean {
  const ca = a.pre.failures.some((f) => CRITICAL_CHECKS.has(f.id));
  const cb = b.pre.failures.some((f) => CRITICAL_CHECKS.has(f.id));
  if (ca !== cb) return !ca;
  const sa = severityOf(a.pre);
  const sb = severityOf(b.pre);
  if (sa !== sb) return sa < sb;
  return visibilityScore(a.res.report) > visibilityScore(b.res.report) + 0.02;
}

/**
 * Renders ONE template, checks it with the preflight and repairs it in place (crop, logo, overlay opacity, decoration, text backing) until it
 * passes, no repair is left, or `maxSteps` renders were made. Returns the best attempt (a passing one, else the least severe), or the render
 * failure when the very first render was refused.
 */
export async function repairLoop(
  templateId: string,
  render: (tune: RenderTune) => Promise<TemplateRenderResult>,
  check: (res: OkRender) => PreflightResult,
  maxSteps = 4,
  initial: RenderTune = {},
): Promise<{ best: DesignAttempt | null; renders: number; refused: Extract<TemplateRenderResult, { ok: false }> | null; needsTemplate: boolean }> {
  let tune: RenderTune = { ...initial };
  let actions: RepairAction[] = [];
  let best: DesignAttempt | null = null;
  let renders = 0;
  for (let step = 0; step < maxSteps; step++) {
    const res = await render(tune);
    renders++;
    if (!res.ok) return { best, renders, refused: best ? null : res, needsTemplate: true };
    const pre = check(res);
    const attempt: DesignAttempt = { templateId, res, pre, tune, actions };
    if (!best || isBetter(attempt, best)) best = attempt;
    if (pre.passed) return { best: attempt, renders, refused: null, needsTemplate: false };
    const next = nextRepair(pre, res.report, tune);
    if (!next) break;
    tune = next.tune;
    actions = [...actions, ...next.actions];
  }
  return { best, renders, refused: null, needsTemplate: !best?.pre.passed && (best ? needsAnotherTemplate(best.pre) || severityOf(best.pre) > 0 : true) };
}
