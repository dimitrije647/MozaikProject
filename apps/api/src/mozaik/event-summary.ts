type Obj = Record<string, any>;
const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/** Persisted Mozaik events worth showing as agent activity (model-loop noise such as inference.* is left out). */
export const ACTIVITY_EVENT_TYPES = [
  'factory.started', 'factory.completed', 'factory.failed', 'factory.cancelled',
  'phase.started', 'phase.ready', 'phase.completed', 'phase.failed',
  'task.assigned', 'task.completed', 'finding.posted',
  'crosscheck.requested', 'crosscheck.answered',
  'participant.registered', 'participant.idle',
  'report.generated', 'audit.completed', 'strategy.completed',
  'copy.proposed', 'landing.proposed', 'visual.generated', 'layout.completed',
  'visual.direction.published', 'template.selection.completed', 'images.sourcing.requested', 'images.sourced', 'image.generation.refused', 'template.quality.requested', 'template.quality.completed',
  'review.requested', 'review.completed', 'fix.requested',
  'revision.requested', 'revision.applied', 'revision.completed', 'campaign.completed',
] as const;

/** Events that mark a turning point (shown highlighted); the rest are normal or minor. */
const MAJOR = new Set(['participant.registered', 'review.completed', 'fix.requested', 'revision.requested', 'revision.applied', 'revision.completed', 'campaign.completed', 'visual.generated', 'layout.completed', 'copy.proposed', 'landing.proposed', 'strategy.completed', 'audit.completed', 'report.generated', 'visual.direction.published', 'template.selection.completed', 'template.quality.completed', 'images.sourced', 'image.generation.refused']);
const MINOR = new Set(['participant.idle', 'factory.started', 'phase.ready', 'review.requested', 'task.assigned']);
export const importanceOf = (type: string): 'major' | 'normal' | 'minor' => (MAJOR.has(type) ? 'major' : MINOR.has(type) ? 'minor' : 'normal');

/** One honest line per recorded event, built only from what the event carries. */
export function summarizeEvent(type: string, p: Obj): string {
  switch (type) {
    case 'phase.started': return `${n(p.agents)} participant(s) assigned`;
    case 'phase.ready': return `all participants reported (${n(p.succeeded)} done, ${n(p.failed)} failed, ${n(p.skipped)} skipped)`;
    case 'phase.completed': return 'phase completed';
    case 'phase.failed': return `phase failed (${p.reason ?? 'error'})`;
    case 'task.assigned': return `${p.agent} started: ${p.task}`;
    case 'task.completed': return `${p.agent}: ${p.outcome}${p.error?.message ? ` (${p.error.message})` : ''}${p.reason ? ` (${p.reason})` : ''}`;
    case 'finding.posted': return `${p.agent} posted ${n(p.findings)} finding(s)`;
    case 'crosscheck.requested': return `${p.producer} → ${p.reviewer}: ${n(p.claims)} claim(s) to check`;
    case 'crosscheck.answered': return `${p.reviewer} → ${p.producer}: ${p.status}${p.status === 'answered' ? ` (${(p.answers ?? []).map((a: Obj) => a.verdict).join(', ')})` : ''}`;
    case 'participant.registered': return `${p.agent} joined the run at run time: ${p.reason}`;
    case 'participant.idle': return `${p.agent} not used: ${p.reason}`;
    case 'report.generated':
    case 'audit.completed':
    case 'strategy.completed': return 'result saved';
    case 'copy.proposed': return `${n(p.concepts)} concept(s), ${n(p.variants)} copy variant(s) proposed`;
    case 'landing.proposed': return 'landing page content proposed';
    case 'visual.generated': {
      const v = p.variation as { variationName?: string; variationId?: string; status?: string; explanation?: string | null } | undefined;
      if (v) {
        const who = `${p.conceptId} · ${v.variationName ?? v.variationId}`;
        if (v.status === 'generated') return `${who}: AI image generated and stored as ${p.asset?.id ?? '?'}`;
        if (v.status === 'blocked_by_budget') return `${who}: not requested, stopped by a budget. ${v.explanation ?? ''}`.trim();
        if (v.status === 'skipped') return `${who}: no AI image requested. ${v.explanation ?? ''}`.trim();
        return `${who}: NO AI image (nothing is shown in its place). ${v.explanation ?? p.error?.message ?? 'The image request failed.'}`;
      }
      const r = p.result as { outcome?: string; explanation?: string | null } | undefined;
      if (r?.outcome === 'skipped') return `${p.conceptId}: no AI image requested. ${r.explanation ?? 'Skipped.'}`;
      if (r?.outcome === 'failed' || p.failed) return `${p.conceptId}: NO AI image, a brand-colored background is used. ${r?.explanation ?? p.error?.message ?? 'The image request failed.'}`;
      return `${p.conceptId}: AI image generated and stored as ${p.asset?.id ?? '?'}`;
    }
    case 'layout.completed': {
      const tc = (p.templateCreatives ?? []) as Obj[];
      if (tc.length) return `${p.conceptId}: ${tc.map((t) => `${t.slotId} ${t.templateName} (${t.format}) ${t.status === 'rendered' ? 'rendered' : t.status === 'fallback_rendered' ? 'rendered without its original (FALLBACK)' : t.status === 'failed' ? `FAILED: ${t.reason ?? ''}` : `not rendered: ${t.reason ?? ''}`}`).join('; ')}`.slice(0, 400);
      return `${p.conceptId}: ${n(p.layouts)} layout(s) rendered${n(p.skipped) ? `, ${n(p.skipped)} format(s) skipped` : ''}`;
    }
    case 'visual.direction.published': return `${p.direction?.styleId ?? 'style'} direction published (${p.refined ? 'refined by one text-model call' : 'from the style library and the brand'}, ${(p.direction?.references ?? []).length} reference(s) recorded)`;
    case 'images.sourcing.requested': return `Sourcing pictures for ${Number(p.slots) || 0} planned creative(s) across ${Number(p.concepts) || 0} concept(s)`;
    case 'images.sourced': return String(p.summary ?? 'Pictures sourced').slice(0, 220);
    case 'image.generation.refused': return `An image-generation request was refused before anything was sent (${Number(p.count) || 0}): NO AI HYBRID never generates images`;
    case 'template.selection.completed': return `${n(p.plan?.items)} template creative(s) planned from ${p.plan?.eligibleCount ?? '?'} eligible template(s) (${p.mode}${p.modelAssisted ? ', model-assisted' : ', no model call'})`;
    case 'template.quality.requested': return `${p.planned} planned template creative(s) to check`;
    case 'template.quality.completed': return p.report ? `${p.report.summary}` : `check did not run${p.error ? `: ${p.error}` : ''}`;
    case 'review.requested': return `round ${p.round}: ${n(p.scope?.variantIds)} variant(s), ${n(p.scope?.assetIds)} asset(s)${p.scope?.landing ? ', landing page' : ''}`;
    case 'review.completed': return `round ${p.round}: ${n(p.findings)} finding(s), model review ${p.modelReview}`;
    case 'fix.requested': return `round ${p.round}: ${n(p.findingIds)} finding(s) handed to the Fixer`;
    case 'revision.requested': return `Fixer → ${p.agent}: ${n(p.operations)} repair operation(s), wave ${p.wave}`;
    case 'revision.applied': return `${p.owner}: ${p.status} — ${p.note}`;
    case 'revision.completed': return `round ${p.round}: ${(p.results ?? []).filter((r: Obj) => r.status === 'applied').length} of ${n(p.results)} repair(s) applied`;
    case 'campaign.completed': return 'campaign package saved';
    case 'factory.started': return 'phase run started';
    case 'factory.completed': return 'phase run completed';
    case 'factory.failed': return `phase run failed${p.message ? `: ${p.message}` : ''}`;
    case 'factory.cancelled': return 'phase run cancelled';
    default: return '';
  }
}
