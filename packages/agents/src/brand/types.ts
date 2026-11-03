import type { PaletteSource } from '../collections/design';

/** The five colors a campaign design has. */
export type BrandRole = 'primary' | 'secondary' | 'accent' | 'background' | 'text';

/**
 * How trustworthy the KIND of evidence is, the order of the spec's source priority:
 *   1 the user's own colors   2 declared design tokens and brand guidelines   3 the logo   4 the website's visible branding
 *   5 the repository's styles 6 other visual material   (7 the collection default is a fallback, not evidence)
 */
export type EvidenceTier = 1 | 2 | 3 | 4 | 5 | 6;

export interface BrandCandidate {
  hex: string;
  role: BrandRole;
  tier: EvidenceTier;
  /** 0..1: how strong this particular piece of evidence is within its tier. */
  weight: number;
  /** A short safe sentence: where the color was found. Never page content. */
  evidence: string;
}

export type ReadingStatus = 'ok' | 'empty' | 'unavailable' | 'blocked' | 'failed';

/** What one source (the website, the repository, the logo...) contributed, or why it could not. */
export interface BrandReading {
  source: PaletteSource;
  label: string;
  status: ReadingStatus;
  /** A user-facing sentence when the source gave nothing. */
  message: string | null;
  candidates: BrandCandidate[];
}

export const emptyReading = (source: PaletteSource, label: string, status: Exclude<ReadingStatus, 'ok'>, message: string): BrandReading => ({ source, label, status, message, candidates: [] });
