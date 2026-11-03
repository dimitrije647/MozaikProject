'use client';

import * as React from 'react';
import { AlertCircle, Check, Download, ExternalLink, ImageOff, Info, XCircle } from 'lucide-react';
import { FORMAT_LABEL, ROLE_LABEL, VARIATION_STATUS, assetSrc, variationsOf } from '@/components/creative-views';
import { fmtUsd } from '@/components/cost-ui';
import { BrandLogoLine } from '@/components/no-ai-output';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ORIGIN_LABELS, campaignDownloadUrl, originOf, type AssetOrigin, type HybridBlockData, type LibraryImageRecordData, type TemplateCreativeData, type TemplateQualityData, type TemplateSelectionPlanData, type VisualDirectionData, type VisualReferenceRecord } from '@/lib/hybrid';
import { SOURCE_LABEL } from '@/lib/images';
import type { CampaignAssetView, CampaignPackageData, ImageVariationData } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

/*
 * Hybrid Production, output side. Everything here is read from the saved package (`pkg.hybrid`) and the CampaignAsset rows, served through
 * the authenticated file endpoint. A TEMPLATE creative is rendered locally from a library template, the brand and an original image: it is
 * NEVER an AI image and is never labelled or counted as one. A failed or skipped creative is shown as a placeholder with its reason and is
 * never counted as delivered. Nothing here starts a run, a render or an image request.
 */

/** The Hybrid block of a package, or null on every other campaign (those render exactly as before). */
export const hybridOf = (pkg: CampaignPackageData | null | undefined): HybridBlockData | null => (pkg?.hybrid && pkg.hybrid.mode === 'hybrid' ? pkg.hybrid : null);

const Empty = ({ text }: { text: string }) => <p className="rounded-xl border border-dashed border-cream-300 bg-cream-50/60 px-4 py-5 text-center text-sm text-muted">{text}</p>;
const Card = ({ className, ...p }: React.HTMLAttributes<HTMLElement>) => <section className={cn('rounded-2xl border border-cream-300/80 bg-cream-50 p-4', className)} {...p} />;
const H = ({ children }: { children: React.ReactNode }) => <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">{children}</h4>;

const fileSlug = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'creative';
const pretty = (s: string) => {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const CHANNEL_LABEL: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', youtube: 'YouTube', tiktok: 'TikTok', google_search: 'Google Search', email: 'Email', organic_content: 'Organic content', community: 'Community' };
const channelLabel = (c: string) => CHANNEL_LABEL[c] ?? pretty(c);
const formatLabel = (f: string, w?: number | null, h?: number | null) => FORMAT_LABEL[f] ?? `${pretty(f)}${w && h ? ` ${w}×${h}` : ''}`;
const tplLabel = (name: string, version: number) => `${name} v${version}`;
/** "Instagram feed 1080×1080" already names its channel: do not say it twice. */
const channelFormat = (channel: string, fmt: string) => (fmt.toLowerCase().startsWith(channelLabel(channel).toLowerCase()) ? fmt : `${channelLabel(channel)} · ${fmt}`);
const num = (n: number) => n.toLocaleString('en-US');
const styleName = (id: string) => pretty(id);

// ---- flags in plain words ---------------------------------------------------------------------------------------------------------------

const FLAGS: { re: RegExp; text: string; warn: boolean }[] = [
  { re: /^text_shrunk/, text: 'text was scaled down to fit', warn: false },
  { re: /^text_trimmed/, text: 'text was shortened', warn: true },
  { re: /^text_hyphenated/, text: 'a long word was split with a hyphen', warn: false },
  { re: /^text_overflow/, text: 'the headline may not fit its box', warn: true },
  { re: /^text_slot_empty/, text: 'a text field had no content and was left out', warn: false },
  { re: /^support_dropped/, text: 'supporting line left out to fit', warn: false },
  { re: /^moved_into_safe_area/, text: 'an element was moved back inside the safe area', warn: false },
  { re: /^low_contrast_adjusted/, text: 'text color adjusted for contrast', warn: false },
  { re: /^low_contrast_unresolved/, text: 'contrast stays low (busy picture)', warn: true },
  { re: /^image_low_resolution/, text: 'picture enlarged beyond its resolution', warn: true },
  { re: /^hero_missing_fallback/, text: 'no picture: the template pattern was used', warn: false },
  { re: /^secondary_missing_fallback/, text: 'no second picture: the template pattern was used', warn: false },
  { re: /^logo_missing_name_used/, text: 'no logo: brand name used', warn: false },
  { re: /^logo_unreadable/, text: 'logo not readable: brand name used', warn: true },
  { re: /^logo_low_resolution/, text: 'logo enlarged beyond its resolution', warn: true },
  { re: /^logo_missing_no_name/, text: 'no logo and no brand name: logo area left empty', warn: true },
  { re: /^logo_applied/, text: 'logo placed', warn: false },
];

/** Plain-language chips for the renderer's flags. An unknown flag is shown as recorded, never hidden. */
export function flagChips(flags: string[]): { key: string; text: string; warn: boolean }[] {
  const seen = new Set<string>();
  const out: { key: string; text: string; warn: boolean }[] = [];
  for (const f of flags) {
    const hit = FLAGS.find((x) => x.re.test(f));
    const slot = f.includes(':') ? f.split(':')[1] : '';
    const text = hit ? `${hit.text}${slot && !/^moved|^low_contrast|^image_/.test(f) ? ` (${slot})` : ''}` : f;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ key: f, text, warn: hit ? hit.warn : true });
  }
  return out;
}

const ORIGIN_BADGE: Record<AssetOrigin, string> = {
  AI_GENERATED: 'bg-emerald-600 text-white',
  TEMPLATE_RENDERED: 'bg-ink/85 text-cream-100',
  FALLBACK: 'bg-amber-500 text-white',
  USER_UPLOADED: 'bg-sky-600 text-white',
  BRAND_ASSET: 'bg-sky-600 text-white',
  LICENSED_ASSET: 'bg-sky-600 text-white',
};
const RIGHTS_BASIS: Record<string, string> = { generated_for_user: 'Generated for you on your own provider account', original_template: 'LaunchPilot-original template', user_provided: 'Provided by you', licensed: 'Licensed', none: 'No rights recorded' };

// ---- the creatives as one list ----------------------------------------------------------------------------------------------------------

type Tone = 'ok' | 'fallback' | 'failed' | 'skipped' | 'budget' | 'nofile';
interface Source {
  ref: string;
  asset: CampaignAssetView | null;
  label: string;
  /** The gallery item of an original AI image this creative was built from (for the link between them). */
  itemKey: string | null;
  /** NO AI HYBRID: the picture of the campaign's library this creative was built from (its source, license and credit), and a same-origin thumbnail of it. */
  library?: LibraryImageRecordData | null;
  thumb?: string | null;
}
export interface CreativeItem {
  key: string;
  type: 'original' | 'template';
  conceptId: string;
  conceptName: string;
  conceptOrder: number;
  order: number;
  title: string;
  channel: string | null;
  format: string | null;
  formatLabel: string;
  width: number | null;
  height: number | null;
  tone: Tone;
  statusLabel: string;
  reason: string | null;
  asset: CampaignAssetView | null;
  origin: AssetOrigin | null;
  templateId: string | null;
  templateName: string | null;
  templateVersion: number | null;
  sources: Source[];
  flags: string[];
  slotId: string | null;
  variation: ImageVariationData | null;
  creative: TemplateCreativeData | null;
}
/** Only these count as delivered: a file that exists and was made. A failed, skipped, stopped or file-less record never does. */
const isDelivered = (i: CreativeItem) => i.tone === 'ok' || i.tone === 'fallback';

const sizeOf = (size: string): [number | null, number | null] => {
  const [w, h] = size.split('x').map(Number);
  return w > 0 && h > 0 ? [w, h] : [null, null];
};

export function buildCreativeItems(pkg: CampaignPackageData, hy: HybridBlockData, assets: CampaignAssetView[]): CreativeItem[] {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const conceptOrder = new Map(pkg.concepts.map((c, i) => [c.id, i]));
  const conceptName = (id: string) => pkg.concepts.find((c) => c.id === id)?.name ?? hy.selection?.items.find((i) => i.conceptId === id)?.conceptName ?? id;
  const items: CreativeItem[] = [];
  const itemOfAsset = new Map<string, string>();

  for (const v of variationsOf(pkg)) {
    const asset = v.generatedAssetId ? (byId.get(v.generatedAssetId) ?? null) : null;
    const made = v.status === 'generated';
    const [w, h] = asset ? [asset.width, asset.height] : sizeOf(v.size);
    const tone: Tone = made ? (asset ? 'ok' : 'nofile') : v.status === 'failed' ? 'failed' : v.status === 'blocked_by_budget' ? 'budget' : 'skipped';
    const key = `o:${v.variationId}`;
    if (asset) itemOfAsset.set(asset.id, key);
    items.push({
      key, type: 'original', conceptId: v.conceptId, conceptName: v.conceptName || conceptName(v.conceptId), conceptOrder: conceptOrder.get(v.conceptId) ?? 99, order: v.index,
      title: v.variationName, channel: null, format: null, formatLabel: w && h ? `${w}×${h}` : v.size, width: w, height: h, tone,
      statusLabel: made && !asset ? 'The image file is missing from this campaign' : VARIATION_STATUS[v.status].label,
      reason: made ? null : (v.explanation ?? v.safeError?.message ?? 'No reason was recorded for this image.'),
      asset, origin: asset ? originOf(asset) : null, templateId: null, templateName: null, templateVersion: null, sources: [], flags: [], slotId: null, variation: v, creative: null,
    });
  }

  hy.creatives.forEach((c, idx) => {
    const asset = c.assetId ? (byId.get(c.assetId) ?? null) : null;
    const made = c.status === 'rendered' || c.status === 'fallback_rendered';
    const tone: Tone = made ? (asset ? (c.status === 'fallback_rendered' ? 'fallback' : 'ok') : 'nofile') : c.status === 'failed' ? 'failed' : 'skipped';
    const statusLabel = made && !asset ? 'The creative file is missing from this campaign' : c.status === 'rendered' ? 'Rendered' : c.status === 'fallback_rendered' ? 'Rendered without its original (FALLBACK)' : c.status === 'failed' ? 'Failed to render' : 'Not rendered';
    const sources: Source[] = c.sourceAssetIds.map((ref) => {
      if (ref.startsWith('brand:')) {
        // NO AI HYBRID: the id after "brand:" is the library picture (library id === asset id)
        const id = ref.slice('brand:'.length);
        const lib = hy.imagery?.library.find((l) => l.id === id) ?? null;
        return { ref, asset: null, label: lib ? `${lib.name} (${SOURCE_LABEL[lib.source]})` : 'A brand image of your project', itemKey: null, library: lib, thumb: lib ? `/api/assets/${encodeURIComponent(id)}/file` : null };
      }
      const a = byId.get(ref) ?? null;
      const itemKey = itemOfAsset.get(ref) ?? null;
      const orig = itemKey ? items.find((i) => i.key === itemKey) : null;
      return { ref, asset: a, label: orig ? `Original AI image: ${orig.title}` : a ? ORIGIN_LABELS[originOf(a)] : 'An asset that is not part of this campaign', itemKey };
    });
    items.push({
      key: `t:${c.slotId}`, type: 'template', conceptId: c.conceptId, conceptName: conceptName(c.conceptId), conceptOrder: conceptOrder.get(c.conceptId) ?? 99, order: 1000 + idx,
      title: c.templateName, channel: c.channel, format: c.format, formatLabel: formatLabel(c.format, c.width, c.height), width: c.width, height: c.height, tone, statusLabel,
      reason: c.reason, asset, origin: asset ? originOf(asset) : c.origin, templateId: c.templateId, templateName: c.templateName, templateVersion: c.templateVersion,
      sources, flags: asset?.flags?.length ? asset.flags : c.flags, slotId: c.slotId, variation: null, creative: c,
    });
  });
  return items;
}

// ---- the summary: honest counters, and the spending as separate counters ------------------------------------------------------------------

function Bar({ parts }: { parts: { n: number; cls: string; label: string }[] }) {
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (total <= 0) return null;
  return (
    <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-cream-200" aria-hidden>
      {parts.map((p) => (p.n > 0 ? <div key={p.label} title={`${p.n} ${p.label}`} className={p.cls} style={{ width: `${(p.n / total) * 100}%` }} /> : null))}
    </div>
  );
}

export function HybridSummary({ hybrid }: { hybrid: HybridBlockData }) {
  const { originals: o, templates: t, total, text, spending } = hybrid.counts;
  const rendered = t.rendered + t.fallbackRendered;
  const style = hybrid.direction ? styleName(hybrid.direction.styleId) : null;
  const stat = (k: string, v: React.ReactNode, hint?: string) => (
    <div className="rounded-xl bg-cream-100 px-3 py-2" key={k}>
      <dt className="text-[11px] uppercase tracking-wider text-muted">{k}</dt>
      <dd className="text-base font-semibold leading-tight">{v}</dd>
      {hint && <dd className="text-[11px] text-muted">{hint}</dd>}
    </div>
  );
  return (
    <div data-testid="hybrid-summary" className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <Card className="space-y-3">
        <div className="space-y-1">
          <Badge className="bg-ink text-cream-100">Hybrid Production</Badge>
          <p className="text-xs text-muted">
            Template library v{hybrid.libraryVersion}
            {style ? ` · style ${style}` : ''}
            {hybrid.selection ? ` · templates chosen ${hybrid.selection.mode === 'automatic' ? 'automatically' : hybrid.selection.mode === 'assisted' ? 'with model help' : 'by you'}` : ''}
          </p>
        </div>
        <div className="divide-y divide-cream-300/70">
          <div data-testid="hybrid-count-originals" className="py-2.5 first:pt-0">
            <p className="text-sm">
              <strong>Original AI images</strong> — {o.planned} planned · {o.generated} generated ({o.failed} failed, {o.blockedByBudget} stopped by a budget, {o.skipped} not requested)
            </p>
            <Bar parts={[{ n: o.generated, cls: 'bg-emerald-500', label: 'generated' }, { n: o.failed, cls: 'bg-red-500', label: 'failed' }, { n: o.blockedByBudget, cls: 'bg-amber-400', label: 'stopped by a budget' }, { n: o.skipped, cls: 'bg-cream-300', label: 'not requested' }]} />
          </div>
          <div data-testid="hybrid-count-templates" className="py-2.5">
            <p className="text-sm">
              <strong>Template creatives</strong> — {t.planned} planned · {rendered} rendered ({t.failed} failed, {t.skipped} not rendered)
            </p>
            {t.fallbackRendered > 0 && <p className="mt-0.5 text-xs text-amber-900">{t.fallbackRendered} of the {rendered} rendered {t.fallbackRendered === 1 ? 'is a FALLBACK' : 'are FALLBACKS'}: made without the original image it was planned with.</p>}
            <Bar parts={[{ n: t.rendered, cls: 'bg-emerald-500', label: 'rendered' }, { n: t.fallbackRendered, cls: 'bg-amber-400', label: 'rendered as a fallback' }, { n: t.failed, cls: 'bg-red-500', label: 'failed' }, { n: t.skipped, cls: 'bg-cream-300', label: 'not rendered' }]} />
          </div>
          <div data-testid="hybrid-count-total" className="py-2.5 last:pb-0">
            <p className="text-sm">
              <strong>Total</strong> — {total.planned} planned · {total.delivered} delivered
            </p>
            <p className="mt-0.5 text-xs text-muted">Delivered counts only files that exist. A failed, stopped or not-rendered creative is never counted.</p>
          </div>
        </div>
        <BrandLogoLine hybrid={hybrid} />
        <p className="text-xs text-muted">Template creatives are rendered locally from a library template, your brand colors and logo, and an original image. They are not AI images and are counted separately from them.</p>
      </Card>

      <Card data-testid="hybrid-spending" className="space-y-3">
        <H>Spending and requests</H>
        <dl className="grid grid-cols-2 gap-2">
          {stat('Original image requests made', num(o.requested))}
          {stat('Successful AI images', num(o.generated))}
          {stat('Template creatives planned', num(t.planned))}
          {stat('Renders completed', num(rendered), 'local, not billed')}
          {stat('Failed renders', num(t.failed))}
          {stat('Text-model calls', num(text.calls), `${num(text.inputTokens + text.outputTokens)} tokens (${num(text.inputTokens)} in / ${num(text.outputTokens)} out)`)}
          {stat('Known spending', fmtUsd(spending.spentUsd), `text ${fmtUsd(spending.textUsd)} · images ${spending.imageUsd === null ? 'unavailable' : fmtUsd(spending.imageUsd)}`)}
          {stat('Approved amount', spending.approvedUsd === null ? 'no limit set' : fmtUsd(spending.approvedUsd))}
        </dl>
        <p className="text-xs text-muted">{spending.note}</p>
      </Card>
    </div>
  );
}

/** "What to know": the notes the package carries about partial results, fallbacks and reductions. */
export function HybridNotes({ hybrid }: { hybrid: HybridBlockData }) {
  return (
    <Card data-testid="hybrid-notes" aria-label="What to know" className="space-y-2">
      <H>What to know</H>
      {hybrid.notes.length === 0 ? (
        <p className="text-sm text-muted">No note was recorded: nothing was reduced, replaced or left out.</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {hybrid.notes.map((n, i) => (
            <li key={i} className="flex items-start gap-2">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" /> <span>{n}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---- downloads --------------------------------------------------------------------------------------------------------------------------

export function HybridDownloads({ campaignId, hybrid, dark }: { campaignId: string; hybrid: HybridBlockData; dark?: boolean }) {
  const { originals: o, templates: t, total } = hybrid.counts;
  // NO AI HYBRID has no original AI image: that download is not offered at all (a disabled button would suggest something is missing)
  const noAi = !!hybrid.imagery;
  const opts = [
    ...(noAi ? [] : [{ what: 'originals' as const, label: 'Original AI images (ZIP)', n: o.generated, none: 'no original AI image was generated.', primary: false }]),
    { what: 'templates' as const, label: 'Template creatives (ZIP)', n: t.rendered + t.fallbackRendered, none: 'no template creative was rendered.', primary: false },
    { what: 'creatives' as const, label: 'All creatives (ZIP)', n: total.delivered, none: 'nothing was delivered.', primary: false },
    { what: 'package' as const, label: 'Full campaign package (ZIP)', n: null, none: '', primary: true },
  ];
  const off = opts.filter((x) => x.n === 0);
  return (
    <div data-testid="hybrid-downloads" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {opts.map((x) =>
          x.n === 0 ? (
            <Button key={x.what} size="sm" variant="outline" disabled data-testid={`download-${x.what}`} title={`Not available: ${x.none}`}>
              <Download className="h-3.5 w-3.5" /> {x.label}
            </Button>
          ) : (
            <Button key={x.what} asChild size="sm" variant={x.primary ? 'primary' : 'outline'}>
              <a data-testid={`download-${x.what}`} href={campaignDownloadUrl(campaignId, x.what)} download>
                <Download className="h-3.5 w-3.5" /> {x.label}
                {x.n !== null && <span className="text-[11px] font-normal opacity-70">{x.n} file{x.n === 1 ? '' : 's'}</span>}
              </a>
            </Button>
          ),
        )}
      </div>
      {off.map((x) => (
        <p key={x.what} role="note" className={cn('text-xs', dark ? 'text-muted-dark' : 'text-muted')}>
          {x.label} is not available: {x.none}
        </p>
      ))}
      <p className={cn('text-xs', dark ? 'text-muted-dark' : 'text-muted')}>
        {noAi ? 'The full package holds the strategy, the visual direction, the copy, the creatives, the landing content, the review, the usage and a manifest with SHA-256 hashes. No AI image is part of it. It contains no credentials and nothing from Pinterest.' : 'The full package holds the strategy, the visual direction, the copy, the images (originals and templates in separate folders), the layouts, the landing content, the review, the usage and a manifest with SHA-256 hashes. It contains no credentials and nothing from Pinterest.'}
      </p>
    </div>
  );
}

// ---- the gallery ------------------------------------------------------------------------------------------------------------------------

type View = 'concept' | 'channel' | 'type' | 'template' | 'format' | 'source';
const VIEWS: { id: View; label: string }[] = [
  { id: 'concept', label: 'By concept' },
  { id: 'channel', label: 'By channel' },
  { id: 'type', label: 'By production type' },
  { id: 'template', label: 'By template' },
  { id: 'format', label: 'By format' },
  { id: 'source', label: 'By source image' },
];
/** NO AI HYBRID has no original AI image, so "production type" says nothing; the picture a creative was built from does. */
const NO_AI_VIEWS: View[] = ['concept', 'template', 'channel', 'source', 'format'];
const NO_PICTURE = 'Text-first (no picture)';
const ORIGINALS_TITLE = 'Original AI images';
const TEMPLATES_TITLE = 'Template creatives';

interface Group {
  key: string;
  title: string;
  note?: string;
  items: CreativeItem[];
}

function groupItems(items: CreativeItem[], view: View): Group[] {
  const map = new Map<string, Group>();
  const put = (key: string, title: string, it: CreativeItem, note?: string) => {
    const g = map.get(key) ?? { key, title, note, items: [] };
    g.items.push(it);
    map.set(key, g);
  };
  const sorted = [...items].sort((a, b) => a.conceptOrder - b.conceptOrder || a.order - b.order);
  for (const it of sorted) {
    if (view === 'concept') put(`c:${it.conceptId}`, it.conceptName, it);
    else if (view === 'source') {
      const src = it.sources[0];
      if (!src) put('s:none', NO_PICTURE, it, 'Drawn with typography, colors and the template only: no picture was used.');
      else put(`s:${src.ref}`, src.library ? `${src.library.name} (${SOURCE_LABEL[src.library.source]})` : src.label, it, src.library ? `License: ${src.library.license}${src.library.attribution ? ` · Credit: ${src.library.attribution}${src.library.attributionRequired ? ' (credit required)' : ''}` : ''}` : undefined);
    } else if (view === 'type') put(it.type, it.type === 'original' ? ORIGINALS_TITLE : TEMPLATES_TITLE, it, it.type === 'original' ? 'Conceptual marketing visuals made by your image model: not photographs of real places, products or people.' : 'Rendered locally from a library template. Never AI images.');
    else if (it.type === 'original') put('orig', view === 'format' ? `${ORIGINALS_TITLE} (their own sizes)` : view === 'template' ? `${ORIGINALS_TITLE} (no template)` : `${ORIGINALS_TITLE} (not tied to one channel)`, it);
    else if (view === 'channel') put(`ch:${it.channel}`, channelLabel(it.channel ?? ''), it);
    else if (view === 'template') put(`t:${it.templateId}:${it.templateVersion}`, tplLabel(it.templateName ?? it.templateId ?? 'Template', it.templateVersion ?? 1), it);
    else put(`f:${it.format}`, it.formatLabel, it);
  }
  const list = [...map.values()];
  if (view === 'concept' || view === 'type') return list;
  if (view === 'source') return list.sort((a, b) => (a.key === 's:none' ? 1 : b.key === 's:none' ? -1 : b.items.length - a.items.length || a.title.localeCompare(b.title)));
  // the originals first, then the rest by size of group and name
  return list.sort((a, b) => (a.key === 'orig' ? -1 : b.key === 'orig' ? 1 : b.items.length - a.items.length || a.title.localeCompare(b.title)));
}

const TONE_RING: Record<Tone, string> = { ok: 'border-cream-300/80', fallback: 'border-amber-300', failed: 'border-red-300', skipped: 'border-dashed border-cream-300', budget: 'border-amber-300', nofile: 'border-red-300' };

function OriginBadge({ item }: { item: CreativeItem }) {
  const delivered = isDelivered(item);
  const label = item.origin && delivered ? ORIGIN_LABELS[item.origin] : item.type === 'original' ? ORIGINALS_TITLE.replace(/s$/, '') : 'Template creative';
  const cls = item.origin && delivered ? ORIGIN_BADGE[item.origin] : 'bg-cream-300 text-ink-700';
  return <span className={cn('absolute left-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-semibold', cls)}>{label}</span>;
}

function Thumb({ asset, className }: { asset: CampaignAssetView; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={assetSrc(asset)} alt="" width={asset.width} height={asset.height} loading="lazy" className={cn('rounded object-cover', className)} />;
}

function CreativeCard({ item, onOpen, noAi }: { item: CreativeItem; onOpen: (key: string) => void; noAi?: boolean }) {
  const delivered = isDelivered(item);
  const a = item.asset;
  const chips = flagChips(item.flags);
  const src = item.sources[0];
  const bad = item.tone === 'failed' || item.tone === 'nofile';
  const alt = item.type === 'original' ? (a?.altText ?? `${item.conceptName}: ${item.title} (conceptual AI image)`) : (a?.altText ?? `${item.conceptName}: ${item.title} (template creative, not an AI image)`);
  return (
    <li data-testid="hybrid-card" data-type={item.type} data-tone={item.tone} data-delivered={delivered ? 'yes' : 'no'} className={cn('flex flex-col overflow-hidden rounded-2xl border bg-cream-50', TONE_RING[item.tone])}>
      <div className="relative">
        {delivered && a ? (
          <button type="button" onClick={() => onOpen(item.key)} className="flex h-56 w-full items-center justify-center bg-cream-200/60 p-2" aria-label={`Open the details of ${item.title}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={assetSrc(a)} alt={alt} width={a.width} height={a.height} loading="lazy" className="h-auto max-h-full w-auto max-w-full rounded-md object-contain shadow-sm" />
          </button>
        ) : (
          <div data-testid="hybrid-placeholder" className={cn('flex h-56 w-full flex-col items-center justify-center gap-2 p-4 text-center text-xs', bad ? 'bg-red-50 text-red-800' : item.tone === 'budget' ? 'bg-amber-50 text-amber-900' : 'bg-cream-200/60 text-muted')}>
            {item.tone === 'failed' ? <XCircle className="h-6 w-6" /> : <ImageOff className="h-6 w-6" />}
            <p className="font-medium">{item.type === 'original' ? 'No original AI image' : 'No template creative'}</p>
            <p>{item.statusLabel}</p>
            <p className="rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-medium text-ink-600">Not counted as delivered</p>
          </div>
        )}
        <OriginBadge item={item} />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3 text-xs">
        <p className="text-sm font-medium">
          {item.type === 'template' ? tplLabel(item.title, item.templateVersion ?? 1) : item.title}
        </p>
        <p className="text-muted">
          <strong className="text-ink-600">{item.conceptName}</strong>
          {item.type === 'template' && item.channel ? ` · ${channelFormat(item.channel, item.formatLabel)}` : item.variation ? ` · ${ROLE_LABEL[item.variation.role] ?? item.variation.role} · ${item.formatLabel}` : ''}
          {item.type === 'template' && a && !item.formatLabel.includes('×') ? ` · ${a.width}×${a.height}` : ''}
        </p>
        {item.tone !== 'ok' && (
          <p role="note" className={cn('rounded-lg px-2 py-1.5 font-medium', item.tone === 'fallback' ? 'bg-amber-50 text-amber-900' : item.tone === 'failed' || item.tone === 'nofile' ? 'bg-red-50 text-red-800' : item.tone === 'budget' ? 'bg-amber-50 text-amber-900' : 'bg-cream-100 text-ink-600')}>
            {item.type === 'original' && item.tone === 'budget' ? 'Stopped by the campaign budget' : item.statusLabel}
          </p>
        )}
        {item.reason && item.tone !== 'ok' && <p className="text-muted">{item.reason}</p>}
        {item.type === 'template' && item.tone === 'ok' && item.reason && <p className="text-muted">{item.reason}</p>}
        {item.type === 'original' && item.variation && (item.tone === 'ok' || item.variation.requestAttempted) && (
          <p className="text-muted">
            {item.tone === 'ok' ? 'Made by' : 'Requested from'} <span className="font-mono text-ink-600">{item.variation.providerModel ?? 'an unrecorded model'}</span>
            {item.variation.quality ? ` · quality ${item.variation.quality}` : ''}
          </p>
        )}
        {item.type === 'template' && (
          <div data-testid="hybrid-source" className="flex items-center gap-2 text-muted">
            {src ? (
              <>
                {src.asset && (
                  <button type="button" disabled={!src.itemKey} onClick={() => src.itemKey && onOpen(src.itemKey)} className="shrink-0 overflow-hidden rounded ring-1 ring-cream-300 enabled:hover:ring-accent" aria-label={`Open ${src.label}`}>
                    <Thumb asset={src.asset} className="h-9 w-9" />
                  </button>
                )}
                {!src.asset && src.thumb && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={src.thumb} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded object-cover ring-1 ring-cream-300" />
                )}
                <span>
                  {delivered ? 'Built from' : 'Planned to use'}: {src.label}
                  {item.sources.length > 1 ? ` + ${item.sources.length - 1} more` : ''}
                </span>
              </>
            ) : (
              <span>{noAi ? NO_PICTURE : item.tone === 'fallback' ? 'Built without a picture: the planned original does not exist.' : 'No source image: a picture-free template.'}</span>
            )}
          </div>
        )}
        {noAi && item.type === 'template' && (
          <div data-testid="creative-rights" className="space-y-0.5 rounded-lg bg-cream-100 px-2 py-1.5 text-muted">
            {src?.library ? (
              <>
                <p>
                  Picture: {SOURCE_LABEL[src.library.source]} · {src.library.license}
                  {src.library.via === 'auto_stock' ? ' · added automatically' : ''}
                </p>
                {src.library.attribution && (
                  <p>
                    Credit: {src.library.attribution}
                    {src.library.attributionRequired ? ' (credit required)' : ''}
                  </p>
                )}
              </>
            ) : (
              <p>No picture: nothing to credit.</p>
            )}
            {a?.rights?.note && <p>Rights: {a.rights.note}</p>}
          </div>
        )}
        {delivered && item.type === 'template' && item.creative?.logo && (
          <p data-testid="creative-logo" data-applied={item.creative.logo.applied ? 'yes' : 'no'} className={cn('rounded-lg px-2 py-1', item.creative.logo.applied ? 'bg-emerald-50 text-emerald-900' : 'bg-cream-100 text-ink-600')}>
            {item.creative.logo.applied ? 'Logo: applied' : `Logo omitted: ${item.creative.logo.reason ?? 'no reason was recorded'}`}
          </p>
        )}
        {chips.length > 0 && (
          <p className="flex flex-wrap gap-1">
            {chips.map((c) => (
              <span key={c.key} title={c.key} className={cn('rounded-full px-2 py-0.5 text-[11px]', c.warn ? 'bg-amber-100 text-amber-900' : 'bg-cream-200 text-ink-600')}>
                {c.text}
              </span>
            ))}
          </p>
        )}
        <div className="mt-auto flex flex-wrap gap-2 pt-1.5">
          {delivered && a && (
            <Button asChild size="sm" variant="outline">
              <a data-testid="download-creative" href={assetSrc(a)} download={`${fileSlug(item.conceptName)}-${fileSlug(item.title)}-${a.width}x${a.height}.png`}>
                <Download className="h-3.5 w-3.5" /> Download
              </a>
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onOpen(item.key)}>
            <Info className="h-3.5 w-3.5" /> Details
          </Button>
        </div>
      </div>
    </li>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-2 border-t border-cream-300/60 py-1.5 first:border-t-0">
      <dt className="text-[11px] uppercase tracking-wider text-muted">{k}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

function DetailDialog({ item, onClose, onOpen }: { item: CreativeItem | null; onClose: () => void; onOpen: (key: string) => void }) {
  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      {item && <DetailBody item={item} onOpen={onOpen} />}
    </Dialog>
  );
}

function DetailBody({ item, onOpen }: { item: CreativeItem; onOpen: (key: string) => void }) {
  const a = item.asset;
  const delivered = isDelivered(item);
  const v = item.variation;
  const rights = a?.rights ?? null;
  const chips = flagChips(item.flags);
  return (
    <DialogContent title={item.type === 'template' ? tplLabel(item.title, item.templateVersion ?? 1) : item.title} description={`${item.type === 'original' ? 'Original AI image' : 'Template creative'} · ${item.conceptName}`} className="max-h-[90vh] max-w-4xl overflow-y-auto">
      <div data-testid="hybrid-detail" className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="flex items-start justify-center rounded-xl bg-cream-200/60 p-3">
          {delivered && a ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={assetSrc(a)} alt={a.altText ?? item.title} width={a.width} height={a.height} className="h-auto max-h-[60vh] w-auto max-w-full rounded-md object-contain shadow-sm" />
          ) : (
            <div className="flex min-h-[12rem] w-full flex-col items-center justify-center gap-2 text-center text-sm text-muted">
              <ImageOff className="h-7 w-7" />
              <p className="font-medium">{item.statusLabel}</p>
              <p className="text-xs">Not counted as delivered.</p>
            </div>
          )}
        </div>
        <dl>
          <Row k="Status">{item.statusLabel}</Row>
          {item.reason && <Row k="Reason">{item.reason}</Row>}
          <Row k="Production type">{item.type === 'original' ? 'Original AI image (conceptual marketing visual)' : 'Template creative (rendered locally, not an AI image)'}</Row>
          <Row k="Origin">{item.origin && a ? `${ORIGIN_LABELS[item.origin]} · ${item.origin}` : 'none: no file was made'}</Row>
          <Row k="Asset id">{a ? <span className="font-mono text-xs">{a.id}</span> : <span className="text-muted">none</span>}</Row>
          {item.slotId && <Row k="Planned slot"><span className="font-mono text-xs">{item.slotId}</span></Row>}
          {v && <Row k="Planned image"><span className="font-mono text-xs">{v.variationId}</span> · {ROLE_LABEL[v.role] ?? v.role}</Row>}
          <Row k="Concept">{item.conceptName}</Row>
          {item.channel && <Row k="Channel">{channelLabel(item.channel)}</Row>}
          <Row k="Format">{item.formatLabel}{a ? ` · ${item.formatLabel.includes('×') ? '' : `${a.width}×${a.height} px · `}${(a.bytes / 1024).toFixed(0)} KB` : ''}</Row>
          {item.type === 'template' && (
            <Row k="Template">
              {item.templateName} <span className="text-muted">v{item.templateVersion}</span>
              <span className="block font-mono text-xs text-muted">{item.templateId}</span>
            </Row>
          )}
          {item.type === 'template' && (
            <Row k="Built from">
              {item.sources.length === 0 ? (
                <span className="text-muted">No source image was used (a picture-free template).</span>
              ) : (
                <ul className="space-y-1.5">
                  {item.sources.map((s) => (
                    <li key={s.ref} className="flex items-center gap-2">
                      {s.asset && <Thumb asset={s.asset} className="h-10 w-10 shrink-0" />}
                      {!s.asset && s.thumb && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.thumb} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded object-cover" />
                      )}
                      <span className="min-w-0">
                        {s.label}
                        {s.library && (
                          <span className="block text-xs text-muted">
                            License: {s.library.license} · {s.library.verification.replace(/_/g, ' ')}
                            {s.library.attribution ? ` · Credit: ${s.library.attribution}${s.library.attributionRequired ? ' (credit required)' : ''}` : ''}
                            {s.library.pageUrl && (
                              <>
                                {' · '}
                                <a href={s.library.pageUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
                                  source
                                </a>
                              </>
                            )}
                          </span>
                        )}
                        <span className="block truncate font-mono text-xs text-muted">{s.ref}</span>
                        {s.itemKey && (
                          <button type="button" onClick={() => onOpen(s.itemKey!)} className="text-xs font-medium text-accent-hover underline underline-offset-2">
                            Open this original
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Row>
          )}
          {item.type === 'original' && (
            <Row k="Model and quality">
              {(v?.providerModel ?? a?.model) ? <span className="font-mono text-xs">{v?.providerModel ?? a?.model}</span> : <span className="text-muted">not recorded</span>}
              {(v?.quality ?? a?.quality) ? ` · quality ${v?.quality ?? a?.quality}` : ''}
              {v?.costUsd !== null && v?.costUsd !== undefined ? ` · ${fmtUsd(v.costUsd)}` : ''}
            </Row>
          )}
          {delivered && item.type === 'template' && item.creative?.logo && <Row k="Brand logo">{item.creative.logo.applied ? 'Applied' : `Omitted: ${item.creative.logo.reason ?? 'no reason was recorded'}`}</Row>}
          {a && <Row k="Rights">{rights ?<><strong>{RIGHTS_BASIS[rights.basis] ?? rights.basis}.</strong> {rights.note}</> : <span className="text-muted">No rights note is stored on this asset (it was saved before lineage existed).</span>}</Row>}
          {a && (
            <Row k="SHA-256">
              <span className="font-mono text-xs" title={a.sha256}>{a.sha256.slice(0, 16)}…</span>
            </Row>
          )}
          {a && <Row k="Created">{formatDate(a.createdAt)} · version {a.version}</Row>}
          {chips.length > 0 && (
            <Row k="Notes">
              <span className="flex flex-wrap gap-1">
                {chips.map((c) => (
                  <span key={c.key} title={c.key} className={cn('rounded-full px-2 py-0.5 text-[11px]', c.warn ? 'bg-amber-100 text-amber-900' : 'bg-cream-200 text-ink-600')}>
                    {c.text}
                  </span>
                ))}
              </span>
            </Row>
          )}
        </dl>
      </div>
      {delivered && a && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild size="sm">
            <a href={assetSrc(a)} download={`${fileSlug(item.conceptName)}-${fileSlug(item.title)}-${a.width}x${a.height}.png`}>
              <Download className="h-3.5 w-3.5" /> Download PNG
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href={assetSrc(a)} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" /> Open
            </a>
          </Button>
        </div>
      )}
    </DialogContent>
  );
}

/** The gallery of every finished creative: originals and template creatives apart, with lineage, flags, reasons and downloads. */
export function HybridCreatives({ pkg, hybrid, assets, campaignId }: { pkg: CampaignPackageData; hybrid: HybridBlockData; assets: CampaignAssetView[]; campaignId: string }) {
  const [view, setView] = React.useState<View>('concept');
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const noAi = !!hybrid.imagery;
  const views = noAi ? NO_AI_VIEWS.map((id) => VIEWS.find((v) => v.id === id)!) : VIEWS.filter((v) => v.id !== 'source');
  const items = React.useMemo(() => buildCreativeItems(pkg, hybrid, assets), [pkg, hybrid, assets]);
  const groups = React.useMemo(() => groupItems(items, view), [items, view]);
  const open = items.find((i) => i.key === openKey) ?? null;
  const delivered = items.filter(isDelivered);
  const missing = items.length - delivered.length;
  return (
    <div data-testid="hybrid-gallery" className="space-y-5">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-sm font-semibold">
            {delivered.length} of {items.length} creatives delivered
          </p>
          <p className="text-xs text-muted">
            {noAi ? 'AI-generated images: 0' : `${delivered.filter((i) => i.type === 'original').length} original AI image(s)`} · {delivered.filter((i) => i.type === 'template').length} template creative(s)
            {missing > 0 ? ` · ${missing} planned but not delivered (shown as empty cards with the reason)` : ''}
          </p>
        </div>
        <HybridDownloads campaignId={campaignId} hybrid={hybrid} />
      </Card>

      <div role="group" aria-label="Group the creatives" className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted">View</span>
        {views.map((v) => (
          <button key={v.id} type="button" aria-pressed={view === v.id} data-testid={`view-${v.id}`} onClick={() => setView(v.id)} className={cn('rounded-full border px-3 py-1 text-xs', view === v.id ? 'border-ink bg-ink text-cream-100' : 'border-cream-300 bg-cream-50 text-ink-600 hover:bg-cream-100')}>
            {v.label}
          </button>
        ))}
      </div>

      {items.length === 0 && <Empty text="No creative was planned for this campaign." />}
      {groups.map((g) => {
        const ok = g.items.filter(isDelivered).length;
        return (
          <section key={g.key} data-testid="hybrid-group" data-group={g.key}>
            <h4 className="mb-1 flex flex-wrap items-baseline gap-2 text-sm font-semibold">
              {g.title}
              <span className="text-xs font-normal text-muted">
                {ok} of {g.items.length} delivered
                {view === 'concept' && !noAi ? ` · ${g.items.filter((i) => i.type === 'original').length} original, ${g.items.filter((i) => i.type === 'template').length} template` : ''}
              </span>
            </h4>
            {g.note && <p className="mb-2 text-xs text-muted">{g.note}</p>}
            <ul className="mt-2 grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {g.items.map((it) => (
                <CreativeCard key={it.key} item={it} onOpen={setOpenKey} noAi={noAi} />
              ))}
            </ul>
          </section>
        );
      })}
      <DetailDialog item={open} onClose={() => setOpenKey(null)} onOpen={setOpenKey} />
    </div>
  );
}

// ---- visual direction -------------------------------------------------------------------------------------------------------------------

const PERMISSION: Record<VisualReferenceRecord['permission'], { label: string; cls: string }> = {
  platform_restricted_not_stored: { label: 'Pinterest — shown to you only, never stored, analyzed or sent to AI', cls: 'bg-red-50 text-red-800 ring-1 ring-red-200' },
  link_only_not_analyzed: { label: 'Link only — not opened or analyzed', cls: 'bg-amber-50 text-amber-900 ring-1 ring-amber-200' },
  owned_by_user: { label: 'Yours', cls: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' },
  user_provided: { label: 'Yours', cls: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' },
  original_to_launchpilot: { label: 'LaunchPilot original', cls: 'bg-sky-50 text-sky-800 ring-1 ring-sky-200' },
  licensed: { label: 'Licensed', cls: 'bg-sky-50 text-sky-800 ring-1 ring-sky-200' },
};
const DIRECTION_ORIGIN: Record<VisualDirectionData['origin'], string> = {
  deterministic: 'Built from the style library, your brand and the strategy, with no model call.',
  model_refined: 'Built from the style library, then refined by one text-model call.',
  user_approved: 'Built from the style library and approved by you before the run.',
};
const CONFIDENCE: Record<VisualDirectionData['confidence'], string> = { low: 'bg-red-100 text-red-700', medium: 'bg-amber-100 text-amber-800', high: 'bg-emerald-100 text-emerald-800' };
const isHex = (c: string) => /^#[0-9a-f]{3,8}$/i.test(c);

function Chips({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="mb-1 text-[11px] uppercase tracking-wider text-muted">{title}</p>
      <ul className="flex flex-wrap gap-1">
        {items.map((s, i) => (
          <li key={i} className="rounded-full bg-cream-200 px-2 py-0.5 text-xs text-ink-600">
            {s}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HybridDirectionCard({ direction }: { direction: VisualDirectionData | null }) {
  if (!direction) return <Card data-testid="hybrid-direction"><H>Visual direction</H><p className="mt-2 text-sm text-muted">No visual direction was recorded for this campaign.</p></Card>;
  const d = direction;
  const swatches: [string, string][] = [['Primary', d.colors.primary], ['Secondary', d.colors.secondary], ['Accent', d.colors.accent], ['Ink', d.colors.ink], ['Paper', d.colors.paper]];
  return (
    <Card data-testid="hybrid-direction" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <H>Visual direction</H>
        <Badge className="bg-ink text-cream-100">{styleName(d.styleId)}</Badge>
        {d.secondaryStyleIds.map((s) => (
          <Badge key={s} className="bg-cream-200 text-ink-600">
            also {styleName(s)}
          </Badge>
        ))}
        <Badge className={CONFIDENCE[d.confidence]}>confidence {d.confidence}</Badge>
      </div>
      <p className="text-sm">{d.rationale}</p>
      <p className="text-xs text-muted">{DIRECTION_ORIGIN[d.origin]}</p>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-wider text-muted">Palette</p>
          <ul className="flex flex-wrap gap-2">
            {swatches.map(([k, c]) => (
              <li key={k} className="w-[4.5rem] text-center" data-testid="palette-swatch">
                <span className="block h-10 rounded-lg ring-1 ring-ink/10" style={isHex(c) ? { backgroundColor: c } : undefined} title={c} />
                <span className="mt-1 block text-[11px] text-muted">{k}</span>
                <span className="block font-mono text-[10px]">{c}</span>
              </li>
            ))}
          </ul>
          {d.colors.notes && <p className="text-xs text-muted">{d.colors.notes}</p>}
        </div>
        <div className="space-y-1 text-sm">
          <p className="text-[11px] uppercase tracking-wider text-muted">Typography</p>
          <p>
            <strong>Headlines:</strong> {d.typography.headline}
          </p>
          <p>
            <strong>Body:</strong> {d.typography.body}
          </p>
          {d.typography.notes && <p className="text-xs text-muted">{d.typography.notes}</p>}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Chips title="Composition" items={d.composition} />
        <Chips title="Mood" items={d.mood} />
        <Chips title="Image subjects" items={d.imageSubjects} />
        <Chips title="Image treatment" items={d.imageTreatment} />
      </div>

      {d.channelNotes.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] uppercase tracking-wider text-muted">By channel</p>
          <ul className="space-y-0.5 text-xs">
            {d.channelNotes.map((n, i) => (
              <li key={i}>
                <strong>{channelLabel(n.channel)}:</strong> <span className="text-muted">{n.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div data-testid="hybrid-references">
        <p className="mb-1 text-[11px] uppercase tracking-wider text-muted">References ({d.references.length})</p>
        {d.references.length === 0 ? (
          <p className="text-xs text-muted">No reference was used: the direction comes from the style library, your brand and the strategy.</p>
        ) : (
          <ul className="space-y-2">
            {d.references.map((r) => {
              const p = PERMISSION[r.permission] ?? { label: r.permission, cls: 'bg-cream-200 text-ink-600' };
              // a reference from a platform that does not allow storing it is never linked or shown beyond its label
              const link = r.url && r.permission === 'link_only_not_analyzed';
              return (
                <li key={r.id} data-permission={r.permission} className="rounded-xl bg-cream-100 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm">{link ? <a href={r.url!} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">{r.label}</a> : r.label}</strong>
                    <Badge className={cn('whitespace-normal px-2 py-0.5 text-[11px]', p.cls)}>{p.label}</Badge>
                    <span className="text-muted">{pretty(r.kind)}</span>
                  </div>
                  <p className="mt-0.5 text-muted">{r.used}</p>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted">Nothing from Pinterest is stored in a campaign package, analyzed or sent to an AI model.</p>
      </div>

      {d.limitations.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] uppercase tracking-wider text-muted">Limitations</p>
          <ul className="space-y-1 text-xs text-muted">
            {d.limitations.map((l, i) => (
              <li key={i} className="flex gap-2">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {l}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ---- template selection and quality -----------------------------------------------------------------------------------------------------

const MODE_LABEL: Record<'deterministic' | 'assisted' | 'user_override', { label: string; cls: string }> = {
  deterministic: { label: 'Deterministic', cls: 'bg-cream-200 text-ink-600' },
  assisted: { label: 'Assisted', cls: 'bg-sky-100 text-sky-800' },
  user_override: { label: 'Your choice', cls: 'bg-emerald-100 text-emerald-800' },
};

export function HybridSelectionTable({ selection, creatives }: { selection: TemplateSelectionPlanData | null; creatives: TemplateCreativeData[] }) {
  if (!selection || selection.items.length === 0) return <Card data-testid="hybrid-selection"><H>Template selection</H><p className="mt-2 text-sm text-muted">No template selection was recorded for this campaign.</p></Card>;
  const bySlot = new Map(creatives.map((c) => [c.slotId, c]));
  return (
    <Card data-testid="hybrid-selection" className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <H>Template selection</H>
        <span className="text-xs text-muted">
          {selection.items.length} creative(s) · {selection.eligibleCount} of {selection.libraryCount} library templates were eligible · mode {selection.mode}
        </span>
      </div>
      {selection.warnings.length > 0 && (
        <ul data-testid="selection-warnings" className="space-y-1 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {selection.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-left text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Creative</th>
              <th className="py-1.5 pr-3 font-medium">Template</th>
              <th className="py-1.5 pr-3 font-medium">Why it was chosen</th>
              <th className="py-1.5 pr-3 font-medium" title="Sum of the rule points the template scored for this creative. Higher is better; it is not a percentage.">
                Score
              </th>
              <th className="py-1.5 pr-3 font-medium">How</th>
              <th className="py-1.5 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {selection.items.map((it) => {
              const c = bySlot.get(it.slotId);
              const m = MODE_LABEL[it.origin];
              const swapped = c && c.templateId !== it.templateId;
              return (
                <tr key={it.slotId} data-testid="selection-row" className="border-t border-cream-300/70 align-top">
                  <td className="py-1.5 pr-3">
                    <strong>{it.conceptName}</strong>
                    <span className="block text-muted">{channelFormat(it.channel, formatLabel(it.format, it.width, it.height))}</span>
                  </td>
                  <td className="py-1.5 pr-3">
                    {tplLabel(it.templateName, it.templateVersion)}
                    <span className="block text-muted">{pretty(it.category)}</span>
                  </td>
                  <td className="max-w-[22rem] py-1.5 pr-3 text-muted">{it.rationale}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{it.score.toFixed(1)}</td>
                  <td className="py-1.5 pr-3">
                    <Badge className={cn('px-2 py-0.5 text-[11px]', m.cls)} title={it.origin === 'assisted' ? 'One text-model call re-ranked a validated shortlist' : it.origin === 'user_override' ? 'You picked this template' : 'Chosen by the scoring rules, no model call'}>
                      {m.label}
                    </Badge>
                  </td>
                  <td className="py-1.5">
                    {c ? (
                      <span className={c.status === 'rendered' ? 'text-emerald-700' : c.status === 'fallback_rendered' ? 'text-amber-800' : c.status === 'failed' ? 'text-red-700' : 'text-muted'}>
                        {c.status === 'rendered' ? 'Rendered' : c.status === 'fallback_rendered' ? 'FALLBACK' : c.status === 'failed' ? 'Failed' : 'Not rendered'}
                        {swapped ? <span className="block text-muted">with {tplLabel(c.templateName, c.templateVersion)}</span> : null}
                      </span>
                    ) : (
                      <span className="text-muted">no record</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {selection.rules.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">How templates are chosen ({selection.rules.length} rule{selection.rules.length === 1 ? '' : 's'})</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {selection.rules.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

const SEVERITY: Record<TemplateQualityData['issues'][number]['severity'], string> = { blocker: 'bg-red-200 text-red-900', major: 'bg-red-100 text-red-700', minor: 'bg-amber-100 text-amber-800' };

export function HybridQualityCard({ quality }: { quality: TemplateQualityData | null }) {
  if (!quality) return <Card data-testid="hybrid-quality"><H>Template quality check</H><p className="mt-2 text-sm text-muted">The Template Quality Reviewer did not report for this campaign, so the template creatives were not checked against the plan.</p></Card>;
  return (
    <Card data-testid="hybrid-quality" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <H>Template quality check</H>
        <Badge className={quality.complete ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}>
          {quality.complete ? <Check className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />} {quality.complete ? 'complete' : 'not complete'}
        </Badge>
      </div>
      <p className="text-sm">{quality.summary}</p>
      <p className="text-xs text-muted">
        {quality.planned} planned · {quality.rendered} rendered · {quality.fallbackRendered} fallback · {quality.failed} failed · {quality.skipped} not rendered · {quality.checkedFiles} file(s) opened and checked
      </p>
      {quality.issues.length === 0 ? (
        <p className="text-xs text-muted">No issue was found.</p>
      ) : (
        <ul className="space-y-1.5">
          {quality.issues.map((i, n) => (
            <li key={n} data-testid="quality-issue" className="rounded-xl bg-cream-100 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={cn('px-2 py-0.5 text-[11px]', SEVERITY[i.severity])}>{i.severity}</Badge>
                <span className="font-mono">{i.kind}</span>
                {i.slotId && <span className="font-mono text-muted">{i.slotId}</span>}
                <span className={i.repairable ? 'text-sky-800' : 'text-muted'}>{i.repairable ? 'can be rendered again' : 'not repairable'}</span>
              </div>
              <p className="mt-0.5">{i.message}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Visual direction, template selection and the template quality check, one under the other. */
export function HybridDirectionTab({ hybrid }: { hybrid: HybridBlockData }) {
  return (
    <div data-testid="hybrid-direction-tab" className="space-y-5">
      <HybridDirectionCard direction={hybrid.direction} />
      <HybridSelectionTable selection={hybrid.selection} creatives={hybrid.creatives} />
      <HybridQualityCard quality={hybrid.quality} />
    </div>
  );
}
