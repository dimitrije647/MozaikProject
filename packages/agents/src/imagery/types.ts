import type { AssetOrigin } from '../hybrid/records';

/**
 * IMAGE SOURCES. Every picture that could appear in a campaign belongs to exactly one kind, and the kind decides what may be done with it:
 *
 *   AI_GENERATED      made by the image model for this campaign (paid, planned and approved with the budget)
 *   USER_PROVIDED     uploaded by the user, who confirms the right to use it
 *   BRAND_ASSET       the project's own brand material (logo, brand images)
 *   LICENSED_STOCK    downloaded from a stock provider under a license that permits advertising use, with provenance recorded
 *   TEMPLATE_RENDERED a local composition of the above (never an image source by itself)
 *   REFERENCE_ONLY    something a person may LOOK at for inspiration. It is never downloaded, never stored as an asset, never sent to an AI
 *                     model and NEVER part of an exported creative, whatever the platform it came from
 */
export const IMAGE_SOURCE_KINDS = ['AI_GENERATED', 'USER_PROVIDED', 'LICENSED_STOCK', 'BRAND_ASSET', 'REFERENCE_ONLY', 'TEMPLATE_RENDERED'] as const;
export type ImageSourceKind = (typeof IMAGE_SOURCE_KINDS)[number];

/** The kinds that may end up in an exported campaign. REFERENCE_ONLY is deliberately absent. */
export const EXPORTABLE_KINDS: readonly ImageSourceKind[] = ['AI_GENERATED', 'USER_PROVIDED', 'LICENSED_STOCK', 'BRAND_ASSET', 'TEMPLATE_RENDERED'];

/** The asset origin stored with a campaign asset for a source kind; null = the kind can never become an asset. */
export function assetOriginOf(kind: ImageSourceKind): AssetOrigin | null {
  switch (kind) {
    case 'AI_GENERATED':
      return 'AI_GENERATED';
    case 'USER_PROVIDED':
      return 'USER_UPLOADED';
    case 'LICENSED_STOCK':
      return 'LICENSED_ASSET';
    case 'BRAND_ASSET':
      return 'BRAND_ASSET';
    case 'TEMPLATE_RENDERED':
      return 'TEMPLATE_RENDERED';
    case 'REFERENCE_ONLY':
      return null;
  }
}

export const isExportable = (kind: ImageSourceKind) => EXPORTABLE_KINDS.includes(kind);

/** What the license of a candidate allows for an advertising creative that is cropped and has text laid over it. */
export type LicenseStatus = 'cleared' | 'needs_review' | 'blocked';

export interface LicenseVerdict {
  status: LicenseStatus;
  /** the provider's own license name, e.g. "Pixabay Content License", "CC BY 4.0" */
  license: string;
  licenseUrl: string | null;
  commercialUse: boolean;
  /** cropping, resizing and laying text over the picture */
  derivatives: boolean;
  /**
   * The ORIGINAL file may be handed over as it is (inside a campaign archive). A license that allows an advertisement made from the picture
   * usually does NOT allow passing the picture itself on (Pixabay and Pexels forbid redistributing the unaltered file). Absent = false.
   */
  redistributeOriginal?: boolean;
  attributionRequired: boolean;
  /** the credit line to carry with the creative when one is required or customary */
  attribution: string | null;
  /** plain sentences: why this status */
  reasons: string[];
}

/** One picture a provider offered. Nothing here is a downloaded file. */
export interface ImageCandidate {
  /** stable within a provider */
  id: string;
  provider: string;
  kind: 'LICENSED_STOCK' | 'REFERENCE_ONLY';
  title: string;
  /** the page of the original publisher / provider, always present: the user can open it */
  pageUrl: string;
  creator: string | null;
  creatorUrl: string | null;
  width: number | null;
  height: number | null;
  tags: string[];
  /** For DISPLAY in the review list only (a thumbnail the provider serves). Never stored. Null for platforms whose content must not be shown. */
  thumbnailUrl: string | null;
  /** The file to download once the user chooses it. Null for REFERENCE_ONLY. */
  downloadUrl: string | null;
  license: LicenseVerdict;
  /** a platform note for the reader, e.g. "Pinterest: link only" */
  platform: string | null;
}

export interface SearchIntent {
  /** the query sent to a provider */
  query: string;
  /** why it was chosen, in words */
  why: string;
  orientation: 'landscape' | 'portrait' | 'square' | null;
}

export type ProviderStatus = 'ok' | 'not_configured' | 'failed' | 'rate_limited' | 'skipped';

export interface ProviderOutcome {
  id: string;
  label: string;
  kind: 'licensed' | 'reference';
  status: ProviderStatus;
  /** a safe sentence, never a provider's raw error or a key */
  message: string | null;
  count: number;
}

export interface DiscoveryResult {
  intents: SearchIntent[];
  providers: ProviderOutcome[];
  /** pictures that could be used after the user chooses them (cleared or needing a check at the source) */
  licensed: ImageCandidate[];
  /** pictures to look at; never assets */
  references: ImageCandidate[];
  notes: string[];
  searchedAt: string;
}
