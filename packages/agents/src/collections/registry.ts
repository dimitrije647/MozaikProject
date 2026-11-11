import { CREATIVE_FORMATS } from '../creative/formats';
import { TEMPLATE_LIBRARY } from '../templates/library';
import { formatClassOf, type FormatClass, type StyleId, type TemplateDef } from '../templates/schema';
import { COLLECTIONS, COLLECTIONS_VERSION } from './library';
import { COLLECTION_IDS, COLLECTION_ROLES, TemplateCollection, type CollectionId, type CollectionRole } from './schema';
import { applyCollection } from './theme';

export { COLLECTIONS, COLLECTIONS_VERSION };

const BY_ID = new Map<string, TemplateCollection>(COLLECTIONS.map((c) => [c.id, c]));

export const getCollection = (id: string): TemplateCollection | undefined => BY_ID.get(id);
export const listCollections = (o: { includeDisabled?: boolean } = {}): TemplateCollection[] => COLLECTIONS.filter((c) => o.includeDisabled || c.enabled).slice().sort((a, b) => a.number - b.number);

/** Each collection builds on one library style, and the library has exactly one collection per style it offers. */
export function collectionForStyle(styleId: StyleId): TemplateCollection | undefined {
  return COLLECTIONS.find((c) => c.styleId === styleId);
}

/** Facts a template may require that the user alone can give: a collection's coverage is counted WITHOUT them, so it never depends on invented content. */
const FACT_REQUIREMENTS = new Set(['offer', 'offerDetail', 'date', 'location', 'quote', 'attribution', 'stat', 'statLabel', 'tag']);
export const needsFacts = (t: TemplateDef): string[] => t.requires.filter((r) => FACT_REQUIREMENTS.has(r));

/** The collection's templates as the library defines them (no theme applied), in the collection's order. */
export function collectionTemplates(c: Pick<TemplateCollection, 'templateIds'>, library: readonly TemplateDef[] = TEMPLATE_LIBRARY): TemplateDef[] {
  const byId = new Map(library.map((t) => [t.id, t]));
  return c.templateIds.map((id) => byId.get(id)).filter((t): t is TemplateDef => !!t && t.status === 'active');
}

/** The collection's templates drawn with the collection's design tokens: what a campaign renders. */
export function themedTemplates(c: TemplateCollection, library: readonly TemplateDef[] = TEMPLATE_LIBRARY): TemplateDef[] {
  return collectionTemplates(c, library).map((t) => applyCollection(t, c));
}

/** One template as the collection draws it, or undefined when the collection does not list it. */
export function themedTemplate(c: TemplateCollection, templateId: string, library: readonly TemplateDef[] = TEMPLATE_LIBRARY): TemplateDef | undefined {
  if (!c.templateIds.includes(templateId)) return undefined;
  const t = library.find((x) => x.id === templateId && x.status === 'active');
  return t ? applyCollection(t, c) : undefined;
}

export interface CollectionCoverage {
  classes: FormatClass[];
  /** per format class: the templates (ids) that can be drawn there without any user-supplied fact */
  byClass: Record<FormatClass, string[]>;
  /** creative format ids (CREATIVE_FORMATS) the collection can draw */
  formats: string[];
  /** per message role: the templates that play it */
  roles: Record<CollectionRole, string[]>;
  /** story / feed / banner follow from the classes */
  has: { story: boolean; feed: boolean; banner: boolean };
}

/** What a collection can produce. Counts templates that need NO user-supplied fact; picture-needing templates count (a Hybrid run has pictures). */
export function coverageOf(c: Pick<TemplateCollection, 'templateIds' | 'roles'>, library: readonly TemplateDef[] = TEMPLATE_LIBRARY): CollectionCoverage {
  const ts = collectionTemplates(c, library);
  const free = ts.filter((t) => needsFacts(t).length === 0);
  const byClass: Record<FormatClass, string[]> = { square: [], portrait: [], story: [], landscape: [], banner: [] };
  for (const t of free) for (const cls of t.classes) byClass[cls].push(t.id);
  const classes = (Object.keys(byClass) as FormatClass[]).filter((k) => byClass[k].length > 0);
  const formats = Object.values(CREATIVE_FORMATS).filter((f) => byClass[formatClassOf(f.width, f.height)].length > 0).map((f) => f.id);
  const roles = Object.fromEntries(COLLECTION_ROLES.map((r) => [r, (c.roles[r] ?? []).filter((id) => ts.some((t) => t.id === id))])) as Record<CollectionRole, string[]>;
  return { classes, byClass, formats, roles, has: { story: byClass.story.length > 0, feed: byClass.square.length + byClass.portrait.length > 0, banner: byClass.banner.length > 0 } };
}

export interface CollectionIssue {
  collectionId: string;
  message: string;
}

/** Every rule a collection must satisfy. Run by the tests and by the API when it builds its registry. */
export function validateCollections(collections: readonly TemplateCollection[] = COLLECTIONS, library: readonly TemplateDef[] = TEMPLATE_LIBRARY): CollectionIssue[] {
  const issues: CollectionIssue[] = [];
  const say = (collectionId: string, message: string) => issues.push({ collectionId, message });
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const c of collections) {
    const parsed = TemplateCollection.safeParse(c);
    if (!parsed.success) {
      say(c.id, `schema: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
      continue;
    }
    if (ids.has(c.id)) say(c.id, 'duplicate collection id');
    ids.add(c.id);
    if (numbers.has(c.number)) say(c.id, `duplicate collection number ${c.number}`);
    numbers.add(c.number);
    const byId = new Map(library.map((t) => [t.id, t]));
    const seen = new Set<string>();
    for (const id of c.templateIds) {
      if (seen.has(id)) say(c.id, `template ${id} is listed twice`);
      seen.add(id);
      const t = byId.get(id);
      if (!t) say(c.id, `template ${id} does not exist in the library`);
      else if (t.status !== 'active') say(c.id, `template ${id} is ${t.status}, not active`);
    }
    for (const role of COLLECTION_ROLES) {
      const list = c.roles[role] ?? [];
      if (!list.length) say(c.id, `no template plays the role "${role}"`);
      for (const id of list) if (!c.templateIds.includes(id)) say(c.id, `role "${role}" names ${id}, which is not in the collection`);
    }
    for (const p of c.previewAssets) {
      const t = byId.get(p.templateId);
      if (!c.templateIds.includes(p.templateId)) say(c.id, `preview ${p.templateId} is not in the collection`);
      else if (t && !t.classes.includes(p.class)) say(c.id, `preview ${p.templateId} is not designed for ${p.class}`);
    }
    const cov = coverageOf(c, library);
    for (const k of ['story', 'feed', 'banner'] as const) if (!cov.has[k]) say(c.id, `no template without required facts covers the ${k} format`);
  }
  for (const id of COLLECTION_IDS) if (!ids.has(id)) say(id, 'the collection is missing');
  if (collections.length !== COLLECTION_IDS.length) say('*', `expected ${COLLECTION_IDS.length} collections, found ${collections.length}`);
  return issues;
}

export type { CollectionId };
