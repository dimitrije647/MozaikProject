import { ProductDiscoveryReportV2 } from '../discovery/f1/schemas';
import { readStoredReport, type ReadNotes, type ReportFailure } from '../contracts/report-contract';
import type { PageSpeedOutcome } from '../tools/pagespeed';
import type { PresenceFacts } from '../tools/presence';
import type { SiteAudit } from '../tools/seo';

/**
 * What F2 receives from F1: a compact, read-only view of ONE completed F1 report (its Product Manifest, its
 * findings with provenance and its sources). Built by the backend from the stored report; F2 never rebuilds or
 * fabricates it. The exact report id travels with every F2 result.
 */
export interface F1Context {
  reportId: string;
  schemaVersion: number;
  generatedAt: string | null;
  model: string | null;
  partial: boolean;
  report: ProductDiscoveryReportV2;
  findings: { id: string; agent: string; category: string; statement: string; classification: string; locator: string | null; excerpt: string | null; sourceKind: string | null; live: boolean; fixture: boolean }[];
  sources: { id: string; kind: string; label: string; url: string | null; status: string; live: boolean; fixture: boolean }[];
  palette: string[];
}

interface StoredMeta {
  generatedAt?: string;
  model?: string;
  findings?: { id: string; agent: string; category: string; statement: string; classification: string; locator?: string | null; excerpt?: string | null; sourceId?: string | null }[];
  sources?: { id: string; kind: string; label: string; url?: string | null; status: string; live?: boolean; fixture?: boolean }[];
}

export type ReadF1 = { ok: true; context: F1Context; notes: ReadNotes } | { ok: false; failure: ReportFailure };

/**
 * Reads a stored F1 report through the shared contract (version check, validation, a list of the deterministic adjustments). Older
 * reports (version 1) have no Product Manifest and are refused with that reason, never patched up. The stored row is not changed.
 */
export function readF1Report(row: { id: string; schemaVersion: number; reportJson: unknown; metadataJson: unknown }): ReadF1 {
  const read = readStoredReport('F1', row, ProductDiscoveryReportV2);
  if (!read.ok) return read;
  const parsed = { data: read.data };
  const meta = (row.metadataJson ?? {}) as StoredMeta;
  const sources = (meta.sources ?? []).map((s) => ({ id: s.id, kind: s.kind, label: String(s.label).slice(0, 200), url: s.url ?? null, status: s.status, live: !!s.live, fixture: !!s.fixture }));
  const byId = new Map(sources.map((s) => [s.id, s]));
  const context: F1Context = {
    reportId: row.id,
    schemaVersion: row.schemaVersion,
    generatedAt: meta.generatedAt ?? null,
    model: meta.model ?? null,
    partial: parsed.data.partial,
    report: parsed.data,
    findings: (meta.findings ?? []).slice(0, 80).map((f) => {
      const src = f.sourceId ? byId.get(f.sourceId) : undefined;
      return { id: f.id, agent: f.agent, category: f.category, statement: String(f.statement).slice(0, 400), classification: f.classification, locator: f.locator ?? null, excerpt: f.excerpt ? String(f.excerpt).slice(0, 300) : null, sourceKind: src?.kind ?? null, live: !!src?.live, fixture: !!src?.fixture };
    }),
    sources,
    palette: parsed.data.productManifest.brand?.palette ?? [],
  };
  return { ok: true, context, notes: read.notes };
}

/** Returns null when the stored report cannot be read (readF1Report says exactly why). */
export function buildF1Context(row: { id: string; schemaVersion: number; reportJson: unknown; metadataJson: unknown }): F1Context | null {
  const r = readF1Report(row);
  return r.ok ? r.context : null;
}

// ---- data the tools collected for one F2 run ----------------------------------------------------------

export type SocialAccess = 'live_api' | 'user_provided' | 'export' | 'fixture' | 'unavailable' | 'not_supplied' | 'invalid';

export interface SocialRow {
  platform: string;
  url: string | null;
  access: SocialAccess;
  note: string;
  metrics: { label: string; value: string }[];
}

/** Profile details the USER typed in (not retrieved from any platform). */
export interface SocialDetails {
  platform: string;
  url?: string | null;
  bio?: string | null;
  followers?: number | null;
  postsPerMonth?: number | null;
  notes?: string | null;
}

export interface AuditFacts {
  site: SiteAudit | null;
  siteError: string | null;
  pagespeed: PageSpeedOutcome | null;
  social: SocialRow[];
  presence: PresenceFacts | null;
}
