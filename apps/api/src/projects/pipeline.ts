/**
 * The persisted state of a project's four factory phases, derived ONLY from what is stored: the newest CampaignRun of each mode
 * and the newest COMPLETED output (report, audit, strategy, campaign). Nothing here is a guess and nothing is stored: a phase is
 * "completed" only if a run finished and its output exists; a failed rerun never hides an earlier completed output (both are shown).
 */
export type PhaseKey = 'discovery' | 'audit' | 'strategy' | 'creative';
export type PhaseState = 'not_started' | 'blocked' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type RunState = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';

export const PHASES: { key: PhaseKey; code: 'F1' | 'F2' | 'F3' | 'F4'; mode: string; title: string; needs: PhaseKey | null; needsText: string }[] = [
  { key: 'discovery', code: 'F1', mode: 'product_discovery', title: 'Product Intelligence', needs: null, needsText: '' },
  { key: 'audit', code: 'F2', mode: 'marketing_audit', title: 'Marketing Audit', needs: 'discovery', needsText: 'Needs a completed Product Discovery (F1) report.' },
  { key: 'strategy', code: 'F3', mode: 'market_strategy', title: 'Market Research & Strategy', needs: 'audit', needsText: 'Needs a completed Marketing Audit (F2).' },
  { key: 'creative', code: 'F4', mode: 'creative_production', title: 'Creative Production', needs: 'strategy', needsText: 'Needs a completed Market Research & Strategy (F3) report.' },
];

export interface RunFact {
  id: string;
  projectId: string;
  mode: string;
  status: RunState;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
}

/** The newest completed output of a phase, as stored. `upstreamId` is the id of the earlier-phase output it was built on. */
export interface OutputFact {
  id: string;
  projectId: string;
  runId: string;
  createdAt: Date;
  model: string | null;
  upstreamId: string | null;
  /** Older stored reports (schemaVersion < 2) carry no Product Manifest and cannot feed F2. */
  usable: boolean;
  partial: boolean | null;
  summary: string | null;
  stats: { label: string; value: string | number }[];
  approvalStatus: string | null;
}

export interface PipelineOutput {
  id: string;
  runId: string;
  createdAt: string;
  model: string | null;
  partial: boolean | null;
  summary: string | null;
  stats: { label: string; value: string | number }[];
  approvalStatus: string | null;
  /** Set when a newer completed output exists upstream than the one this was built on. */
  outdated: string | null;
}

export interface PipelinePhase {
  phase: PhaseKey;
  code: 'F1' | 'F2' | 'F3' | 'F4';
  title: string;
  state: PhaseState;
  /** Why a phase cannot start yet (only when state is "blocked"). */
  blockedBy: string | null;
  latestRun: { id: string; status: RunState; startedAt: string; completedAt: string | null; errorMessage: string | null } | null;
  /** The newest COMPLETED output, even when the latest run failed or is running (a rerun never deletes it). */
  output: PipelineOutput | null;
  runs: number;
  note: string | null;
}

export interface PipelineView {
  projectId: string;
  phases: PipelinePhase[];
  completed: number;
  running: PhaseKey | null;
  /** The first phase that can be started and has no completed output, else null. */
  next: PhaseKey | null;
}

export type PipelineSummary = Pick<PipelineView, 'completed' | 'running' | 'next'> & { states: Record<PhaseKey, PhaseState>; hasOutput: Record<PhaseKey, boolean> };

const RUN_STATE_TO_PHASE: Record<RunState, PhaseState> = { RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled', INTERRUPTED: 'interrupted' };

export function derivePipeline(projectId: string, runs: RunFact[], outputs: Partial<Record<PhaseKey, OutputFact | null>>): PipelineView {
  const phases: PipelinePhase[] = [];
  for (const def of PHASES) {
    const mine = runs.filter((r) => r.mode === def.mode).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const latest = mine[0] ?? null;
    const out = outputs[def.key] ?? null;
    const upstreamOut = def.needs ? (outputs[def.needs] ?? null) : null;
    const upstreamOk = !def.needs || (!!upstreamOut && upstreamOut.usable);

    let state: PhaseState;
    let note: string | null = null;
    if (latest) {
      state = RUN_STATE_TO_PHASE[latest.status];
      if (state === 'completed' && out?.runId !== latest.id) {
        // A run is only "completed" when ITS output was saved; nothing is invented.
        state = 'failed';
        note = out ? 'The latest run is marked completed but its result was not saved; the result below is from an earlier run.' : 'The latest run is marked completed but no saved result was found.';
      } else if (state === 'running') note = out ? 'A run is in progress; the result below is from an earlier run.' : null;
      else if (state !== 'completed' && out) note = `The latest run ${latest.status.toLowerCase()}; the result below is from an earlier completed run.`;
    } else if (out) {
      state = 'completed'; // a stored result without a surviving run row; shown as stored
    } else {
      state = upstreamOk ? 'not_started' : 'blocked';
    }
    const blockedBy = state === 'blocked' ? (upstreamOut && !upstreamOut.usable ? 'The Product Discovery report is from an earlier version without a Product Manifest. Run Product Discovery again.' : def.needsText) : null;

    let outdated: string | null = null;
    if (out && def.needs && upstreamOut && out.upstreamId && out.upstreamId !== upstreamOut.id) {
      outdated = `Built on an earlier ${PHASES.find((p) => p.key === def.needs)!.code} result; a newer one exists.`;
    }
    phases.push({
      phase: def.key,
      code: def.code,
      title: def.title,
      state,
      blockedBy,
      latestRun: latest ? { id: latest.id, status: latest.status, startedAt: latest.startedAt.toISOString(), completedAt: latest.completedAt?.toISOString() ?? null, errorMessage: latest.errorMessage } : null,
      output: out ? { id: out.id, runId: out.runId, createdAt: out.createdAt.toISOString(), model: out.model, partial: out.partial, summary: out.summary, stats: out.stats, approvalStatus: out.approvalStatus, outdated } : null,
      runs: mine.length,
      note,
    });
  }
  const running = phases.find((p) => p.state === 'running')?.phase ?? null;
  // the first phase without a result that can be started (its prerequisite result exists)
  const next = phases.find((p) => !p.output && p.state !== 'blocked' && p.state !== 'running')?.phase ?? null;
  return { projectId, phases, completed: phases.filter((p) => !!p.output).length, running, next };
}

export function summarize(view: PipelineView): PipelineSummary {
  return {
    completed: view.completed,
    running: view.running,
    next: view.next,
    states: Object.fromEntries(view.phases.map((p) => [p.phase, p.state])) as Record<PhaseKey, PhaseState>,
    hasOutput: Object.fromEntries(view.phases.map((p) => [p.phase, !!p.output])) as Record<PhaseKey, boolean>,
  };
}
