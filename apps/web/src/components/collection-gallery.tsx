'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { CollectionCard } from '@/components/collection-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form';
import { CLASS_LABELS, type FormatClass } from '@/lib/hybrid';
import { useProjects } from '@/lib/hooks';
import { PALETTE_ROLES, ROLE_LABELS, collectionPreviewUrl, isHex, useCollections, useProjectDesign, type CollectionData, type DesignPalette, type PaletteRole } from '@/lib/visual';
import { cn } from '@/lib/utils';

/**
 * The Templates page: ten collections, each a complete design language. Browsing only: the colors you try here are NOT stored anywhere and no
 * campaign setting is created here. "Use in a campaign" opens the campaign design of a project, which is the one place where the choice is made.
 */

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function UseInCampaign({ c }: { c: CollectionData }) {
  const projects = useProjects();
  const [projectId, setProjectId] = React.useState('');
  const list = projects.data ?? [];
  React.useEffect(() => {
    if (!projectId && list.length) setProjectId(list[0].id);
  }, [list, projectId]);
  const design = useProjectDesign(projectId || '');
  const selectedThere = !!projectId && design.data?.draft?.collectionId === c.id;
  return (
    <div data-testid="use-in-campaign" className="space-y-2 rounded-xl bg-cream-100 p-3 text-sm">
      <p className="font-medium text-ink">Use {c.name} in a campaign</p>
      {list.length === 0 ? (
        <p className="text-xs text-muted">Create a project first; its campaign design is where a collection is chosen.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Project" className="h-9 w-56 text-xs" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Button asChild size="sm" disabled={!projectId}>
            <Link data-testid="use-collection" href={`/projects/${projectId}/campaign?collection=${c.id}`}>
              Choose in the campaign design <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
          {selectedThere && (
            <Badge data-testid="selected-for-campaign" className="bg-emerald-100 text-emerald-800">
              Currently selected in this project&apos;s campaign design
            </Badge>
          )}
        </div>
      )}
      <p className="text-xs text-muted">The collection and its colors are saved in the project&apos;s campaign design, never on this page.</p>
    </div>
  );
}

function CollectionDetail({ c, onBack }: { c: CollectionData; onBack: () => void }) {
  const [palette, setPalette] = React.useState<DesignPalette>({ ...c.defaultPalette });
  const [cls, setCls] = React.useState<FormatClass>(c.supportedClasses.includes('square') ? 'square' : c.supportedClasses[0]);
  React.useEffect(() => {
    setPalette({ ...c.defaultPalette });
    setCls(c.supportedClasses.includes('square') ? 'square' : c.supportedClasses[0]);
  }, [c]);
  const shown = useDebounced(palette, 200);
  const edited = PALETTE_ROLES.some((r) => palette[r].toLowerCase() !== c.defaultPalette[r].toLowerCase());
  const templates = c.templates.filter((t) => t.classes.includes(cls));
  return (
    <div data-testid="collection-detail" className="space-y-5">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> All collections
      </button>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          {String(c.number).padStart(2, '0')} · {c.designCategory} · version {c.version}
        </p>
        <h2 className="text-3xl">{c.name}</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-600">{c.description}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-1 rounded-xl border border-cream-300/80 bg-cream-50 p-3 text-xs">
          <p className="font-semibold text-ink">Typography</p>
          <p className="text-muted">{c.typographySystem}</p>
        </div>
        <div className="space-y-1 rounded-xl border border-cream-300/80 bg-cream-50 p-3 text-xs">
          <p className="font-semibold text-ink">Layout principles</p>
          <ul className="list-disc pl-4 text-muted">
            {c.layoutPrinciples.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
        <div className="space-y-1 rounded-xl border border-cream-300/80 bg-cream-50 p-3 text-xs">
          <p className="font-semibold text-ink">Pictures and decoration</p>
          <p className="text-muted">{c.imageTreatment}</p>
          <p className="text-muted">{c.decorativeSystem}</p>
        </div>
      </div>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Try colors (browsing only: nothing is saved)</h3>
        <div data-testid="gallery-palette" className="flex flex-wrap items-center gap-3">
          {PALETTE_ROLES.map((r: PaletteRole) => (
            <label key={r} className="flex items-center gap-1.5 text-xs text-muted">
              {ROLE_LABELS[r]}
              <input
                type="color"
                data-testid={`gallery-color-${r}`}
                aria-label={`${ROLE_LABELS[r]} color`}
                value={palette[r]}
                onChange={(e) => isHex(e.target.value) && setPalette((p) => ({ ...p, [r]: e.target.value.toLowerCase() }))}
                className="h-8 w-10 cursor-pointer rounded-md border border-cream-300 bg-transparent p-0.5"
              />
            </label>
          ))}
          <Button type="button" size="sm" variant="outline" data-testid="gallery-reset" disabled={!edited} onClick={() => setPalette({ ...c.defaultPalette })}>
            Reset to the collection colors
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Preview format">
          {c.supportedClasses.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={cls === k} data-testid={`gallery-class-${k}`} onClick={() => setCls(k)} className={cn('rounded-full border px-3 py-1 text-xs', cls === k ? 'border-accent bg-accent-soft/50 font-medium text-ink' : 'border-cream-300 bg-cream-50 text-muted hover:text-ink')}>
              {CLASS_LABELS[k]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted">Drawn by LaunchPilot&apos;s own renderer with sample text and a placeholder picture. In a campaign your copy, your picture and your logo are used.</p>
        <div data-testid="gallery-previews" className="flex items-end gap-3 overflow-x-auto rounded-xl bg-cream-200/70 p-3">
          {templates.map((t) => (
            <figure key={t.id} className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={collectionPreviewUrl(c.id, { template: t.id, class: cls, palette: shown })} alt={`${c.name}: ${t.name} (${CLASS_LABELS[cls]})`} loading="lazy" className="h-60 w-auto rounded-md bg-white object-contain shadow" />
              <figcaption className="mt-1 max-w-[16rem] text-[11px] text-muted">
                <strong className="block truncate text-ink" title={t.name}>
                  {t.name}
                </strong>
                {t.roles.length > 0 ? t.roles.join(', ') : t.family}
                {t.requires.some((r) => !['image', 'logo', 'headline', 'support', 'cta', 'eyebrow', 'brand'].includes(r)) ? ' · needs details only you can give' : ''}
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1 text-xs">
          <p className="font-semibold text-ink">Formats this collection draws</p>
          <div className="flex flex-wrap gap-1">
            {c.supportedFormats.map((f) => (
              <Badge key={f.id} className="bg-cream-200 px-2 py-0.5 text-[10px] text-ink-600">
                {f.label}
              </Badge>
            ))}
          </div>
        </div>
        <div className="space-y-1 text-xs">
          <p className="font-semibold text-ink">Suits</p>
          <p className="text-muted">Industries: {c.industries.join(', ')}.</p>
          <p className="text-muted">Audiences: {c.audiences.join('; ')}.</p>
        </div>
      </section>

      <UseInCampaign c={c} />
    </div>
  );
}

export function CollectionGallery() {
  const collections = useCollections();
  const [openId, setOpenId] = React.useState<string | null>(null);
  const list = collections.data?.items ?? [];
  const open = list.find((c) => c.id === openId);
  if (collections.isLoading) return <div className="h-64 animate-pulse rounded-2xl bg-cream-200" />;
  if (collections.isError) return <p className="text-sm text-red-700">The template collections could not be loaded.</p>;
  if (open) return <CollectionDetail c={open} onBack={() => setOpenId(null)} />;
  return (
    <div data-testid="collection-gallery" className="space-y-3">
      <p className="text-sm text-ink-600">Ten complete design languages. Open one to see its templates, try colors and use it in a campaign.</p>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((c) => (
          <CollectionCard key={c.id} c={c} onSelect={() => setOpenId(c.id)} testId={`gallery-collection-${c.id}`} />
        ))}
      </div>
    </div>
  );
}
