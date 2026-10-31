import { MarketingAuditReport } from '../audit/schemas';
import type { F1Context } from '../audit/context';

/**
 * What F3 receives from F2: a compact, read-only view of ONE completed audit (the report plus its findings with
 * provenance). Built by the backend from the stored audit; F3 never rebuilds or fabricates it. Together with the F1
 * context it is the F3Context: the product identity (F1) and what was observed about its marketing (F2).
 */
export interface F2Context {
  auditId: string;
  schemaVersion: number;
  generatedAt: string | null;
  model: string | null;
  partial: boolean;
  /** The F1 report this audit was built on (checked against the F1 context by the backend). */
  f1ReportId: string;
  report: MarketingAuditReport;
  findings: { id: string; agent: string; area: string; kind: string; title: string; statement: string; classification: string; severity: string; locator: string | null; excerpt: string | null; recommendation: string | null }[];
}

interface StoredAuditMeta {
  generatedAt?: string;
  model?: string;
  partial?: boolean;
  findings?: { id: string; agent: string; area: string; kind: string; title: string; statement: string; classification: string; severity: string; locator?: string | null; excerpt?: string | null; recommendation?: string | null }[];
}

const SEV = ['critical', 'high', 'medium', 'low', 'info'];

/** Returns null when the stored audit is not a valid F2 report. */
export function buildF2Context(row: { id: string; f1ReportId: string; schemaVersion: number; reportJson: unknown; metadataJson: unknown; createdAt: Date }): F2Context | null {
  const parsed = MarketingAuditReport.safeParse(row.reportJson);
  if (!parsed.success) return null;
  const meta = (row.metadataJson ?? {}) as StoredAuditMeta;
  const findings = [...(meta.findings ?? [])]
    .sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity))
    .slice(0, 40)
    .map((f) => ({ id: f.id, agent: f.agent, area: f.area, kind: f.kind, title: String(f.title).slice(0, 140), statement: String(f.statement).slice(0, 400), classification: f.classification, severity: f.severity, locator: f.locator ?? null, excerpt: f.excerpt ? String(f.excerpt).slice(0, 240) : null, recommendation: f.recommendation ? String(f.recommendation).slice(0, 240) : null }));
  return {
    auditId: row.id,
    schemaVersion: row.schemaVersion,
    generatedAt: meta.generatedAt ?? row.createdAt.toISOString(),
    model: meta.model ?? null,
    partial: parsed.data.partial,
    f1ReportId: row.f1ReportId,
    report: parsed.data,
    findings,
  };
}

/** The business's own brief for the campaign (current project data; F1/F2 describe the past). */
export interface StrategyInput {
  projectName: string;
  language: string;
  /** Where the business operates: F1 geography plus the intake's target market. */
  geography: string[];
  targetAudience: string | null;
  marketingGoal: string | null;
  campaignDuration: string | null;
  budgetNote: string | null;
  websiteUrl: string | null;
  socialProfiles: { platform: string; url: string }[];
  /** Competitor URLs the user supplied (analyzed first; never invented). */
  competitorUrls: string[];
  /** Competitor NAMES the user supplied (looked up with one bounded search each; never guessed). */
  competitorNames: string[];
  /** The user's opt-in to ask the free public-holiday calendar (intake: seasonal calendar). */
  useHolidayCalendar: boolean;
}

export interface CompetitorLead {
  title: string;
  url: string;
  snippet: string;
  origin: 'user_supplied' | 'user_named' | 'search_lead';
  fetched: boolean;
  sourceId: string | null;
  note: string | null;
  host: string | null;
  /** Pages of this competitor's site that were read (home plus relevant same-site pages). */
  pages: number;
  /** How the home page was read: served HTML, or the rendering/extraction provider. */
  via: 'html' | 'extract' | null;
  /** Social networks the competitor links to from its own pages (an observation about links, nothing more). */
  socialPlatforms: string[];
  structuredDataTypes: string[];
}

export interface StrategyFacts {
  competitors: {
    provider: string;
    searchUsed: boolean;
    queries: string[];
    leads: CompetitorLead[];
    userSupplied: number;
    userNamed: number;
    notFoundNames: string[];
    gaps: string[];
    pagesRetrieved: number;
    extractUsed: boolean;
  } | null;
  holidays: { used: boolean; country: string | null; note: string; holidays: { date: string; name: string }[] } | null;
}

export const ageDays = (now: Date, iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / 86_400_000)) : null;
};

/** An audit/report older than this is shown with its age and its verified findings are not carried forward as verified. */
export const STALE_AFTER_DAYS = 30;

export type { F1Context };
