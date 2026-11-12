'use client';

import * as React from 'react';
import { History } from 'lucide-react';
import { AuditReportView } from '@/components/audit-report-view';
import { CampaignResult } from '@/components/campaign-result';
import { ReportView } from '@/components/report-view';
import { StrategyReportView } from '@/components/strategy-report-view';
import { Badge } from '@/components/ui/badge';
import { useAudit, useAudits, useCampaigns, useReport, useReports, useStrategies, useStrategy } from '@/lib/hooks';
import { cn, formatDate } from '@/lib/utils';

/*
 * The project's saved results, READ-ONLY: business research reports, strategies, campaigns, and the Marketing Audits made before V4 (no audit is
 * run any more). Nothing here starts or reruns a stage: a new campaign is made only with "Generate campaign".
 */

type Kind = 'campaign' | 'strategy' | 'report' | 'audit';
interface Row {
  kind: Kind;
  id: string;
  title: string;
  createdAt: string;
  note: string | null;
}

const KIND_LABEL: Record<Kind, { label: string; tone: string }> = {
  campaign: { label: 'Campaign', tone: 'bg-accent-soft text-accent-hover' },
  strategy: { label: 'Marketing strategy', tone: 'bg-violet-100 text-violet-800' },
  report: { label: 'Business research', tone: 'bg-sky-100 text-sky-800' },
  audit: { label: 'Marketing audit (historical)', tone: 'bg-cream-200 text-ink-600' },
};

function Opened({ row }: { row: Row }) {
  const report = useReport(row.kind === 'report' ? row.id : null);
  const strategy = useStrategy(row.kind === 'strategy' ? row.id : null);
  const audit = useAudit(row.kind === 'audit' ? row.id : null);
  if (row.kind === 'campaign') return <CampaignResult campaignId={row.id} />;
  const q = row.kind === 'report' ? report : row.kind === 'strategy' ? strategy : audit;
  if (q.isLoading) return <div className="h-32 animate-pulse rounded-xl bg-cream-200" />;
  if (!q.data) return <p className="text-sm text-red-700">This result could not be loaded.</p>;
  if (row.kind === 'report') return <ReportView data={report.data!} />;
  if (row.kind === 'strategy') return <StrategyReportView data={strategy.data!} />;
  return <AuditReportView data={audit.data!} />;
}

export function CampaignHistory({ projectId }: { projectId: string }) {
  const campaigns = useCampaigns(projectId);
  const strategies = useStrategies(projectId);
  const reports = useReports(projectId);
  const audits = useAudits(projectId);
  const [open, setOpen] = React.useState<string | null>(null);
  const rows: Row[] = [
    ...(campaigns.data ?? []).map((c) => ({ kind: 'campaign' as const, id: c.id, title: c.campaignName, createdAt: c.createdAt, note: c.deliverables ? `${c.deliverables.delivered} of ${c.deliverables.planned} deliverables` : c.schemaVersion < 2 ? 'made before V4' : c.status })),
    ...(strategies.data ?? []).map((s) => ({ kind: 'strategy' as const, id: s.id, title: s.executiveSummary.slice(0, 120) || 'Strategy', createdAt: s.createdAt, note: s.partial ? 'partial' : null })),
    ...(reports.data ?? []).map((r) => ({ kind: 'report' as const, id: r.id, title: `Business research (${r.model})`, createdAt: r.createdAt, note: null })),
    ...(audits.data ?? []).map((a) => ({ kind: 'audit' as const, id: a.id, title: `Marketing audit (${a.model})`, createdAt: a.createdAt, note: 'historical, read-only' })),
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const loading = campaigns.isLoading || strategies.isLoading || reports.isLoading || audits.isLoading;

  return (
    <section data-testid="campaign-history" aria-label="History" className="space-y-3">
      <h2 className="flex items-center gap-2 text-2xl">
        <History className="h-5 w-5" /> History
      </h2>
      <p className="text-sm text-muted">Everything saved for this project, newest first. Read-only: generate a new campaign to produce new work.</p>
      {loading && <div className="h-32 animate-pulse rounded-2xl bg-cream-200" />}
      {!loading && rows.length === 0 && <p className="rounded-xl border border-dashed border-cream-300 px-4 py-6 text-center text-sm text-muted">Nothing saved yet.</p>}
      <ul className="space-y-2">
        {rows.map((r) => {
          const key = `${r.kind}:${r.id}`;
          const isOpen = open === key;
          return (
            <li key={key} data-kind={r.kind} className="rounded-2xl border border-cream-300/80 bg-cream-50">
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : key)} className={cn('flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left text-sm', isOpen && 'border-b border-cream-300/80')}>
                <Badge className={KIND_LABEL[r.kind].tone}>{KIND_LABEL[r.kind].label}</Badge>
                <span className="min-w-0 flex-1 truncate font-medium">{r.title}</span>
                {r.note && <span className="text-xs text-muted">{r.note}</span>}
                <span className="text-xs text-muted">{formatDate(r.createdAt)}</span>
              </button>
              {isOpen && (
                <div className="p-4">
                  <Opened row={r} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
