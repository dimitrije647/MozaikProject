import { checkPalette, defaultPaletteOf, type PaletteCheck, type PaletteEvidence, type PaletteSource } from '../collections/design';
import { getCollection } from '../collections/registry';
import type { CollectionId, DesignPalette } from '../collections/schema';
import { contrast } from '../templates/color';
import { colorDistance, isNearWhite } from './color-parse';
import type { BrandCandidate, BrandReading, BrandRole, EvidenceTier } from './types';

/**
 * THE PALETTE SUGGESTION: turns what the sources said into five colors with, for every color, where it came from and how sure we are.
 *
 *   precedence (a lower tier wins):  1 the user's own colors, 2 declared design tokens and brand guidelines, 3 the logo, 4 the website's
 *   visible branding, 5 the repository's styles, 6 other visual material. A color nobody gave is the collection's default (and says so).
 *
 * The precedence only decides which color is OFFERED. When two credible sources disagree the disagreement is reported next to the choice,
 * and the confidence drops: nothing is silently assumed. Pure and deterministic: no model, no network.
 */

export const ROLES: BrandRole[] = ['primary', 'secondary', 'accent', 'background', 'text'];

export interface PaletteConflict {
  role: BrandRole;
  chosen: { hex: string; source: PaletteSource; evidence: string };
  alternatives: { hex: string; source: PaletteSource; evidence: string }[];
  message: string;
}

export interface ReadingSummary {
  source: PaletteSource;
  label: string;
  status: BrandReading['status'];
  message: string | null;
  /** the distinct colors it contributed, most important first */
  colors: string[];
}

export interface PaletteSuggestion {
  collectionId: CollectionId;
  palette: DesignPalette;
  evidence: Record<BrandRole, PaletteEvidence>;
  conflicts: PaletteConflict[];
  readings: ReadingSummary[];
  /** the roles nobody gave: they carry the collection's default */
  fallbackRoles: BrandRole[];
  check: PaletteCheck;
  notes: string[];
}

interface Sourced extends BrandCandidate {
  source: PaletteSource;
}

const SAME = 45;
const DIFFERENT = 70;
const TIER_OF_USER: EvidenceTier = 1;

/** The best candidate of every SOURCE (lowest tier, then strongest), the most trusted first. Agreement and disagreement are judged between sources. */
const bestPerSource = (list: Sourced[]): Sourced[] => {
  const by = new Map<PaletteSource, Sourced>();
  for (const c of list) {
    const cur = by.get(c.source);
    if (!cur || c.tier < cur.tier || (c.tier === cur.tier && c.weight > cur.weight)) by.set(c.source, c);
  }
  return [...by.values()].sort((a, b) => a.tier - b.tier || b.weight - a.weight || (a.source < b.source ? -1 : 1));
};

type Confidence = PaletteEvidence['confidence'];
const down = (c: Confidence): Confidence => (c === 'high' ? 'medium' : 'low');

export function suggestPalette(input: { collectionId: CollectionId; readings: BrandReading[]; explicit?: Partial<Record<BrandRole, string>> }): PaletteSuggestion {
  const collection = getCollection(input.collectionId);
  if (!collection) throw new Error(`Unknown template collection "${input.collectionId}".`);
  const defaults = defaultPaletteOf(input.collectionId);
  const all: Sourced[] = [];
  for (const r of input.readings) for (const c of r.candidates) all.push({ ...c, source: r.source });
  for (const [role, hex] of Object.entries(input.explicit ?? {}) as [BrandRole, string][]) if (hex) all.push({ hex: hex.toLowerCase(), role, tier: TIER_OF_USER, weight: 1, evidence: 'Chosen by you', source: 'user' });

  const palette: Partial<Record<BrandRole, string>> = {};
  const evidence: Partial<Record<BrandRole, PaletteEvidence>> = {};
  const conflicts: PaletteConflict[] = [];
  const notes: string[] = [];
  const fallbackRoles: BrandRole[] = [];

  for (const role of ROLES) {
    let pool = all.filter((c) => c.role === role);
    // a brand hue is never white; a hue already taken by an earlier role is not offered again
    if (role === 'primary' || role === 'secondary' || role === 'accent') pool = pool.filter((c) => c.tier === TIER_OF_USER || !isNearWhite(c.hex));
    if (role === 'secondary') pool = pool.filter((c) => c.tier === TIER_OF_USER || !palette.primary || colorDistance(c.hex, palette.primary) > 60);
    if (role === 'accent') pool = pool.filter((c) => c.tier === TIER_OF_USER || ![palette.primary, palette.secondary].some((p) => p && colorDistance(c.hex, p) <= 60));
    const tiers = bestPerSource(pool);
    const chosen = tiers[0];
    if (!chosen) {
      palette[role] = defaults[role];
      evidence[role] = { source: 'collection_default', confidence: 'low', evidence: `Nothing in your material named a ${role} color: the ${collection.name} default` };
      fallbackRoles.push(role);
      continue;
    }
    const supporters = tiers.slice(1).filter((t) => colorDistance(t.hex, chosen.hex) < SAME);
    const opponents = tiers.slice(1).filter((t) => t.weight >= 0.5 && colorDistance(t.hex, chosen.hex) > DIFFERENT);
    let confidence: Confidence = chosen.tier === TIER_OF_USER || (chosen.tier <= 2 && chosen.weight >= 0.8) ? 'high' : supporters.length && chosen.weight >= 0.5 ? 'high' : chosen.weight >= 0.6 ? 'medium' : 'low';
    if (opponents.length) {
      // the user's own color is a decision, not a guess: the difference is shown but the confidence does not drop
      if (chosen.tier !== TIER_OF_USER) confidence = down(confidence);
      conflicts.push({
        role,
        chosen: { hex: chosen.hex, source: chosen.source, evidence: chosen.evidence },
        alternatives: opponents.map((o) => ({ hex: o.hex, source: o.source, evidence: o.evidence })),
        message: chosen.tier === TIER_OF_USER ? `You chose ${chosen.hex} for the ${role} color; ${opponents.map((o) => `${o.evidence} says ${o.hex}`).join('; ')}. Your choice is used.` : `The ${role} color is not clear: ${chosen.evidence} says ${chosen.hex}, but ${opponents.map((o) => `${o.evidence} says ${o.hex}`).join('; ')}. ${chosen.hex} is suggested because it comes from the stronger kind of evidence: please check it.`,
      });
    }
    palette[role] = chosen.hex;
    evidence[role] = { source: chosen.source, confidence, evidence: `${chosen.evidence}${supporters.length ? ` (also seen in ${supporters.map((s) => s.evidence.split(':')[0]).join(', ')})` : ''}`.slice(0, 240) };
  }

  const p = palette as DesignPalette;
  // readability: text on the background must reach the collection's minimum. Replace whichever side is only a default; never overrule two real brand colors.
  const min = collection.recommendedPaletteRules.minTextContrast;
  if (contrast(p.text, p.background) < min) {
    const textIsDefault = evidence.text!.source === 'collection_default';
    const bgIsDefault = evidence.background!.source === 'collection_default';
    if (textIsDefault || !bgIsDefault) {
      const options = [defaults.text, '#111827', '#ffffff'];
      const best = options.map((c) => ({ c, r: contrast(c, p.background) })).sort((a, b) => b.r - a.r)[0];
      if (textIsDefault && best.r >= min) {
        p.text = best.c;
        evidence.text = { source: 'collection_default', confidence: 'low', evidence: 'A text color chosen so the text is readable on the suggested background' };
        notes.push('The text color was chosen for readability on the background.');
      }
    } else {
      const options = [defaults.background, '#ffffff', '#f8fafc', '#0b1020'];
      const best = options.map((c) => ({ c, r: contrast(p.text, c) })).sort((a, b) => b.r - a.r)[0];
      if (best.r >= min) {
        p.background = best.c;
        evidence.background = { source: 'collection_default', confidence: 'low', evidence: 'A background chosen so your text color is readable on it' };
        notes.push('The background was chosen for readability of your text color.');
      }
    }
  }
  if (!input.readings.some((r) => r.status === 'ok') && Object.keys(input.explicit ?? {}).length === 0) notes.push('No brand colors could be read from your material, so the collection default palette is suggested.');
  const summary: ReadingSummary[] = input.readings.map((r) => ({
    source: r.source,
    label: r.label,
    status: r.status,
    message: r.message,
    colors: [...new Set(r.candidates.slice().sort((a, b) => a.tier - b.tier || b.weight - a.weight).map((c) => c.hex))].slice(0, 6),
  }));
  return { collectionId: input.collectionId, palette: p, evidence: evidence as Record<BrandRole, PaletteEvidence>, conflicts, readings: summary, fallbackRoles, check: checkPalette(p, min), notes };
}
