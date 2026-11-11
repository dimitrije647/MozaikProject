'use client';

import * as React from 'react';
import { AlertCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { PALETTE_ROLES, ROLE_LABELS, SOURCE_LABELS, contrastRatio, isHex, type Confidence, type DesignPalette, type PaletteConflictData, type PaletteEvidence, type PaletteRole } from '@/lib/visual';
import { cn } from '@/lib/utils';

const CONF_STYLE: Record<Confidence, string> = { high: 'bg-emerald-100 text-emerald-800', medium: 'bg-amber-100 text-amber-900', low: 'bg-cream-200 text-ink-600' };

/** One color: a real color picker, a hex field that keeps what is typed until it is valid, where the color came from and how sure that is. */
function ColorRow({ role, value, evidence, edited, onChange }: { role: PaletteRole; value: string; evidence?: PaletteEvidence; edited: boolean; onChange: (hex: string) => void }) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const shown = draft ?? value;
  const bad = draft !== null && !isHex(draft);
  const src = evidence ? SOURCE_LABELS[evidence.source] : 'Default';
  return (
    <li data-testid={`palette-row-${role}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-cream-100 px-3 py-2">
      <span className="w-24 text-sm font-medium text-ink">{ROLE_LABELS[role]}</span>
      <input type="color" data-testid={`palette-color-${role}`} aria-label={`${ROLE_LABELS[role]} color`} value={value} onChange={(e) => onChange(e.target.value)} className="h-9 w-12 cursor-pointer rounded-lg border border-cream-300 bg-transparent p-0.5" />
      <Input
        data-testid={`palette-hex-${role}`}
        aria-label={`${ROLE_LABELS[role]} hex value`}
        aria-invalid={bad}
        maxLength={7}
        className={cn('h-9 w-28 font-mono text-xs', bad && 'border-red-400')}
        value={shown}
        onChange={(e) => {
          const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
          setDraft(v);
          if (isHex(v)) onChange(v.toLowerCase());
        }}
        onBlur={() => setDraft(null)}
      />
      <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <Badge data-testid={`palette-source-${role}`} className="bg-white px-2 py-0.5 text-[10px] text-ink-600">
          {edited ? 'Edited by you' : src}
        </Badge>
        {evidence && (
          <Badge data-testid={`palette-confidence-${role}`} className={cn('px-2 py-0.5 text-[10px]', CONF_STYLE[evidence.confidence])}>
            {evidence.confidence === 'high' ? 'High' : evidence.confidence === 'medium' ? 'Medium' : 'Low'} confidence
          </Badge>
        )}
      </span>
      {evidence && <span className="basis-full truncate pl-[6.5rem] text-[11px] text-muted" title={evidence.evidence}>{evidence.evidence}</span>}
    </li>
  );
}

export interface PaletteEditorProps {
  palette: DesignPalette;
  evidence: Partial<Record<PaletteRole, PaletteEvidence>>;
  overridden: PaletteRole[];
  onChange: (role: PaletteRole, hex: string) => void;
  onResetDetected?: () => void;
  onRestoreDefaults: () => void;
  onReanalyze?: () => void;
  analyzing?: boolean;
  analysisNote?: string | null;
  conflicts?: PaletteConflictData[];
  /** problems that make the palette unreadable (the design cannot be confirmed with them) */
  errors: string[];
  /** things to look at */
  notes: string[];
  minTextContrast: number;
}

export function PaletteEditor({ palette, evidence, overridden, onChange, onResetDetected, onRestoreDefaults, onReanalyze, analyzing, analysisNote, conflicts = [], errors, notes, minTextContrast }: PaletteEditorProps) {
  const ratio = contrastRatio(palette.text, palette.background);
  return (
    <div data-testid="palette-editor" className="space-y-3">
      <ul className="space-y-1.5">
        {PALETTE_ROLES.map((r) => (
          <ColorRow key={r} role={r} value={palette[r]} evidence={evidence[r]} edited={overridden.includes(r)} onChange={(hex) => onChange(r, hex)} />
        ))}
      </ul>
      <p data-testid="palette-contrast" className={cn('text-xs', ratio >= minTextContrast ? 'text-emerald-800' : 'text-red-700')}>
        Text on background: {ratio.toFixed(1)}:1 {ratio >= minTextContrast ? `(readable, at least ${minTextContrast}:1)` : `(too low: at least ${minTextContrast}:1 is needed)`}
      </p>
      {errors.map((e) => (
        <p key={e} role="alert" data-testid="palette-error" className="flex items-start gap-1.5 text-xs text-red-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {e}
        </p>
      ))}
      {conflicts.length > 0 && (
        <div data-testid="palette-conflicts" className="space-y-1 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
          <p className="font-semibold">Your sources disagree</p>
          {conflicts.map((c) => (
            <p key={c.role}>{c.message}</p>
          ))}
        </div>
      )}
      {notes.map((n) => (
        <p key={n} className="text-xs text-amber-900">
          {n}
        </p>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {onResetDetected && (
          <Button type="button" size="sm" variant="outline" data-testid="palette-reset" onClick={onResetDetected}>
            <RotateCcw className="h-3.5 w-3.5" /> Reset to detected colors
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" data-testid="palette-defaults" onClick={onRestoreDefaults}>
          Restore collection defaults
        </Button>
        {onReanalyze && (
          <Button type="button" size="sm" variant="outline" data-testid="palette-reanalyze" loading={analyzing} onClick={onReanalyze}>
            <RefreshCw className="h-3.5 w-3.5" /> Re-analyze my sources
          </Button>
        )}
      </div>
      {analysisNote && <p className="text-[11px] text-muted">{analysisNote}</p>}
    </div>
  );
}
