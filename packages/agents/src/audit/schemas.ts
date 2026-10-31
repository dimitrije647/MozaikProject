import { z } from 'zod';
import { EvidenceStatus } from '../discovery/schemas';
import { AUDIT_AREAS, FINDING_KINDS, SEVERITIES } from './board';

/**
 * Wire schemas for the F2 agents and the Marketing Audit Report.
 * Every field is required ("absent" is null or an empty array) so OpenAI strict structured outputs accept them.
 */

const text = (max: number) => z.string().max(max);

export const LlmAuditFinding = z.object({
  area: z.enum(AUDIT_AREAS),
  kind: z.enum(FINDING_KINDS),
  title: z.string().min(3).max(140),
  statement: z.string().min(3).max(600),
  classification: EvidenceStatus,
  severity: z.enum(SEVERITIES),
  sourceType: z.enum(['website', 'pagespeed', 'social_api', 'user_provided', 'export', 'f1_finding', 'image', 'ai_inference']),
  /** Id of a <source> block this finding rests on (e.g. "S3"), or null. */
  sourceId: z.string().max(12).nullable(),
  /** URL, F1 finding id (for sourceType f1_finding), or a field path. */
  locator: z.string().max(300).nullable(),
  /** VERBATIM line or phrase copied from the cited source. */
  excerpt: z.string().max(400).nullable(),
  recommendation: z.string().max(420).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});
export type LlmAuditFinding = z.infer<typeof LlmAuditFinding>;

export const AuditAgentOutput = z.object({
  summary: text(1000),
  findings: z.array(LlmAuditFinding).max(12),
  missingInformation: z.array(text(300)).max(10),
});
export type AuditAgentOutput = z.infer<typeof AuditAgentOutput>;

// ---- report (what the Audit Synthesizer writes) ----------------------------------------------------

const Sev = z.enum(SEVERITIES);

export const AuditStatement = z.object({
  text: z.string().min(2).max(700),
  status: EvidenceStatus,
  severity: Sev.nullable(),
  basis: text(300),
  recommendation: text(400).nullable(),
  /** Ids of board findings this statement rests on (e.g. "A8-2"). */
  findingIds: z.array(z.string().max(20)).max(8),
});
export type AuditStatement = z.infer<typeof AuditStatement>;

const Section = z.object({ assessment: text(1000), statements: z.array(AuditStatement).max(10) });

export const AuditIssue = z.object({
  title: z.string().min(2).max(160),
  area: z.enum(AUDIT_AREAS),
  severity: Sev,
  status: EvidenceStatus,
  description: text(600),
  impact: text(400),
  recommendation: text(500),
  findingIds: z.array(z.string().max(20)).max(8),
});
export type AuditIssue = z.infer<typeof AuditIssue>;

export const AUDIT_REPORT_VERSION = 1;

export const AuditReportDraft = z.object({
  schemaVersion: z.number().int(),
  language: z.string().max(40),
  /** True when an ACTIVATED auditor failed or timed out. A skipped auditor is not a failure. */
  partial: z.boolean(),
  executiveSummary: text(2200),
  seo: Section,
  social: Section,
  brand: Section,
  messaging: Section,
  presence: Section,
  mainProblems: z.array(AuditIssue).max(10),
  contradictions: z
    .array(z.object({ topic: z.string().max(200), detail: text(700), findingIds: z.array(z.string().max(20)).max(8), status: z.enum(['open', 'resolved']) }))
    .max(10),
  strengths: z.array(AuditStatement).max(8),
  weaknesses: z.array(AuditStatement).max(10),
  opportunities: z
    .array(
      z.object({
        title: z.string().min(2).max(160),
        priority: z.enum(['high', 'medium', 'low']),
        area: z.enum(AUDIT_AREAS),
        rationale: text(500),
        effort: z.enum(['low', 'medium', 'high']),
        findingIds: z.array(z.string().max(20)).max(8),
      }),
    )
    .max(12),
  additionalLimitations: z.array(text(300)).max(8),
  f3Handoff: z.object({
    positioningQuestions: z.array(text(260)).max(8),
    audienceHypothesesToTest: z.array(text(260)).max(8),
    channelHypotheses: z.array(text(260)).max(8),
    priorityThemes: z.array(text(260)).max(8),
    constraints: z.array(text(260)).max(8),
  }),
});
export type AuditReportDraft = z.infer<typeof AuditReportDraft>;

// ---- final stored report: draft (policy-checked) + sections the SYSTEM fills from measured data -------------------

const Metric = z.object({ label: z.string(), value: z.string() });

export const MarketingAuditReport = AuditReportDraft.extend({
  /** 2. Product context, copied from the referenced F1 Product Manifest (not written by a model). */
  productContext: z.object({
    f1ReportId: z.string(),
    f1SchemaVersion: z.number(),
    f1GeneratedAt: z.string().nullable(),
    name: z.string(),
    category: z.string(),
    businessType: z.string(),
    summary: z.string(),
    offering: z.string(),
    valueProposition: z.string().nullable(),
    targetCustomers: z.array(z.string()),
    f1Confidence: z.number(),
    f1Partial: z.boolean(),
  }),
  /** 3. Measured website / technical facts. Values come from tools; unavailable stays unavailable. */
  websiteHealth: z.object({
    websiteUrl: z.string().nullable(),
    reachable: z.boolean().nullable(),
    pagesAnalyzed: z.number(),
    robots: z.string(),
    sitemap: z.string(),
    brokenInternalLinks: z.number().nullable(),
    pageSpeed: z.object({ status: z.enum(['measured', 'unavailable']), note: z.string(), metrics: z.array(Metric) }),
    perPage: z.array(z.object({ url: z.string(), status: z.number(), title: z.string().nullable(), metaDescription: z.string().nullable(), h1Count: z.number(), canonical: z.string().nullable(), noindex: z.boolean(), viewport: z.boolean(), structuredData: z.array(z.string()) })),
  }),
  /** 4. Per-platform access and measured metrics. */
  socialPlatforms: z.array(
    z.object({
      platform: z.string(),
      url: z.string().nullable(),
      access: z.enum(['live_api', 'user_provided', 'export', 'fixture', 'unavailable', 'not_supplied', 'invalid']),
      note: z.string(),
      metrics: z.array(Metric),
    }),
  ),
  /** 7. Cross-channel facts. */
  channels: z.array(z.object({ platform: z.string(), url: z.string().nullable(), state: z.string(), linkedFromWebsite: z.boolean().nullable() })),
  /** 13. Everything that limits the audit, built from what was and was not retrieved. */
  limitations: z.array(z.string()),
  /** 14. Evidence appendix: every finding with provenance, and every source with its access type. */
  evidenceAppendix: z.object({
    findings: z.array(
      z.object({
        id: z.string(),
        agent: z.string(),
        area: z.string(),
        kind: z.string(),
        title: z.string(),
        statement: z.string(),
        classification: EvidenceStatus,
        severity: Sev,
        sourceId: z.string().nullable(),
        locator: z.string().nullable(),
        excerpt: z.string().nullable(),
        recommendation: z.string().nullable(),
        crosscheck: z.string(),
        at: z.string(),
      }),
    ),
    sources: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string(), status: z.string(), origin: z.string(), live: z.boolean(), fixture: z.boolean(), error: z.string().nullable() })),
  }),
});
export type MarketingAuditReport = z.infer<typeof MarketingAuditReport>;
