'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Brain,
  CalendarRange,
  Compass,
  Download,
  FileSearch,
  Lock,
  Palette,
  Play,
  Plug,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { ProductDiscoveryPanel } from '@/components/product-discovery-panel';
import { RuntimeTestPanel } from '@/components/runtime-test-panel';
import { ProjectStatusBadge } from '@/components/project-status-badge';
import { STATUS_META } from '@/components/integration-card';
import { useMyIntegrations, useProject, useProviders } from '@/lib/hooks';
import { FORMAT_OPTIONS, LANGUAGES, MARKETING_GOALS, STYLES } from '@/lib/constants';
import { cn } from '@/lib/utils';

// PLACEHOLDER stages: each becomes an agent output panel in a later phase.
const STAGES: { key: string; title: string; icon: LucideIcon; empty: string; needs?: string }[] = [
  { key: 'intelligence', title: 'Product Intelligence', icon: Brain, empty: 'Positioning, value props and competitor context extracted from your brief.' },
  { key: 'audit', title: 'Audit', icon: FileSearch, empty: 'SEO and presence audit of your website and social profiles.', needs: 'enableSeoAudit' },
  { key: 'strategy', title: 'Strategy', icon: Compass, empty: 'Messaging pillars, channel plan and the seasonal content calendar.' },
  { key: 'creative', title: 'Creative Output', icon: Palette, empty: 'Copy and visuals for every format you selected.' },
  { key: 'export', title: 'Export', icon: Download, empty: 'Hand-off to Drive or download the campaign pack.', needs: 'enableGoogleDriveExport' },
];

export default function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const project = useProject(id);
  const mine = useMyIntegrations();
  const providers = useProviders();

  if (project.isLoading) return <div className="h-96 animate-pulse rounded-3xl bg-cream-200" />;
  if (!project.data) {
    return <EmptyState icon={TriangleAlert} title="Project not found" action={<Button asChild><Link href="/projects">Back to projects</Link></Button>} />;
  }
  const p = project.data;
  const intake = p.intake;
  const flags = intake as unknown as Record<string, boolean> | null;
  const connected = (mine.data?.integrations ?? []).filter((i) => i.status === 'CONNECTED' || i.status === 'CONFIGURED');

  return (
    <div className="space-y-8">
      <Link href={`/projects/${id}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> {p.name}
      </Link>

      {/* Banner */}
      <div role="status" className="flex items-start gap-3 rounded-2xl border border-amber-300/70 bg-amber-50 px-5 py-4 text-sm text-amber-900">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <p><strong className="font-semibold">Full campaign generation is not enabled yet.</strong> Product Discovery (a text-only AI analysis of your idea) is available below; the audit, strategy, creative and export stages are still to come.</p>
      </div>

      {/* Hero */}
      <section className="panel-dark grain relative overflow-hidden p-8 sm:p-10">
        <div className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-accent/25 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">Campaign workspace</p>
            <h1 className="mt-3 text-4xl text-cream-100 sm:text-5xl">{p.name}</h1>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <ProjectStatusBadge status={p.status} />
              <span className="text-sm text-muted-dark">{MARKETING_GOALS.find((g) => g.value === intake?.marketingGoal)?.label ?? 'No goal set'}</span>
            </div>
          </div>
          <Button disabled title="Agents are not available yet" size="lg">
            <Lock className="h-4 w-4" /> <Play className="h-4 w-4" /> Run campaign
          </Button>
        </div>

        {/* Pipeline */}
        <ol className="relative mt-10 grid gap-3 sm:grid-cols-5">
          {STAGES.map((s, i) => (
            <li key={s.key} className="flex items-center gap-3 rounded-2xl bg-white/[0.06] px-4 py-3 ring-1 ring-white/10">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-accent"><s.icon className="h-4 w-4" /></span>
              <span className="min-w-0">
                <span className="block text-[10px] uppercase tracking-wider text-muted-dark">Stage {i + 1}</span>
                <span className="block truncate text-sm text-cream-100">{s.title}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Stage panels */}
        <div className="grid gap-4 sm:grid-cols-2">
          {STAGES.map((s) => {
            const disabledByToggle = s.needs && flags && !flags[s.needs];
            return (
              <Card key={s.key} className={cn(s.key === 'creative' && 'sm:col-span-2')}>
                <CardHeader className="items-center">
                  <CardTitle className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink text-accent"><s.icon className="h-4 w-4" /></span>
                    {s.title}
                  </CardTitle>
                  <span className="rounded-full bg-cream-200 px-2.5 py-1 text-[11px] font-medium text-muted">
                    {disabledByToggle ? 'Turned off' : 'Waiting for agents'}
                  </span>
                </CardHeader>
                <CardContent>
                  <EmptyState
                    icon={s.icon}
                    title="No output yet"
                    description={disabledByToggle ? 'This step is disabled in the project brief.' : s.empty}
                    className="py-8"
                  />
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Side panels */}
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Campaign settings</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row k="Market" v={intake?.targetMarket} />
              <Row k="Language" v={LANGUAGES.find((l) => l.value === intake?.preferredLanguage)?.label} />
              <Row k="Duration" v={intake?.campaignDuration} />
              <Row k="Style" v={STYLES.find((s) => s.value === intake?.stylePreference)?.label} />
              <Row k="Publishing" v={intake?.publishingMode} />
              <div className="border-t border-cream-300/70 pt-3">
                <p className="mb-2 text-xs uppercase tracking-wider text-muted">Formats</p>
                <div className="flex flex-wrap gap-1.5">
                  {p.formats.filter((f) => f.enabled).map((f) => (
                    <span key={f.id} className="rounded-full bg-cream-200 px-2.5 py-1 text-xs">{FORMAT_OPTIONS.find((o) => o.key === f.formatType)?.label}</span>
                  ))}
                  {p.formats.length === 0 && <span className="text-muted">None</span>}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Plug className="h-4 w-4" /> Integrations</CardTitle>
              <Button asChild size="sm" variant="ghost"><Link href="/settings/integrations">Manage</Link></Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {connected.length === 0 ? (
                <p className="text-sm text-muted">Nothing connected yet.</p>
              ) : (
                connected.map((i) => (
                  <div key={i.providerKey} className="flex items-center justify-between text-sm">
                    <span>{providers.data?.find((x) => x.key === i.providerKey)?.name ?? i.providerKey}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted"><span className={cn('h-1.5 w-1.5 rounded-full', STATUS_META[i.status].dot)} />{STATUS_META[i.status].label}</span>
                  </div>
                ))
              )}
              <p className="flex items-center gap-2 border-t border-cream-300/70 pt-3 text-xs text-muted">
                <CalendarRange className="h-3.5 w-3.5" />
                Default AI: <strong className="text-ink">{providers.data?.find((x) => x.key === mine.data?.defaultAiProvider)?.name ?? 'not set'}</strong>
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      <ProductDiscoveryPanel projectId={id} />

      <RuntimeTestPanel projectId={id} />
    </div>
  );
}

function Row({ k, v }: { k: string; v?: string | null }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted">{k}</span>
      <span className="truncate text-right font-medium capitalize">{v || '–'}</span>
    </div>
  );
}
