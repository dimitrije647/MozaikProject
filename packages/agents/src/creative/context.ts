import { CampaignStrategyReport } from '../strategy/schemas';
import type { F1Context } from '../audit/context';
import type { F2Context } from '../strategy/context';
import type { ChannelId } from '../strategy/channels';

/**
 * What F4 receives from F3: ONE completed Campaign Strategy (its report, including the F4 creative brief). Built by the
 * backend from the stored report; F4 never rebuilds or fabricates it. With the F1 and F2 contexts it is the full chain the
 * creative work is grounded in.
 */
export interface F3Context {
  strategyId: string;
  schemaVersion: number;
  generatedAt: string | null;
  model: string | null;
  partial: boolean;
  f1ReportId: string;
  f2AuditId: string;
  report: CampaignStrategyReport;
}

interface StoredStrategyMeta {
  generatedAt?: string;
  model?: string;
}

/** Returns null when the stored strategy is not a valid F3 report. */
export function buildF3Context(row: { id: string; f1ReportId: string; f2AuditId: string; schemaVersion: number; reportJson: unknown; metadataJson: unknown; createdAt: Date }): F3Context | null {
  const parsed = CampaignStrategyReport.safeParse(row.reportJson);
  if (!parsed.success) return null;
  const meta = (row.metadataJson ?? {}) as StoredStrategyMeta;
  return { strategyId: row.id, schemaVersion: row.schemaVersion, generatedAt: meta.generatedAt ?? row.createdAt.toISOString(), model: meta.model ?? null, partial: parsed.data.partial, f1ReportId: row.f1ReportId, f2AuditId: row.f2AuditId, report: parsed.data };
}

/** The project's own inputs for the creative run. */
export interface CreativeInput {
  projectName: string;
  language: string;
  websiteUrl: string | null;
  /** Channels to produce for (a subset of the strategy's recommended channels). */
  channels: ChannelId[];
  /** Number of original creative concepts (1 to 5). */
  concepts: number;
  /** Build a landing page content (default true). */
  landing: boolean;
}

export type { F1Context, F2Context };
