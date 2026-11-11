'use client';

import * as React from 'react';
import { AlertTriangle, LayoutTemplate, Loader2, PenLine, RotateCcw, Search, Star, X } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/form';
import {
  CATEGORY_LABELS,
  CLASS_LABELS,
  FORMAT_CLASSES,
  STYLE_IDS,
  TEMPLATE_CATEGORIES,
  templatePreviewUrl,
  useFavoriteTemplates,
  useTemplates,
  type FormatClass,
  type StyleId,
  type TemplateCard,
} from '@/lib/hybrid';
import { cn } from '@/lib/utils';
import {
  CHANNEL_LABELS,
  Chip,
  PALETTES,
  PaletteSwitcher,
  TemplateDetailDialog,
  TemplatePreview,
  classFor,
  humanize,
  needsSummary,
  paletteById,
  useStyleNames,
} from '@/components/template-detail';

/*
 * The Template Library gallery. Filters go to GET /templates as query params (category, style, industry, channel, class, q); "favorites
 * only" is applied here because favorites live in this browser only. Previews are same-origin PNGs rendered by the server from each
 * template's own definition; the palette and format controls only change the preview URLs.
 */

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

const FIELD_LABEL = 'mb-1 block text-xs font-medium text-ink-700';

function TemplateCardView({
  t,
  cls,
  paletteId,
  favorite,
  onToggleFavorite,
  onOpen,
}: {
  t: TemplateCard;
  cls: FormatClass;
  paletteId: string;
  favorite: boolean;
  onToggleFavorite: () => void;
  onOpen: () => void;
}) {
  const palette = paletteById(paletteId);
  const src = templatePreviewUrl(t.id, { class: cls, palette: [...palette.colors] });
  const needs = needsSummary(t.requires);
  return (
    <Card className="flex w-full flex-col overflow-hidden transition-shadow hover:shadow-lift">
      <div className="relative">
        <TemplatePreview src={src} cls={cls} alt={`${t.name}, ${CLASS_LABELS[cls]} preview with sample text and a placeholder picture`} />
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open details for ${t.name}`}
          className="absolute inset-0 z-10 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
        />
        <button
          type="button"
          onClick={onToggleFavorite}
          aria-pressed={favorite}
          aria-label={favorite ? `Remove ${t.name} from favorites` : `Add ${t.name} to favorites`}
          title={favorite ? 'In your favorites (saved in this browser only). Click to remove.' : 'Add to favorites. Favorites are saved in this browser only.'}
          className={cn(
            'absolute right-2.5 top-2.5 z-30 flex h-8 w-8 items-center justify-center rounded-full border shadow-soft transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
            favorite ? 'border-amber-300 bg-amber-100 text-amber-600' : 'border-cream-300 bg-cream-50/95 text-ink-600 hover:bg-cream-50 hover:text-amber-600',
          )}
        >
          <Star className={cn('h-4 w-4', favorite && 'fill-current')} aria-hidden="true" />
        </button>
        <span className="pointer-events-none absolute bottom-2.5 left-2.5 z-20 rounded-full bg-ink/80 px-2 py-0.5 text-[11px] font-medium text-cream-100">{CLASS_LABELS[cls]}</span>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-sans text-[15px] font-semibold leading-snug text-ink">{t.name}</h3>
          <span className="shrink-0 text-xs text-muted" title={`Template version ${t.version}`}>
            v{t.version}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge className="bg-accent-soft text-accent-hover">{CATEGORY_LABELS[t.category] ?? humanize(t.category)}</Badge>
          {t.status !== 'active' && <Badge className="bg-cream-300 text-ink-600">{humanize(t.status)}</Badge>}
          {needs && (
            <Badge className="bg-amber-100 text-amber-800" title="Content only you can provide. It is never invented.">
              <PenLine className="h-3 w-3" aria-hidden="true" />
              {needs}
            </Badge>
          )}
        </div>
        <p className="line-clamp-3 text-sm text-muted">{t.description}</p>
        <ul className="mt-auto flex flex-wrap gap-1 pt-1" aria-label="Supported formats">
          {t.classes.map((c) => (
            <li key={c}>
              <Chip className={cn(c === cls && 'bg-ink text-cream-100')}>{CLASS_LABELS[c]}</Chip>
            </li>
          ))}
        </ul>
        <Button variant="outline" size="sm" className="mt-1 w-full" onClick={onOpen}>
          View details
        </Button>
      </div>
    </Card>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-cream-300/80 bg-cream-50">
          <div className="aspect-square animate-pulse bg-cream-200" />
          <div className="space-y-2.5 p-4">
            <div className="h-4 w-2/3 animate-pulse rounded bg-cream-200" />
            <div className="h-3 w-full animate-pulse rounded bg-cream-200" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-cream-200" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function TemplateGallery({
  style,
  onStyleChange,
  onOpenStyle,
}: {
  /** The visual style filter ('' = any). Controlled by the page so the Style library can set it. */
  style: string;
  onStyleChange: (style: string) => void;
  onOpenStyle?: (id: StyleId) => void;
}) {
  const fav = useFavoriteTemplates();
  const styleName = useStyleNames();

  const [category, setCategory] = React.useState('');
  const [qInput, setQInput] = React.useState('');
  const [industryInput, setIndustryInput] = React.useState('');
  const [channel, setChannel] = React.useState('');
  const [format, setFormat] = React.useState<FormatClass | ''>('');
  const [onlySupported, setOnlySupported] = React.useState(true);
  const [favOnly, setFavOnly] = React.useState(false);
  const [paletteId, setPaletteId] = React.useState<string>(PALETTES[0].id);
  const [selected, setSelected] = React.useState<TemplateCard | null>(null);

  const q = useDebounced(qInput.trim(), 250);
  const industry = useDebounced(industryInput.trim(), 250);

  const filters = { category, style, industry, channel, class: format && onlySupported ? format : '', q };
  const list = useTemplates(filters);
  const everything = useTemplates({}); // the whole library: the denominator of the count and the industry suggestions (cached, shared)

  const industries = React.useMemo(() => {
    const set = new Set<string>();
    for (const t of everything.data?.items ?? []) for (const i of t.industries) if (i && i !== '*') set.add(i);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [everything.data]);

  const categories = everything.data?.categories?.length ? everything.data.categories : TEMPLATE_CATEGORIES;
  const items = list.data?.items ?? [];
  const shown = favOnly ? items.filter((t) => fav.has(t.id)) : items;
  const libraryCount = everything.data?.items.length;
  const anyFilter = !!(category || style || industryInput.trim() || channel || qInput.trim() || format || favOnly);

  function clearFilters() {
    setCategory('');
    onStyleChange('');
    setQInput('');
    setIndustryInput('');
    setChannel('');
    setFormat('');
    setOnlySupported(true);
    setFavOnly(false);
  }

  const settling = qInput.trim() !== q || industryInput.trim() !== industry;

  return (
    <div className="space-y-5">
      {/* Filters */}
      <Card className="space-y-4 p-4 sm:p-5">
        <div className="-mx-1 overflow-x-auto px-1">
          <div role="tablist" aria-label="Template category" className="flex min-w-max gap-1 border-b border-cream-300/80">
            {[{ id: '', label: 'All categories' }, ...categories.map((c) => ({ id: c as string, label: CATEGORY_LABELS[c] ?? humanize(c) }))].map((c) => (
              <button
                key={c.id || 'all'}
                role="tab"
                type="button"
                aria-selected={category === c.id}
                onClick={() => setCategory(c.id)}
                className={cn(
                  '-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50',
                  category === c.id ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink',
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="tpl-search" className={FIELD_LABEL}>
              Search
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
              <Input id="tpl-search" type="search" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Name, description, layout" className="pl-10" />
            </div>
          </div>
          <div>
            <label htmlFor="tpl-style" className={FIELD_LABEL}>
              Visual style
            </label>
            <Select id="tpl-style" value={style} onChange={(e) => onStyleChange(e.target.value)}>
              <option value="">Any style</option>
              {STYLE_IDS.map((s) => (
                <option key={s} value={s}>
                  {styleName(s)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="tpl-industry" className={FIELD_LABEL}>
              Industry
            </label>
            <Input id="tpl-industry" list="tpl-industries" value={industryInput} onChange={(e) => setIndustryInput(e.target.value)} placeholder="e.g. restaurant, saas" autoComplete="off" />
            <datalist id="tpl-industries">
              {industries.map((i) => (
                <option key={i} value={i} />
              ))}
            </datalist>
          </div>
          <div>
            <label htmlFor="tpl-channel" className={FIELD_LABEL}>
              Channel
            </label>
            <Select id="tpl-channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">Any channel</option>
              {Object.entries(CHANNEL_LABELS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
          <div>
            <span id="tpl-format-label" className={FIELD_LABEL}>
              Format
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <div role="group" aria-labelledby="tpl-format-label" className="flex flex-wrap gap-1.5">
                {[{ id: '' as const, label: 'Any format' }, ...FORMAT_CLASSES.map((c) => ({ id: c, label: CLASS_LABELS[c] }))].map((c) => (
                  <button
                    key={c.id || 'any'}
                    type="button"
                    aria-pressed={format === c.id}
                    onClick={() => setFormat(c.id)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                      format === c.id ? 'border-ink bg-ink text-cream-100' : 'border-cream-300 bg-cream-50 text-ink-600 hover:bg-cream-200',
                    )}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              {format && (
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-600">
                  <input type="checkbox" checked={onlySupported} onChange={(e) => setOnlySupported(e.target.checked)} className="h-3.5 w-3.5 accent-[#E4572E]" />
                  Only templates made for {CLASS_LABELS[format]}
                </label>
              )}
            </div>
            <p className="mt-1 text-xs text-muted">{format ? `Every preview is shown as ${CLASS_LABELS[format]} where the template supports it; otherwise in its first format.` : 'Each preview is shown in the template’s first format.'}</p>
          </div>

          <div>
            <span className={FIELD_LABEL}>Preview with brand colors</span>
            <PaletteSwitcher value={paletteId} onChange={setPaletteId} />
            <p className="mt-1 text-xs text-muted">{paletteById(paletteId).label}: every preview below re-renders in these colors.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-cream-300/70 pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              aria-pressed={favOnly}
              onClick={() => setFavOnly((v) => !v)}
              title="Favorites are saved in this browser only."
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                favOnly ? 'border-amber-300 bg-amber-100 text-amber-800' : 'border-cream-300 bg-cream-50 text-ink-600 hover:bg-cream-200',
              )}
            >
              <Star className={cn('h-3.5 w-3.5', favOnly && 'fill-current')} aria-hidden="true" />
              Favorites only{fav.ids.length > 0 ? ` (${fav.ids.length})` : ''}
            </button>
            <p className="text-xs text-muted" aria-live="polite">
              {list.isLoading ? (
                'Loading templates…'
              ) : list.isError && !list.data ? (
                'Templates unavailable'
              ) : (
                <>
                  <strong className="font-semibold text-ink">{shown.length}</strong>
                  {libraryCount !== undefined ? ` of ${libraryCount}` : ''} template{(libraryCount ?? shown.length) === 1 ? '' : 's'}
                  {favOnly ? ' (favorites)' : ''}
                  {(list.isFetching || settling) && <Loader2 className="ml-1.5 inline h-3 w-3 animate-spin align-[-1px]" aria-label="Updating" />}
                </>
              )}
            </p>
          </div>
          {anyFilter && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="h-3.5 w-3.5" aria-hidden="true" /> Clear filters
            </Button>
          )}
        </div>
      </Card>

      {/* Results */}
      <div role="tabpanel" aria-label="Templates">
        {list.isLoading && !list.data ? (
          <SkeletonGrid />
        ) : list.isError && !list.data ? (
          <EmptyState
            icon={AlertTriangle}
            title="The template library could not be loaded"
            description={list.error instanceof Error && list.error.message ? list.error.message : 'Something went wrong while loading templates.'}
            action={
              <Button variant="outline" onClick={() => list.refetch()}>
                <RotateCcw className="h-4 w-4" /> Try again
              </Button>
            }
          />
        ) : shown.length === 0 ? (
          libraryCount === 0 && !anyFilter ? (
            <EmptyState icon={LayoutTemplate} title="No templates yet" description="The template library is empty right now. Templates appear here as soon as they are added." />
          ) : favOnly && items.length > 0 ? (
            <EmptyState
              icon={Star}
              title={fav.ids.length === 0 ? 'No favorites yet' : 'None of your favorites match these filters'}
              description={fav.ids.length === 0 ? 'Star a template to keep it here. Favorites are saved in this browser only.' : 'Clear a filter to see your starred templates.'}
              action={
                <Button variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={LayoutTemplate}
              title="No templates match these filters"
              description="Try a different category, style or format, or search for something broader."
              action={
                <Button variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          )
        ) : (
          <>
            {list.isError && <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">The list could not be refreshed. Showing the last templates that loaded.</p>}
            <ul className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-3', list.isFetching && 'opacity-80 transition-opacity')}>
              {shown.map((t) => (
                <li key={t.id} className="flex">
                  <TemplateCardView
                    t={t}
                    cls={classFor(t, format)}
                    paletteId={paletteId}
                    favorite={fav.has(t.id)}
                    onToggleFavorite={() => fav.toggle(t.id)}
                    onOpen={() => setSelected(t)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-5 text-xs text-muted">Favorites are saved in this browser only; they are a personal preference, not part of any project.</p>
      </div>

      {selected && (
        <TemplateDetailDialog
          key={selected.id}
          template={selected}
          initialPaletteId={paletteId}
          initialClass={format}
          onClose={() => setSelected(null)}
          onOpenStyle={
            onOpenStyle
              ? (id) => {
                  setSelected(null);
                  onOpenStyle(id);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
