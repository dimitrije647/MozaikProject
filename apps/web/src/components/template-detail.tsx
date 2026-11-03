'use client';

import * as React from 'react';
import { ImageOff, Loader2, PenLine, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  CATEGORY_LABELS,
  CLASS_LABELS,
  templatePreviewUrl,
  useStyles,
  type FormatClass,
  type StyleId,
  type TemplateCard,
} from '@/lib/hybrid';
import { cn } from '@/lib/utils';

/*
 * The template detail dialog and the small pieces the gallery shares with it (palettes, the preview image with its loading and failure
 * states, the "Needs" wording). Everything shown here comes from the API's template card; previews are PNGs the server renders from the
 * template's own declarative definition with sample text and a placeholder picture. Nothing here makes a paid request.
 */

// ---- shared helpers ---------------------------------------------------------------------------------------------------------------------

export const humanize = (s: string) => {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Channel ids the template filter and the style cards use (mirrors the API's channel list; a label is never data about a template). */
export const CHANNEL_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  google_search: 'Google Search',
  email: 'Email',
  organic_content: 'Organic content',
  community: 'Community',
};
export const channelLabel = (id: string) => CHANNEL_LABELS[id] ?? humanize(id);

/** Preset brand palettes (primary, secondary, accent). The server's renderer adapts every template to whatever palette it is given. */
export const PALETTES = [
  { id: 'blue', label: 'Brand blue', colors: ['#3157d5', '#14213d', '#f4a62a'] },
  { id: 'warm', label: 'Warm terracotta', colors: ['#c8481f', '#5b2a12', '#f2b84b'] },
  { id: 'green', label: 'Fresh green', colors: ['#1f7a4d', '#0f3d2e', '#e9c46a'] },
  { id: 'dark', label: 'Dark with neon', colors: ['#0f172a', '#6366f1', '#22d3ee'] },
  { id: 'pastel', label: 'Soft pastel', colors: ['#f4a7c0', '#a9b8f5', '#fbe3a1'] },
] as const;
export type PaletteId = (typeof PALETTES)[number]['id'];
export const paletteById = (id: string) => PALETTES.find((p) => p.id === id) ?? PALETTES[0];

export function PaletteSwitcher({ value, onChange, className }: { value: string; onChange: (id: PaletteId) => void; className?: string }) {
  return (
    <div role="group" aria-label="Preview brand colors" className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {PALETTES.map((p) => {
        const on = p.id === value;
        return (
          <button
            key={p.id}
            type="button"
            aria-pressed={on}
            aria-label={`${p.label} palette (${p.colors.join(', ')})`}
            title={`${p.label}: ${p.colors.join(', ')}`}
            onClick={() => onChange(p.id)}
            className={cn(
              'flex items-center rounded-full border p-1 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
              on ? 'border-ink bg-cream-50 shadow-soft' : 'border-cream-300 bg-cream-50 hover:border-ink-600/40',
            )}
          >
            {p.colors.map((c, i) => (
              <span key={c} className={cn('h-5 w-5 rounded-full ring-2 ring-cream-50', i > 0 && '-ml-1.5')} style={{ backgroundColor: c }} />
            ))}
          </button>
        );
      })}
    </div>
  );
}

/** width / height of the picture each format class is rendered at (matches the server's preview sizes). */
export const CLASS_RATIO: Record<FormatClass, number> = { square: 1, portrait: 1080 / 1350, story: 1080 / 1920, landscape: 1200 / 628, banner: 4 };

/** The class to show a template in: the wanted one when the template supports it, otherwise its first class. */
export function classFor(t: Pick<TemplateCard, 'classes'>, wanted?: FormatClass | '' | null): FormatClass {
  if (wanted && t.classes.includes(wanted)) return wanted;
  return t.classes[0] ?? 'square';
}

/** Content a template needs that only the user can supply. Pictures, the logo and ordinary campaign copy are not in this list. */
const ORDINARY_CONTENT = new Set(['image', 'logo', 'headline', 'support', 'cta', 'eyebrow', 'brand']);
export const userNeeds = (requires: string[]) => requires.filter((r) => !ORDINARY_CONTENT.has(r));

const NEED_LABELS: Record<string, string> = { quote: 'quote', attribution: 'attribution', stat: 'statistic', statLabel: 'stat label', date: 'date', location: 'location', offer: 'offer', offerDetail: 'offer details', tag: 'tag' };
export const needLabel = (r: string) => NEED_LABELS[r] ?? humanize(r).toLowerCase();

/** "Needs: offer, date +1": the short form for cards. */
export function needsSummary(requires: string[]) {
  const n = userNeeds(requires).map(needLabel);
  if (n.length === 0) return null;
  return `Needs: ${n.slice(0, 2).join(', ')}${n.length > 2 ? ` +${n.length - 2}` : ''}`;
}

const NEED_EXPLAIN: Record<string, string> = {
  image: 'A picture. In a campaign this is your original AI image or a brand image; the layout makes no sense without one.',
  logo: 'Your logo file. It is never redrawn or invented.',
  headline: 'A headline, taken from your campaign copy.',
  support: 'A support line, taken from your campaign copy.',
  cta: 'A button label, taken from your campaign copy.',
  eyebrow: 'A short label above the headline, taken from your campaign copy.',
  brand: 'Your brand name.',
  quote: 'A quote you provide, for example a real customer testimonial. It is never invented.',
  attribution: 'Who said it (a name or role) that you provide. It is never invented.',
  stat: 'A real number you provide. It is never invented.',
  statLabel: 'What that number measures, provided by you.',
  date: 'An event date you provide. It is never invented.',
  location: 'A venue or city you provide. It is never invented.',
  offer: 'An offer you provide, such as a discount or a deal. It is never invented.',
  offerDetail: 'The terms or details of that offer, provided by you.',
  tag: 'A short tag you provide (for example "New" or "Limited").',
};
export const needExplanation = (r: string) => NEED_EXPLAIN[r] ?? `${humanize(r)} that you provide. It is never invented.`;

/** Style display names come from GET /styles; the id is humanized until they load (or when the API does not know the id). */
export function useStyleNames() {
  const styles = useStyles();
  return React.useCallback((id: string) => styles.data?.items.find((s) => s.id === id)?.name ?? humanize(id), [styles.data]);
}

export function StatusBadge({ status }: { status: TemplateCard['status'] }) {
  return (
    <Badge className={cn(status === 'active' ? 'bg-emerald-100 text-emerald-800' : status === 'draft' ? 'bg-amber-100 text-amber-800' : 'bg-cream-300 text-ink-600')}>
      {humanize(status)}
    </Badge>
  );
}

export function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center rounded-full bg-cream-100 px-2.5 py-0.5 text-xs text-ink-600', className)}>{children}</span>;
}

// ---- the preview picture ----------------------------------------------------------------------------------------------------------------

/**
 * Fills a `relative` parent with the server-rendered PNG. The parent fixes the aspect ratio, so the layout never jumps. While a new
 * picture loads (a palette change) the previous one stays visible, dimmed; a picture that fails shows a quiet fallback with a retry.
 */
function PreviewImage({ src, alt, eager }: { src: string; alt: string; eager?: boolean }) {
  const [shown, setShown] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const ref = React.useRef<HTMLImageElement>(null);

  React.useEffect(() => setFailed(null), [src]);
  // A picture served from the browser cache can finish loading before React has attached onLoad.
  React.useEffect(() => {
    const el = ref.current;
    if (el && el.complete && el.naturalWidth > 0) setShown(src);
  }, [src, attempt]);

  const ready = shown === src;
  const broken = failed === src;
  return (
    <>
      {shown && !ready && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={shown} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover opacity-50" />
      )}
      {!broken && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`${src}#${attempt}`}
          ref={ref}
          src={src}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onLoad={() => setShown(src)}
          onError={() => setFailed(src)}
          className={cn('absolute inset-0 h-full w-full object-cover transition-opacity duration-200', ready ? 'opacity-100' : 'opacity-0')}
        />
      )}
      {!ready && !broken && !shown && <div className="absolute inset-0 animate-pulse bg-cream-300/70" aria-hidden="true" />}
      {!ready && !broken && shown && (
        <span className="absolute bottom-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-cream-50/90 shadow-soft" role="status" aria-label="Updating preview">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-600" />
        </span>
      )}
      {broken && (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-1.5 bg-cream-100 p-3 text-center" role="img" aria-label={`${alt} (preview unavailable)`}>
          <ImageOff className="h-5 w-5 text-muted" />
          <p className="text-xs text-muted">Preview unavailable</p>
          <button
            type="button"
            onClick={() => {
              setFailed(null);
              setAttempt((a) => a + 1);
            }}
            className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-cream-300 bg-cream-50 px-2.5 py-1 text-xs text-ink-600 hover:bg-cream-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <RotateCcw className="h-3 w-3" /> Try again
          </button>
        </div>
      )}
    </>
  );
}

/**
 * A preview in a box of the right shape. `tile` is the gallery thumbnail (a square well, the picture centered inside at its own shape);
 * `large` is the detail view (as wide as the column, never taller than about 62% of the window).
 */
export function TemplatePreview({ src, alt, cls, fit = 'tile', eager }: { src: string; alt: string; cls: FormatClass; fit?: 'tile' | 'large'; eager?: boolean }) {
  const ratio = CLASS_RATIO[cls];
  const frame = 'relative overflow-hidden rounded-md bg-cream-100 shadow-soft ring-1 ring-ink/5';
  if (fit === 'large') {
    return (
      <div className="flex justify-center rounded-2xl bg-cream-200 p-3 sm:p-4">
        <div className={frame} style={{ aspectRatio: ratio, width: `min(100%, ${(ratio * 62).toFixed(1)}vh)` }}>
          <PreviewImage src={src} alt={alt} eager={eager} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex aspect-square items-center justify-center bg-cream-200 p-4">
      <div className={frame} style={{ aspectRatio: ratio, width: ratio >= 1 ? '100%' : `${(ratio * 100).toFixed(2)}%` }}>
        <PreviewImage src={src} alt={alt} eager={eager} />
      </div>
    </div>
  );
}

// ---- the detail dialog ------------------------------------------------------------------------------------------------------------------

const TONE_LABELS: Record<TemplateCard['tone'], string> = { brand: 'Brand colors lead', dark: 'Dark', light: 'Light', duo: 'Two-tone' };
const DENSITY_LABELS: Record<TemplateCard['density'], string> = { airy: 'Airy (a lot of space)', balanced: 'Balanced', dense: 'Dense (more content)' };

const SAMPLE_LABELS: [keyof TemplateCard['sample'], string][] = [
  ['eyebrow', 'Eyebrow'],
  ['headline', 'Headline'],
  ['support', 'Support line'],
  ['quote', 'Quote'],
  ['attribution', 'Attribution'],
  ['stat', 'Statistic'],
  ['statLabel', 'Statistic label'],
  ['offer', 'Offer'],
  ['offerDetail', 'Offer detail'],
  ['date', 'Date'],
  ['location', 'Location'],
  ['tag', 'Tag'],
  ['cta', 'Button'],
  ['brand', 'Brand name'],
];

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={className}>
      <h4 className="mb-1.5 font-sans text-xs font-medium uppercase tracking-[0.12em] text-muted">{title}</h4>
      {children}
    </section>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string; disabled?: boolean; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-full border border-cream-300 bg-cream-50 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-40',
            o.id === value ? 'bg-ink text-cream-100' : 'text-ink-600 hover:bg-cream-200 disabled:hover:bg-transparent',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TemplateDetailDialog({
  template: t,
  initialPaletteId,
  initialClass,
  onClose,
  onOpenStyle,
}: {
  template: TemplateCard;
  initialPaletteId: string;
  initialClass?: FormatClass | '';
  onClose: () => void;
  onOpenStyle?: (id: StyleId) => void;
}) {
  const styleName = useStyleNames();
  const [cls, setCls] = React.useState<FormatClass>(classFor(t, initialClass));
  // A template that is meaningless without a picture lists "image" in `requires`; the server refuses to render it without one.
  const needsPicture = t.requires.includes('image');
  const [withImage, setWithImage] = React.useState(true);
  const [paletteId, setPaletteId] = React.useState<string>(paletteById(initialPaletteId).id);
  const palette = paletteById(paletteId);
  const src = templatePreviewUrl(t.id, { class: cls, palette: [...palette.colors], image: withImage });
  const needs = userNeeds(t.requires);
  const sampleRows = SAMPLE_LABELS.filter(([k]) => !!t.sample[k]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t.name}
        description={`${CATEGORY_LABELS[t.category] ?? humanize(t.category)} template, version ${t.version}`}
        className="max-h-[calc(100vh-2rem)] max-w-4xl overflow-y-auto p-5 sm:p-7"
      >
        <div className="grid gap-6 md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          {/* Preview */}
          <div className="space-y-3">
            <div role="tablist" aria-label="Preview format" className="flex flex-wrap gap-1 border-b border-cream-300/80">
              {t.classes.map((c) => (
                <button
                  key={c}
                  role="tab"
                  type="button"
                  aria-selected={cls === c}
                  onClick={() => setCls(c)}
                  className={cn('-mb-px border-b-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50', cls === c ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink')}
                >
                  {CLASS_LABELS[c]}
                </button>
              ))}
            </div>
            <TemplatePreview
              src={src}
              cls={cls}
              fit="large"
              eager
              alt={`${t.name} in ${CLASS_LABELS[cls]} format, ${withImage ? 'with a placeholder picture' : 'without a picture'}, using the ${palette.label} palette and sample text`}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Segmented
                label="Picture in the preview"
                value={withImage ? 'with' : 'without'}
                options={[
                  { id: 'with', label: 'With picture' },
                  { id: 'without', label: 'Without picture', disabled: needsPicture, title: needsPicture ? 'This template is built around a picture, so it is only shown with one.' : undefined },
                ]}
                onChange={(v) => setWithImage(v === 'with')}
              />
              <PaletteSwitcher value={paletteId} onChange={setPaletteId} />
            </div>
            <p className="text-xs text-muted">
              Preview with sample text and a neutral placeholder picture, rendered from this template&apos;s own definition. In a campaign, your copy and your original AI image are used.
            </p>
            {needsPicture && <p className="text-xs text-muted">This template is built around a picture, so it is only previewed with one.</p>}
          </div>

          {/* Facts */}
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="bg-accent-soft text-accent-hover">{CATEGORY_LABELS[t.category] ?? humanize(t.category)}</Badge>
              <StatusBadge status={t.status} />
              <Chip>Version {t.version}</Chip>
            </div>

            <p className="text-ink-700">{t.description}</p>

            <Section title="Composition">
              <p className="text-ink-700">{t.composition}</p>
            </Section>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-2xl bg-cream-100 p-4">
              <div>
                <dt className="text-xs text-muted">Family</dt>
                <dd className="font-medium">{humanize(t.family)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Density</dt>
                <dd className="font-medium">{DENSITY_LABELS[t.density] ?? humanize(t.density)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Tone</dt>
                <dd className="font-medium">{TONE_LABELS[t.tone] ?? humanize(t.tone)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Layers</dt>
                <dd className="font-medium">{t.layerCount}</dd>
              </div>
            </dl>

            <Section title="Visual styles">
              {t.styles.length === 0 ? (
                <p className="text-muted">Works with any style.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {t.styles.map((s) => (
                    <li key={s}>
                      {onOpenStyle ? (
                        <button
                          type="button"
                          onClick={() => onOpenStyle(s)}
                          title="Open this style in the Style library"
                          className="inline-flex items-center rounded-full border border-cream-300 bg-cream-50 px-2.5 py-0.5 text-xs text-ink-700 underline-offset-2 hover:bg-cream-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                        >
                          {styleName(s)}
                        </button>
                      ) : (
                        <Chip>{styleName(s)}</Chip>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Industries">
              <ul className="flex flex-wrap gap-1.5">
                {(t.industries.length === 0 || t.industries.includes('*') ? ['Any industry'] : t.industries).map((i) => (
                  <li key={i}>
                    <Chip>{i}</Chip>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="Channels">
              <ul className="flex flex-wrap gap-1.5">
                {(t.channels.length === 0 ? ['Any channel'] : t.channels.map(channelLabel)).map((c) => (
                  <li key={c}>
                    <Chip>{c}</Chip>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="What this template needs">
              {t.requires.length === 0 ? (
                <p className="text-ink-700">Nothing beyond your normal campaign copy. It works with any campaign.</p>
              ) : (
                <ul className="space-y-1.5">
                  {t.requires.map((r) => (
                    <li key={r} className="flex items-start gap-2 text-ink-700">
                      {userNeeds([r]).length > 0 ? <PenLine className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden="true" /> : <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cream-300" aria-hidden="true" />}
                      <span>
                        <strong className="font-medium capitalize">{needLabel(r)}</strong>: {needExplanation(r)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {needs.length > 0 && <p className="mt-2 text-xs text-muted">A template that needs content only you can provide is used only when your campaign has it.</p>}
            </Section>

            <Section title="Sample copy in the preview">
              <dl className="space-y-1 rounded-xl border border-cream-300/80 bg-cream-50 p-3">
                {sampleRows.map(([k, label]) => (
                  <div key={k} className="flex gap-3">
                    <dt className="w-28 shrink-0 text-xs text-muted">{label}</dt>
                    <dd className="min-w-0 break-words text-ink-700">{t.sample[k]}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-1.5 text-xs text-muted">Sample text; your campaign uses your own copy.</p>
            </Section>

            <p className="rounded-xl bg-cream-100 px-3 py-2 text-xs text-ink-600">
              This template is declarative data (a list of {t.layerCount} layers with positions, colors and text rules), not code. It cannot run anything.
            </p>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
