import type { CampaignPackage } from './schemas';

/** One file of a campaign archive, listed in its manifest with its hash (and, for images, where the picture comes from). */
export interface ExportFile {
  path: string;
  bytes: number;
  sha256: string;
  assetId?: string;
  kind: 'json' | 'markdown' | 'html' | 'text' | 'image' | 'manifest';
  /** Images only: where the file really comes from (TEMPLATE_RENDERED, LICENSED_STOCK...), its size and, for creatives, the template and the source files. */
  origin?: string;
  width?: number;
  height?: number;
  templateId?: string;
  templateVersion?: number;
  sourceFiles?: string[];
  rights?: string;
}

export interface ExportManifest {
  campaignId: string;
  campaignName: string;
  runId: string;
  chain: { f1ReportId: string; f2ReportId: string | null; f3StrategyId: string };
  schemaVersion: number;
  createdAt: string;
  approval: CampaignPackage['approval'];
  files: ExportFile[];
  assetsMissing: string[];
  /** V4: the deliverable counts (planned, delivered, missing, with a picture, typography-first). */
  deliverables?: Record<string, number>;
  /** Campaigns made before V4: the production mode, counts and template relationships. */
  hybrid?: Record<string, unknown>;
}

/**
 * The bytes of a source picture, supplied by the backend (the campaign package holds only records). `data` is null when the file is not
 * available. A source's ORIGINAL is placed in the archive only when its rights allow handing the unaltered file on (`redistributeOriginal`).
 */
export interface ExportSource {
  id: string;
  fileName: string;
  data: Buffer | null;
}

export const safeName = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80) || 'file';

export const sha256 = async (b: Buffer) => (await import('node:crypto')).createHash('sha256').update(b).digest('hex');
