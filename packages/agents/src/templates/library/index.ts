import { TEMPLATE_CATEGORIES, validateTemplate, type TemplateCategory, type TemplateDef } from '../schema';
import { COLLECTION_TEMPLATES_A } from './collections-a';
import { COLLECTION_TEMPLATES_B } from './collections-b';
import { COLLECTION_TEMPLATES_C } from './collections-c';
import { COLLECTION_TEMPLATES_D } from './collections-d';
import { ECOMMERCE } from './ecommerce';
import { EDITORIAL_BRAND } from './editorial-brand';
import { EVENTS_ENTERTAINMENT } from './events-entertainment';
import { HOSPITALITY } from './hospitality';
import { PROFESSIONAL_SERVICES } from './professional-services';
import { TECH_SAAS } from './tech-saas';

/** Bumped whenever a template is added, removed or changed in a way that changes its output; stored with every Hybrid campaign. */
export const LIBRARY_VERSION = 'launchpilot-builtin-2';

/** The built-in template library (declarative data only). Validation runs in the tests and when the registry is built. */
export const TEMPLATE_LIBRARY: readonly TemplateDef[] = [...TECH_SAAS, ...HOSPITALITY, ...ECOMMERCE, ...PROFESSIONAL_SERVICES, ...EDITORIAL_BRAND, ...EVENTS_ENTERTAINMENT, ...COLLECTION_TEMPLATES_A, ...COLLECTION_TEMPLATES_B, ...COLLECTION_TEMPLATES_C, ...COLLECTION_TEMPLATES_D];

export const LIBRARY_BY_CATEGORY = Object.fromEntries(TEMPLATE_CATEGORIES.map((c) => [c, TEMPLATE_LIBRARY.filter((t) => t.category === c)])) as unknown as Record<TemplateCategory, readonly TemplateDef[]>;

export function validateLibrary(list: readonly TemplateDef[] = TEMPLATE_LIBRARY) {
  const issues: { templateId: string; message: string }[] = [];
  const seen = new Set<string>();
  for (const t of list) {
    if (seen.has(t.id)) issues.push({ templateId: t.id, message: 'duplicate template id' });
    seen.add(t.id);
    const r = validateTemplate(t);
    if (!r.ok) issues.push(...r.issues);
  }
  return issues;
}
