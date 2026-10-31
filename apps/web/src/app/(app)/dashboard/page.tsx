'use client';

import Link from 'next/link';
import { ArrowRight, Bot, FolderKanban, Layers, Plug, Plus, Rocket, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { ProjectStatusBadge } from '@/components/project-status-badge';
import { PipelineBadge } from '@/components/pipeline-ui';
import { ProviderIcon, STATUS_META } from '@/components/integration-card';
import { StatCard } from '@/components/stat-card';
import { useActivity, useMe, useMyIntegrations, useProjects, useProviders } from '@/lib/hooks';
import { formatDate } from '@/lib/utils';
import { cn } from '@/lib/utils';

const EVENT_LABELS: Record<string, string> = {
  'project.created': 'Created a project',
  'project.updated': 'Updated a project',
  'project.deleted': 'Deleted a project',
  'intake.saved': 'Saved product intake',
  'asset.uploaded': 'Uploaded assets',
  'asset.deleted': 'Removed an asset',
  'integration.configured': 'Configured an integration',
  'integration.connected': 'Connected an integration',
  'integration.disconnected': 'Disconnected an integration',
  'credential.saved': 'Saved an API key',
  'credential.default_changed': 'Changed the default AI provider',
  'credential.removed': 'Removed an API key',
  'user.login': 'Signed in',
  'user.registered': 'Created the account',
};

export default function DashboardPage() {
  const me = useMe();
  const projects = useProjects();
  const mine = useMyIntegrations();
  const providers = useProviders();
  const activity = useActivity(6);

  const list = projects.data ?? [];
  const integrations = mine.data?.integrations ?? [];
  const connected = integrations.filter((i) => i.status === 'CONNECTED' || i.status === 'CONFIGURED').length;
  const defaultKey = mine.data?.defaultAiProvider;
  const defaultProvider = providers.data?.find((p) => p.key === defaultKey);
  const latest = list[0];
  const firstName = me.data?.name.split(' ')[0] ?? '';

  return (
    <div className="space-y-8">
      {/* Welcome */}
      <section className="panel-dark grain relative overflow-hidden p-8 sm:p-10">
        <div className="absolute -right-16 -top-16 h-64 w-64 rounded-full bg-accent/25 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">Dashboard</p>
            <h1 className="mt-3 text-4xl text-cream-100 sm:text-5xl">
              Welcome back{firstName ? `, ${firstName}` : ''}.
            </h1>
            <p className="mt-3 max-w-lg text-[15px] text-muted-dark">
              Your briefs, integrations and AI settings in one place. Agents will plug into this workspace in the next phase.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/projects/new"><Plus className="h-4 w-4" /> New project</Link>
            </Button>
            {latest && (
              <Button asChild variant="outline-dark">
                <Link href={`/projects/${latest.id}/workspace`}><Layers className="h-4 w-4" /> Open workspace</Link>
              </Button>
            )}
            <Button asChild variant="outline-dark">
              <Link href="/settings/integrations"><Plug className="h-4 w-4" /> Configure integrations</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Summary */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Projects" value={projects.isLoading ? '–' : list.length} icon={FolderKanban} hint="Total campaigns" />
        <StatCard
          label="Ready to run"
          value={projects.isLoading ? '–' : list.filter((p) => p.status === 'READY' && !p.pipeline?.completed && !p.pipeline?.running).length}
          icon={Rocket}
          hint="Briefs no phase has run on yet"
        />
        <StatCard label="Integrations" value={mine.isLoading ? '–' : connected} icon={Plug} hint={`of ${providers.data?.length ?? 9} available`} />
        <StatCard
          label="Default AI"
          value={<span className="text-3xl">{defaultProvider?.name ?? 'None'}</span>}
          icon={Sparkles}
          hint={defaultProvider ? 'Used by all agents later' : 'Add an API key to enable'}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        {/* Recent projects */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Recent projects</CardTitle>
              <CardDescription>Pick up where you left off.</CardDescription>
            </div>
            <Button asChild size="sm" variant="ghost"><Link href="/projects">View all <ArrowRight className="h-3.5 w-3.5" /></Link></Button>
          </CardHeader>
          <CardContent>
            {projects.isLoading ? (
              <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-cream-200" />)}</div>
            ) : list.length === 0 ? (
              <EmptyState
                icon={FolderKanban}
                title="No projects yet"
                description="Create your first project to capture a product brief."
                action={<Button asChild><Link href="/projects/new"><Plus className="h-4 w-4" /> New project</Link></Button>}
              />
            ) : (
              <ul className="divide-y divide-cream-300/70">
                {list.slice(0, 5).map((p) => (
                  <li key={p.id}>
                    <Link href={`/projects/${p.id}`} className="-mx-3 flex items-center gap-4 rounded-xl px-3 py-3.5 transition-colors hover:bg-cream-100">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink font-serif text-lg text-accent">
                        {p.name[0]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{p.name}</span>
                        <span className="block truncate text-xs text-muted">Updated {formatDate(p.updatedAt)}</span>
                      </span>
                      <span className="flex flex-col items-end gap-1.5">
                        <ProjectStatusBadge status={p.status} />
                        <PipelineBadge summary={p.pipeline} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          {/* Integration overview */}
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Integrations</CardTitle>
                <CardDescription>{connected} active</CardDescription>
              </div>
              <Button asChild size="sm" variant="ghost"><Link href="/settings/integrations">Manage</Link></Button>
            </CardHeader>
            <CardContent className="space-y-1">
              {(providers.data ?? []).map((p) => {
                const status = integrations.find((i) => i.providerKey === p.key)?.status ?? 'NOT_CONNECTED';
                const meta = STATUS_META[status];
                return (
                  <div key={p.key} className="flex items-center gap-3 py-1.5">
                    <ProviderIcon providerKey={p.key} className="h-8 w-8 rounded-lg [&>svg]:h-4 [&>svg]:w-4" />
                    <span className="flex-1 text-sm">{p.name}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted">
                      <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
                      {meta.label}
                    </span>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Default provider */}
          <Card className="p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent-hover"><Bot className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{defaultProvider ? `${defaultProvider.name} is your default` : 'No default AI provider'}</p>
                <p className="text-xs text-muted">Agents will use your own key.</p>
              </div>
            </div>
            <Button asChild variant="outline" size="sm" className="mt-4 w-full"><Link href="/settings/providers">AI provider settings</Link></Button>
          </Card>
        </div>
      </div>

      {/* Activity */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>The last things that happened in your account.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {(activity.data ?? []).length === 0 ? (
            <p className="text-sm text-muted">Nothing yet.</p>
          ) : (
            <ul className="space-y-3">
              {activity.data!.map((a) => (
                <li key={a.id} className="flex items-center gap-3 text-sm">
                  <span className="h-2 w-2 rounded-full bg-accent" />
                  <span className="flex-1">{EVENT_LABELS[a.eventType] ?? a.eventType}</span>
                  <span className="text-xs text-muted">{formatDate(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
