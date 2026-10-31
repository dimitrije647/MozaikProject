import { Injectable, NotFoundException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { PHASES, derivePipeline, summarize, type OutputFact, type PhaseKey, type PipelineSummary, type PipelineView, type RunFact } from './pipeline';

type Obj = Record<string, any>;
const clip = (s: unknown, n = 280) => (typeof s === 'string' && s.trim() ? (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s) : null);
const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
const tokens = (m: Obj) => Number(m?.usage?.total?.totalTokens ?? (Number(m?.usage?.total?.inputTokens ?? 0) + Number(m?.usage?.total?.outputTokens ?? 0))) || 0;

/** The newest item per project from rows already sorted newest first. */
const newestPerProject = <T extends { projectId: string }>(rows: T[]) => {
  const out = new Map<string, T>();
  for (const r of rows) if (!out.has(r.projectId)) out.set(r.projectId, r);
  return out;
};

/**
 * Reads the persisted state of the four phases (CampaignRun + the saved report, audit, strategy and campaign rows) for
 * the owner's projects. Read-only: it never starts, completes or alters anything.
 */
@Injectable()
export class PipelineService {
  constructor(private prisma: PrismaService) {}

  async detail(userId: string, projectId: string): Promise<PipelineView> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, userId }, select: { id: true } });
    if (!project) throw new NotFoundException('Project not found'); // 404, not 403: ids cannot be probed
    const facts = await this.load([projectId], true);
    return derivePipeline(projectId, facts.runs.filter((r) => r.projectId === projectId), facts.outputs.get(projectId) ?? {});
  }

  /** One lightweight summary per project (states and counts only; no report content is read). */
  async summaries(userId: string, projectIds: string[]): Promise<Map<string, PipelineSummary>> {
    const owned = await this.prisma.project.findMany({ where: { id: { in: projectIds }, userId }, select: { id: true } });
    const ids = owned.map((p) => p.id);
    const out = new Map<string, PipelineSummary>();
    if (!ids.length) return out;
    const facts = await this.load(ids, false);
    for (const id of ids) out.set(id, summarize(derivePipeline(id, facts.runs.filter((r) => r.projectId === id), facts.outputs.get(id) ?? {})));
    return out;
  }

  private async load(projectIds: string[], withContent: boolean) {
    const where = { projectId: { in: projectIds } };
    const modes = PHASES.map((p) => p.mode);
    const [runRows, f1Rows, f2Rows, f3Rows, f4Rows] = await Promise.all([
      this.prisma.campaignRun.findMany({ where: { ...where, mode: { in: modes } }, orderBy: { startedAt: 'desc' }, select: { id: true, projectId: true, mode: true, status: true, startedAt: true, completedAt: true, errorMessage: true } }),
      this.prisma.productDiscoveryReport.findMany({ where: { ...where, run: { status: RunStatus.COMPLETED } }, orderBy: { createdAt: 'desc' }, select: { id: true, projectId: true, runId: true, createdAt: true, model: true, schemaVersion: true } }),
      this.prisma.marketingAuditReport.findMany({ where: { ...where, run: { status: RunStatus.COMPLETED } }, orderBy: { createdAt: 'desc' }, select: { id: true, projectId: true, runId: true, createdAt: true, model: true, f1ReportId: true } }),
      this.prisma.marketingStrategyReport.findMany({ where: { ...where, run: { status: RunStatus.COMPLETED } }, orderBy: { createdAt: 'desc' }, select: { id: true, projectId: true, runId: true, createdAt: true, model: true, f2AuditId: true } }),
      this.prisma.creativeCampaign.findMany({ where: { ...where, status: 'completed' }, orderBy: { createdAt: 'desc' }, select: { id: true, projectId: true, runId: true, createdAt: true, model: true, f3StrategyId: true, approvalStatus: true, campaignName: true } }),
    ]);
    const runs: RunFact[] = runRows.map((r) => ({ ...r, status: r.status as RunFact['status'] }));
    const n1 = newestPerProject(f1Rows);
    const n2 = newestPerProject(f2Rows);
    const n3 = newestPerProject(f3Rows);
    const n4 = newestPerProject(f4Rows);

    // content (summary text and counts) only for the newest output of each phase, and only when asked for
    const content = new Map<string, { report?: Obj; meta?: Obj }>();
    if (withContent) {
      const [c1, c2, c3, c4] = await Promise.all([
        this.prisma.productDiscoveryReport.findMany({ where: { id: { in: [...n1.values()].map((r) => r.id) } }, select: { id: true, reportJson: true, metadataJson: true } }),
        this.prisma.marketingAuditReport.findMany({ where: { id: { in: [...n2.values()].map((r) => r.id) } }, select: { id: true, reportJson: true, metadataJson: true } }),
        this.prisma.marketingStrategyReport.findMany({ where: { id: { in: [...n3.values()].map((r) => r.id) } }, select: { id: true, reportJson: true, metadataJson: true } }),
        this.prisma.creativeCampaign.findMany({ where: { id: { in: [...n4.values()].map((r) => r.id) } }, select: { id: true, packageJson: true, metadataJson: true } }),
      ]);
      for (const r of [...c1, ...c2, ...c3]) content.set(r.id, { report: (r.reportJson ?? {}) as Obj, meta: (r.metadataJson ?? {}) as Obj });
      for (const r of c4) content.set(r.id, { report: (r.packageJson ?? {}) as Obj, meta: (r.metadataJson ?? {}) as Obj });
    }

    const outputs = new Map<string, Partial<Record<PhaseKey, OutputFact>>>();
    const put = (projectId: string, key: PhaseKey, fact: OutputFact) => outputs.set(projectId, { ...(outputs.get(projectId) ?? {}), [key]: fact });
    const base = (r: { id: string; projectId: string; runId: string; createdAt: Date; model: string | null }) => ({ id: r.id, projectId: r.projectId, runId: r.runId, createdAt: r.createdAt, model: r.model });

    for (const r of n1.values()) {
      const c = content.get(r.id);
      put(r.projectId, 'discovery', {
        ...base(r), upstreamId: null, usable: r.schemaVersion >= 2, partial: c ? Boolean(c.report?.partial) : null, summary: clip(c?.report?.executiveSummary), approvalStatus: null,
        stats: c ? [{ label: 'Agents', value: count(c.meta?.plan?.activated) }, { label: 'Findings', value: count(c.meta?.findings) }, { label: 'Sources', value: count(c.meta?.sources) }, { label: 'Tokens', value: tokens(c.meta ?? {}) }] : [],
      });
    }
    for (const r of n2.values()) {
      const c = content.get(r.id);
      put(r.projectId, 'audit', {
        ...base(r), upstreamId: r.f1ReportId, usable: true, partial: c ? Boolean(c.report?.partial) : null, summary: clip(c?.report?.executiveSummary), approvalStatus: null,
        stats: c ? [{ label: 'Main problems', value: count(c.report?.mainProblems) }, { label: 'Findings', value: count(c.meta?.findings) }, { label: 'Tokens', value: tokens(c.meta ?? {}) }] : [],
      });
    }
    for (const r of n3.values()) {
      const c = content.get(r.id);
      put(r.projectId, 'strategy', {
        ...base(r), upstreamId: r.f2AuditId, usable: true, partial: c ? Boolean(c.report?.partial) : null, summary: clip(c?.report?.executiveSummary),  approvalStatus: null,
        stats: c ? [{ label: 'Channel Scouts', value: (c.meta?.scoutDecisions ?? []).filter((d: Obj) => d.selected).length }, { label: 'Findings', value: count(c.meta?.findings) }, { label: 'Tokens', value: tokens(c.meta ?? {}) }] : [],
      });
    }
    for (const r of n4.values()) {
      const c = content.get(r.id);
      const pkg = c?.report ?? {};
      const unresolved = count(pkg.approval?.unresolvedFindingIds);
      put(r.projectId, 'creative', {
        ...base(r), upstreamId: r.f3StrategyId, usable: true, partial: c ? Boolean(c.meta?.partial) : null, approvalStatus: r.approvalStatus,
        summary: clip(`${r.campaignName}${pkg.approval?.note ? `. ${pkg.approval.note}` : ''}`),
        stats: c
          ? [
              { label: 'Concepts', value: count(pkg.concepts) },
              { label: 'Images', value: (pkg.imageAssets ?? []).filter((a: Obj) => a.kind === 'image' && a.source === 'ai_image' && a.status !== 'superseded').length },
              { label: 'Layouts', value: count(pkg.channelLayouts) },
              { label: 'Unresolved', value: unresolved },
            ]
          : [],
      });
    }
    return { runs, outputs };
  }
}
