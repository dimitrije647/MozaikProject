'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  ExternalLink,
  FileText,
  Globe,
  Layers,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Select, Textarea } from '@/components/ui/form';
import { useToast } from '@/components/ui/toast';
import { EmptyState } from '@/components/empty-state';
import { ProjectStatusBadge } from '@/components/project-status-badge';
import { api } from '@/lib/api';
import {
  keys,
  useCreateNote,
  useDeleteAsset,
  useDeleteNote,
  useDeleteProject,
  useProject,
  useUpdateNote,
  useUpdateProject,
} from '@/lib/hooks';
import { FORMAT_OPTIONS, LANGUAGES, MARKETING_GOALS, PROJECT_STATUS, SOCIAL_PLATFORMS, STYLES } from '@/lib/constants';
import type { Asset, Note, ProjectDetail, ProjectStatus } from '@/lib/types';
import { cn, formatBytes, formatDate } from '@/lib/utils';

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const project = useProject(id);
  const update = useUpdateProject(id);
  const del = useDeleteProject();

  if (project.isLoading) return <div className="h-96 animate-pulse rounded-3xl bg-cream-200" />;
  if (project.isError || !project.data) {
    return (
      <EmptyState
        icon={X}
        title="Project not found"
        description="It may have been deleted, or you do not have access to it."
        action={<Button asChild><Link href="/projects">Back to projects</Link></Button>}
      />
    );
  }
  const p = project.data;
  const intake = p.intake;

  function setStatus(status: ProjectStatus) {
    update.mutate({ status }, { onSuccess: () => toast.success('Status updated'), onError: (e) => toast.error(e.message) });
  }
  function remove() {
    if (!window.confirm(`Delete "${p.name}"? This also removes its assets and notes.`)) return;
    del.mutate(id, {
      onSuccess: () => {
        toast.success('Project deleted');
        router.replace('/projects');
      },
      onError: (e) => toast.error(e.message),
    });
  }

  return (
    <div className="space-y-8">
      <Link href="/projects" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> All projects
      </Link>

      {/* Overview */}
      <section className="panel-dark grain relative overflow-hidden p-8 sm:p-10">
        <div className="absolute -right-16 -top-16 h-60 w-60 rounded-full bg-accent/20 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <ProjectStatusBadge status={p.status} />
              <span className="text-xs text-muted-dark">Created {formatDate(p.createdAt)} · Updated {formatDate(p.updatedAt)}</span>
            </div>
            <h1 className="mt-4 text-4xl text-cream-100 sm:text-5xl">{p.name}</h1>
            <p className="mt-3 max-w-2xl text-[15px] text-muted-dark">{p.description || intake?.shortDescription || 'No description yet.'}</p>
            <div className="mt-5 flex flex-wrap gap-2 text-sm">
              {intake?.websiteUrl && <ExtLink href={intake.websiteUrl} label="Website" />}
              {intake?.githubUrl && <ExtLink href={intake.githubUrl} label="GitHub" />}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Button asChild><Link href={`/projects/${id}/workspace`}><Layers className="h-4 w-4" /> Open workspace</Link></Button>
            <Select
              aria-label="Project status"
              value={p.status}
              onChange={(e) => setStatus(e.target.value as ProjectStatus)}
              className="h-10 rounded-full border-white/15 bg-white/10 text-cream-100 [&>option]:text-ink"
            >
              {(Object.keys(PROJECT_STATUS) as ProjectStatus[]).map((s) => (
                <option key={s} value={s}>{PROJECT_STATUS[s].label}</option>
              ))}
            </Select>
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-6">
          {/* Intake summary */}
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Intake summary</CardTitle>
                <CardDescription>The brief your agents will work from.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              {intake ? (
                <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
                  <Item label="Product" value={intake.productName} />
                  <Item label="Main goal" value={MARKETING_GOALS.find((g) => g.value === intake.marketingGoal)?.label} />
                  <Item label="Target market" value={intake.targetMarket} />
                  <Item label="Language" value={LANGUAGES.find((l) => l.value === intake.preferredLanguage)?.label} />
                  <Item label="Duration" value={intake.campaignDuration} />
                  <Item label="Visual style" value={STYLES.find((s) => s.value === intake.stylePreference)?.label} />
                  <Item label="Target audience" value={intake.targetAudience} className="sm:col-span-2" />
                  <Item label="Description" value={intake.shortDescription} className="sm:col-span-2" />
                </dl>
              ) : (
                <EmptyState icon={FileText} title="No intake saved" description="This project has no product brief yet." />
              )}
            </CardContent>
          </Card>

          <AssetsCard project={p} />
          <NotesCard project={p} />
        </div>

        <div className="space-y-6">
          {/* Feature toggles */}
          <Card>
            <CardHeader><CardTitle>Features</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Flag label="SEO audit" on={intake?.enableSeoAudit} />
              <Flag label="Seasonal calendar" on={intake?.enableSeasonalCalendar} />
              <Flag label="Google Drive export" on={intake?.enableGoogleDriveExport} />
              <div className="flex items-center justify-between border-t border-cream-300/70 pt-3 text-sm">
                <span className="text-muted">Publishing</span>
                <span className="font-medium capitalize">{intake?.publishingMode ?? 'manual'}</span>
              </div>
            </CardContent>
          </Card>

          {/* Formats */}
          <Card>
            <CardHeader><CardTitle>Campaign formats</CardTitle></CardHeader>
            <CardContent>
              {p.formats.filter((f) => f.enabled).length === 0 ? (
                <p className="text-sm text-muted">No formats selected.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {p.formats.filter((f) => f.enabled).map((f) => (
                    <span key={f.id} className="rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-cream-100">
                      {FORMAT_OPTIONS.find((o) => o.key === f.formatType)?.label ?? f.formatType}
                    </span>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Socials */}
          <Card>
            <CardHeader><CardTitle>Social profiles</CardTitle></CardHeader>
            <CardContent>
              {p.socials.length === 0 ? (
                <p className="text-sm text-muted">No profiles linked.</p>
              ) : (
                <ul className="space-y-2.5">
                  {p.socials.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 text-sm">
                      <Globe className="h-4 w-4 shrink-0 text-muted" />
                      <span className="w-20 shrink-0 font-medium">{SOCIAL_PLATFORMS.find((x) => x.key === s.platform)?.label ?? s.platform}</span>
                      <a href={s.url} target="_blank" rel="noreferrer noopener" className="min-w-0 flex-1 truncate text-muted hover:text-accent">{s.url}</a>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Future workspace */}
          <Card className="overflow-hidden">
            <div className="panel-dark grain rounded-none p-6">
              <Layers className="h-6 w-6 text-accent" />
              <p className="mt-4 font-serif text-2xl text-cream-100">Campaign workspace</p>
              <p className="mt-1 text-sm text-muted-dark">Intelligence, audit, strategy, creative and export will appear here once agents are enabled.</p>
              <Button asChild variant="primary" size="sm" className="mt-5"><Link href={`/projects/${id}/workspace`}>Open workspace</Link></Button>
            </div>
          </Card>

          <Button variant="danger" size="sm" onClick={remove} loading={del.isPending} className="w-full">
            <Trash2 className="h-3.5 w-3.5" /> Delete project
          </Button>
        </div>
      </div>
    </div>
  );
}

function ExtLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-cream-100 transition-colors hover:bg-white/10">
      {label} <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

function Item({ label, value, className }: { label: string; value?: string | null; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-xs uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap">{value || <span className="text-muted-dark">Not provided</span>}</dd>
    </div>
  );
}

function Flag({ label, on }: { label: string; on?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span>{label}</span>
      <span className={cn('flex items-center gap-1.5 text-xs font-medium', on ? 'text-emerald-700' : 'text-muted')}>
        {on ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
        {on ? 'On' : 'Off'}
      </span>
    </div>
  );
}

function AssetsCard({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const del = useDeleteAsset(project.id);
  const input = React.useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async (files: FileList) => {
      const body = new FormData();
      Array.from(files).forEach((f) => body.append('files', f));
      return api(`/projects/${project.id}/assets`, { method: 'POST', body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.project(project.id) });
      toast.success('Uploaded');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Uploaded assets</CardTitle>
          <CardDescription>{project.assets.length} file{project.assets.length === 1 ? '' : 's'}</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => input.current?.click()} loading={upload.isPending}>
          <Upload className="h-3.5 w-3.5" /> Upload
        </Button>
        <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && upload.mutate(e.target.files)} />
      </CardHeader>
      <CardContent>
        {project.assets.length === 0 ? (
          <EmptyState icon={FileText} title="No assets yet" description="Logos, screenshots and brand material help the creative agents." />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {project.assets.map((a: Asset) => (
              <li key={a.id} className="group flex items-center gap-3 rounded-xl border border-cream-300/80 bg-cream-50 p-2.5">
                <a href={`/api/assets/${a.id}/file`} target="_blank" rel="noreferrer" className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-cream-200">
                  {a.mimeType.startsWith('image/') ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/assets/${a.id}/file`} alt={a.originalName} className="h-full w-full object-cover" />
                  ) : (
                    <FileText className="h-5 w-5 text-muted" />
                  )}
                </a>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{a.originalName}</p>
                  <p className="text-xs capitalize text-muted">{a.type} · {formatBytes(a.fileSize)}</p>
                </div>
                <button
                  aria-label={`Delete ${a.originalName}`}
                  onClick={() => del.mutate(a.id, { onError: (e) => toast.error(e.message) })}
                  className="rounded-lg p-2 text-muted opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function NotesCard({ project }: { project: ProjectDetail }) {
  const toast = useToast();
  const create = useCreateNote(project.id);
  const updateNote = useUpdateNote(project.id);
  const del = useDeleteNote(project.id);
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState({ title: '', content: '' });

  function startAdd() {
    setDraft({ title: '', content: '' });
    setEditing(null);
    setAdding(true);
  }
  function startEdit(n: Note) {
    setDraft({ title: n.title, content: n.content });
    setAdding(false);
    setEditing(n.id);
  }
  function save() {
    const onSuccess = () => {
      setAdding(false);
      setEditing(null);
    };
    const onError = (e: Error) => toast.error(e.message);
    if (editing) updateNote.mutate({ id: editing, ...draft }, { onSuccess, onError });
    else create.mutate(draft, { onSuccess, onError });
  }

  const editor = (
    <div className="space-y-3 rounded-xl border border-accent/40 bg-cream-50 p-4">
      <Input placeholder="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus />
      <Textarea placeholder="Write a note…" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setEditing(null); }}>Cancel</Button>
        <Button size="sm" onClick={save} loading={create.isPending || updateNote.isPending} disabled={!draft.title.trim()}>Save note</Button>
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Notes</CardTitle>
          <CardDescription>Context for you and, later, for the agents.</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={startAdd}><Plus className="h-3.5 w-3.5" /> Add note</Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {adding && editor}
        {project.notes.length === 0 && !adding && (
          <EmptyState icon={Pencil} title="No notes yet" description="Capture brand voice, constraints or ideas." />
        )}
        {project.notes.map((n) =>
          editing === n.id ? (
            <div key={n.id}>{editor}</div>
          ) : (
            <div key={n.id} className="group rounded-xl border border-cream-300/80 bg-cream-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{n.title}</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-ink-600">{n.content}</p>
                  <p className="mt-2 text-xs text-muted">{formatDate(n.updatedAt)}</p>
                </div>
                <div className="flex gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                  <button aria-label="Edit note" onClick={() => startEdit(n)} className="rounded-lg p-2 text-muted hover:bg-cream-200 hover:text-ink"><Pencil className="h-4 w-4" /></button>
                  <button aria-label="Delete note" onClick={() => del.mutate(n.id, { onError: (e) => toast.error(e.message) })} className="rounded-lg p-2 text-muted hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
            </div>
          ),
        )}
      </CardContent>
    </Card>
  );
}
