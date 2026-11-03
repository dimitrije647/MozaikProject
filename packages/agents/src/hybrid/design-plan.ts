import { FORMAT_OPTIONS, formatClassOfId, formatIdsOf, type FormatOptionKey } from '../collections/design';
import { collectionTemplates, coverageOf, getCollection, listCollections, needsFacts } from '../collections/registry';
import { CREATIVE_FORMATS } from '../creative/formats';
import { TEMPLATE_LIBRARY } from '../templates/library';
import type { TemplateDef } from '../templates/schema';
import type { HybridSettings } from './settings';

/**
 * The creative format ids a campaign design produces: the formats of the options the user chose, limited to the format classes the collection can
 * actually draw (an option such as "Instagram post" stands for a square and a portrait format; a collection that only has square templates gives the
 * square one). undefined when there is no design or no format was chosen (the earlier behaviour: formats follow the channels).
 */
export function designFormatIds(hs: Pick<HybridSettings, 'design'>): string[] | undefined {
  if (!hs.design) return undefined;
  const c = getCollection(hs.design.collectionId);
  const classes = new Set(c ? coverageOf(c).classes : []);
  const ids = formatIdsOf(hs.design.formats).filter((id) => {
    const cls = formatClassOfId(id);
    return !!cls && classes.has(cls);
  });
  return ids.length ? ids : undefined;
}

export interface FormatFit {
  key: FormatOptionKey;
  label: string;
  /** the formats of this option the collection can draw */
  formatIds: string[];
  /** formats of this option the collection cannot draw (left out of the plan) */
  droppedIds: string[];
  /** templates that can be drawn in at least one of the option's formats with the content the campaign has */
  templates: string[];
}

export interface DesignFit {
  ok: boolean;
  /** options with NO usable template in the collection: a blocker before anything is paid for */
  unsupported: FormatFit[];
  /** options with a single usable template: they will repeat */
  thin: FormatFit[];
  /** what the user can do about it, in words (never applied automatically) */
  options: { collections: { id: string; name: string }[]; formats: { key: FormatOptionKey; label: string }[]; plan: string[] };
  messages: string[];
}

/**
 * Whether the chosen collection can really produce the chosen formats with the content the campaign will have (pictures present or not, the facts
 * the user gave). A format the collection cannot draw is reported BEFORE any spending, with what could be done instead; it is never silently filled
 * with templates from another collection.
 */
export function checkDesignFit(o: { collectionId: string; formatKeys: readonly FormatOptionKey[]; hasPicture: boolean; facts: Record<string, string | undefined>; templateCreatives: number; library?: readonly TemplateDef[] }): DesignFit {
  const library = o.library ?? TEMPLATE_LIBRARY;
  const collection = getCollection(o.collectionId);
  const fit: DesignFit = { ok: true, unsupported: [], thin: [], options: { collections: [], formats: [], plan: [] }, messages: [] };
  if (!collection) return { ...fit, ok: false, messages: [`The template collection "${o.collectionId}" does not exist.`] };
  const have = new Set(Object.entries(o.facts).filter(([, v]) => (v ?? '').trim()).map(([k]) => k));
  const usable = (t: TemplateDef) => needsFacts(t).every((r) => have.has(r)) && (o.hasPicture || !t.requires.includes('image'));
  const fitIn = (list: TemplateDef[], key: FormatOptionKey): FormatFit => {
    const ids = FORMAT_OPTIONS[key].formatIds.filter((id) => CREATIVE_FORMATS[id]);
    const per = ids.map((id) => ({ id, templates: list.filter((t) => t.classes.includes(formatClassOfId(id)!)).map((t) => t.id) }));
    return { key, label: FORMAT_OPTIONS[key].label, formatIds: per.filter((p) => p.templates.length).map((p) => p.id), droppedIds: per.filter((p) => !p.templates.length).map((p) => p.id), templates: [...new Set(per.flatMap((p) => p.templates))] };
  };
  const mine = collectionTemplates(collection, library).filter(usable);
  const chosen = o.formatKeys.map((k) => fitIn(mine, k));
  fit.unsupported = chosen.filter((f) => f.formatIds.length === 0);
  fit.thin = chosen.filter((f) => f.formatIds.length > 0 && f.templates.length === 1);
  fit.ok = fit.unsupported.length === 0;
  fit.options.formats = (Object.keys(FORMAT_OPTIONS) as FormatOptionKey[]).map((k) => fitIn(mine, k)).filter((f) => f.formatIds.length > 0).map((f) => ({ key: f.key, label: f.label }));
  fit.options.collections = listCollections()
    .filter((c) => c.id !== collection.id)
    .filter((c) => {
      const t = collectionTemplates(c, library).filter(usable);
      return o.formatKeys.every((k) => fitIn(t, k).formatIds.length > 0);
    })
    .map((c) => ({ id: c.id, name: c.name }));
  for (const f of fit.unsupported) fit.messages.push(`${collection.name} has no template for ${f.label}${o.hasPicture ? '' : ' without a picture'}.`);
  for (const f of chosen.filter((x) => x.formatIds.length > 0 && x.droppedIds.length > 0)) fit.messages.push(`${collection.name} cannot draw ${f.droppedIds.map((id) => CREATIVE_FORMATS[id].label).join(', ')} (part of ${f.label}); the other formats of that option are used.`);
  for (const f of fit.thin) fit.messages.push(`${collection.name} has only one template for ${f.label}: it will repeat across the campaign.`);
  if (!fit.ok) fit.options.plan = ['Choose another collection that supports every format you picked.', 'Remove the unsupported formats from the design.', ...(o.templateCreatives > 0 ? ['Or reduce the number of template creatives.'] : [])];
  return fit;
}
