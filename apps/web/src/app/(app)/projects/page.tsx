'use client';

import Link from 'next/link';
import * as React from 'react';
import { ArrowUpRight, FolderKanban, Layers, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { EmptyState } from '@/components/empty-state';
import { ProjectStatusBadge } from '@/components/project-status-badge';
import { SectionHeader } from '@/components/section-header';
import { useDeleteProject, useProjects } from '@/lib/hooks';
import { MARKETING_GOALS, PROJECT_STATUS } from '@/lib/constants';
import { formatDate } from '@/lib/utils';
import type { ProjectStatus } from '@/lib/types';

export default function ProjectsPage() {
  const projects = useProjects();
  const del = useDeleteProject();
  const toast = useToast();
  const [q, setQ] = React.useState('');
  const [status, setStatus] = React.useState<ProjectStatus | 'ALL'>('ALL');

  const filtered = (projects.data ?? []).filter(
    (p) => (status === 'ALL' || p.status === status) && p.name.toLowerCase().includes(q.toLowerCase()),
  );

  function remove(id: string, name: string) {
    if (!window.confirm(`Delete "${name}"? This also removes its assets and notes.`)) return;
    del.mutate(id, {
      onSuccess: () => toast.success('Project deleted'),
      onError: (e) => toast.error(e.message),
    });
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Projects"
        title="Your campaigns"
        description="Every product you brief becomes a project with its own workspace."
        actions={
          <Button asChild>
            <Link href="/projects/new"><Plus className="h-4 w-4" /> New project</Link>
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input className="pl-10" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(['ALL', ...Object.keys(PROJECT_STATUS)] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s as ProjectStatus | 'ALL')}
              className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
                status === s ? 'bg-ink text-cream-100' : 'bg-cream-200/70 text-ink-600 hover:bg-cream-200'
              }`}
            >
              {s === 'ALL' ? 'All' : PROJECT_STATUS[s as ProjectStatus].label}
            </button>
          ))}
        </div>
      </div>

      {projects.isLoading ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-cream-200" />)}</div>
      ) : projects.isError ? (
        <p className="text-sm text-red-600">Could not load projects: {projects.error.message}</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title={projects.data?.length ? 'No projects match your filters' : 'No projects yet'}
          description={projects.data?.length ? 'Try a different search or status.' : 'Create a project to start your first brief.'}
          action={!projects.data?.length && <Button asChild><Link href="/projects/new"><Plus className="h-4 w-4" /> New project</Link></Button>}
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[2.2fr_1fr_1fr_1fr_auto] gap-4 border-b border-cream-300/80 bg-cream-100/60 px-6 py-3 text-xs font-medium uppercase tracking-wider text-muted md:grid">
            <span>Project</span><span>Status</span><span>Goal</span><span>Updated</span><span className="w-24" />
          </div>
          <ul className="divide-y divide-cream-300/70">
            {filtered.map((p) => (
              <li key={p.id} className="group grid items-center gap-3 px-6 py-4 transition-colors hover:bg-cream-100/70 md:grid-cols-[2.2fr_1fr_1fr_1fr_auto] md:gap-4">
                <Link href={`/projects/${p.id}`} className="flex min-w-0 items-center gap-4">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-ink font-serif text-xl text-accent">{p.name[0]}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{p.name}</span>
                    <span className="block truncate text-xs text-muted">{p.description || 'No description'}</span>
                  </span>
                </Link>
                <span><ProjectStatusBadge status={p.status} /></span>
                <span className="text-sm text-ink-600">
                  {MARKETING_GOALS.find((g) => g.value === p.intake?.marketingGoal)?.label ?? '–'}
                </span>
                <span className="text-sm text-muted">{formatDate(p.updatedAt)}</span>
                <span className="flex w-24 justify-end gap-1">
                  <Button asChild size="icon" variant="ghost" aria-label="Open workspace">
                    <Link href={`/projects/${p.id}/workspace`}><Layers className="h-4 w-4" /></Link>
                  </Button>
                  <Button asChild size="icon" variant="ghost" aria-label="Open project">
                    <Link href={`/projects/${p.id}`}><ArrowUpRight className="h-4 w-4" /></Link>
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Delete project" onClick={() => remove(p.id, p.name)} className="text-muted hover:text-red-600">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
