'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { CLASS_LABELS } from '@/lib/hybrid';
import { collectionPreviewUrl, type CollectionData, type DesignPalette } from '@/lib/visual';
import { cn } from '@/lib/utils';

/**
 * One template collection as a card: real previews drawn by the server's renderer (never stock pictures), its formats, industries and default
 * direction. The same card is used by the Templates page and by the campaign design, so a collection looks the same everywhere.
 * `palette` redraws the previews with the user's colors (the same endpoint, only the query changes).
 */
export function CollectionCard({
  c,
  selected = false,
  onSelect,
  palette,
  count = 3,
  testId,
  action,
}: {
  c: CollectionData;
  selected?: boolean;
  onSelect?: () => void;
  palette?: DesignPalette;
  count?: number;
  testId?: string;
  action?: React.ReactNode;
}) {
  const previews = c.previews.slice(0, Math.max(3, count));
  const Wrapper = onSelect ? 'button' : 'div';
  return (
    <Wrapper
      {...(onSelect ? { type: 'button' as const, onClick: onSelect, 'aria-pressed': selected } : {})}
      data-testid={testId ?? `collection-${c.id}`}
      data-selected={selected ? 'true' : 'false'}
      className={cn('flex w-full flex-col rounded-2xl border p-3 text-left transition-colors', selected ? 'border-accent bg-accent-soft/30 ring-2 ring-accent/40' : 'border-cream-300 bg-cream-50 hover:bg-cream-100', onSelect ? 'cursor-pointer' : '')}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            {String(c.number).padStart(2, '0')} · {c.designCategory}
          </p>
          <h3 className="mt-0.5 text-base font-semibold text-ink">{c.name}</h3>
        </div>
        {selected && (
          <Badge className="bg-accent text-white">
            <Check className="h-3 w-3" /> Selected
          </Badge>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">{c.tagline}</p>
      <div className="mt-2 flex h-28 items-end gap-1.5 overflow-hidden rounded-xl bg-cream-200/70 p-1.5">
        {previews.map((p, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={`${p.templateId}-${p.class}-${i}`} src={collectionPreviewUrl(c.id, { template: p.templateId, class: p.class, palette })} alt={`${c.name}: ${p.templateId.replace(/_/g, ' ')} (${CLASS_LABELS[p.class]})`} loading="lazy" className="h-full w-auto min-w-0 rounded-md object-contain shadow-sm" />
        ))}
      </div>
      <p className="mt-2 line-clamp-2 text-xs text-ink-600" title={c.description}>
        {c.description}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {c.supportedFormats.slice(0, 6).map((f) => (
          <Badge key={f.id} className="bg-cream-200 px-2 py-0.5 text-[10px] text-ink-600">
            {f.label.replace(/ \(.*\)/, '')}
          </Badge>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted">
        <strong className="text-ink-600">Suits:</strong> {c.industries.slice(0, 4).join(', ')}
      </p>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted">
        <span className="flex overflow-hidden rounded-md border border-cream-300">
          {[c.defaultPalette.primary, c.defaultPalette.secondary, c.defaultPalette.accent, c.defaultPalette.background].map((h) => (
            <span key={h} className="h-4 w-4" style={{ background: h }} title={h} />
          ))}
        </span>
        <span>{c.fonts.join(' + ')} · {c.templates.length} templates</span>
      </div>
      {action}
    </Wrapper>
  );
}
