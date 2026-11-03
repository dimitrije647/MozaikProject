import { designAnchors, designBrandColors } from '../collections/design';
import { getCollection } from '../collections/registry';
import type { TemplateCollection } from '../collections/schema';
import type { CampaignDesign } from '../collections/design';
import type { VisualBrief } from '../creative/visual-brief';
import type { ChannelId } from '../strategy/channels';
import type { StyleId, VisualDirectionBrief } from '../templates/schema';
import { buildVisualDirection, type VisualReferenceInput } from '../templates/visual-direction';
import type { HybridSettings } from './settings';

/**
 * The Visual Direction Brief of a campaign, built from what the strategy and the brand already say plus the references the USER
 * attached. Shared by the free preview and by the Visual Researcher so both show exactly the same direction.
 */
export interface DirectionContext {
  visualBrief: VisualBrief;
  projectName: string;
  channels: ChannelId[];
  /** The brand palette in use (measured from the brand, or a neutral one). */
  palette: string[];
  /** false = the palette is a neutral default and says nothing about the brand. */
  hasBrandPalette: boolean;
  settings: Pick<HybridSettings, 'style' | 'references' | 'inspiration'> & { design?: HybridSettings['design'] };
  /** Palettes the backend extracted from reference images the user owns, by reference id. */
  referencePalettes: Record<string, string[]>;
  /** Overrides settings.style (used when the model picked another style in auto mode). */
  forceStyle?: StyleId;
}

const firstSentence = (text: string, max: number) => (text.split(/(?<=[.!?])\s/)[0] ?? text).slice(0, max);

/**
 * The visual direction with the user's campaign design LOCKED in: the collection's style, the approved palette, the collection's type system,
 * composition principles and picture treatment. Everything an agent or a model adds on top (a rationale, moods, subjects, channel notes) may
 * refine the brief but can never replace these; call this again on any refined brief to make that true.
 */
export function lockDesign(brief: VisualDirectionBrief, design: CampaignDesign, collection: TemplateCollection): VisualDirectionBrief {
  const a = designAnchors(design.palette);
  const t = collection.tokens.typography;
  return {
    ...brief,
    styleId: collection.styleId,
    secondaryStyleIds: [],
    colors: { primary: design.palette.primary, secondary: design.palette.secondary, accent: design.palette.accent, ink: a.ink, paper: a.paper, notes: `Approved by you for this campaign (${design.overridden.length ? `${design.overridden.join(', ')} edited by you` : 'no color edited by hand'}).` },
    typography: { headline: t.headline.family, body: t.body.family, notes: collection.typographySystem.slice(0, 200) },
    composition: collection.layoutPrinciples.map((p) => p.slice(0, 140)).slice(0, 5),
    imageTreatment: [firstSentence(collection.imageTreatment, 100)],
    rationale: `You chose the ${collection.name} collection and approved its palette. Every agent works inside that design; nothing here replaces it.`.slice(0, 400),
    origin: 'user_approved',
    confidence: 'high',
  };
}

export function directionFor(c: DirectionContext): VisualDirectionBrief {
  const design = c.settings.design ?? null;
  const collection = design ? (getCollection(design.collectionId) ?? null) : null;
  const b = c.visualBrief;
  const references: VisualReferenceInput[] = c.settings.references.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    url: r.url,
    permission: r.permission,
    palette: c.referencePalettes[r.id],
  }));
  if (design && collection) {
    references.unshift({ id: 'campaign-design', kind: 'brand_asset', label: `Palette approved by you with the ${collection.name} collection`, url: null, permission: 'owned_by_user', palette: designBrandColors(design.palette) });
  } else if (c.hasBrandPalette && c.settings.inspiration !== 'style_library') {
    references.unshift({ id: 'brand-palette', kind: 'brand_asset', label: 'Brand colors measured from the project\'s own site and logo', url: null, permission: 'owned_by_user', palette: c.palette });
  }
  const built = buildVisualDirection({
    projectName: c.projectName,
    industry: b.business,
    productSummary: [b.offering, b.valueProposition].filter(Boolean).join(' · ').slice(0, 400),
    audience: b.audience.primary,
    tone: b.brand.tone,
    objective: b.campaignGoal,
    designDirection: b.brand.visualDirection,
    channels: c.channels,
    brandPalette: design ? designBrandColors(design.palette) : c.hasBrandPalette ? c.palette : [],
    userStyleId: collection ? collection.styleId : (c.forceStyle ?? c.settings.style),
    references,
  });
  return design && collection ? lockDesign(built, design, collection) : built;
}

/** A plain-text description of the business for industry matching (lower-case words are matched against template industries). */
export function industryTextOf(b: Pick<VisualBrief, 'business' | 'offering' | 'valueProposition' | 'audience'>): string {
  return [b.business, b.offering, b.valueProposition, b.audience.primary].join(' ').toLowerCase().slice(0, 900);
}
