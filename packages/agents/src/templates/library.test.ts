import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TEMPLATE_LIBRARY, LIBRARY_BY_CATEGORY, LIBRARY_VERSION, validateLibrary } from './library';
import { FORMAT_CLASSES, STYLE_IDS, TEMPLATE_CATEGORIES, TemplateDef, validateTemplate } from './schema';
import { STYLES } from './styles';

// The built-in library as a whole: size, coverage and the promises the product makes about it. (Per-template rendering and the
// pairwise structural diversity are covered by render.test.ts and diversity.test.ts.)

const FACTS = new Set(['offer', 'offerDetail', 'date', 'location', 'quote', 'attribution', 'stat', 'statLabel', 'tag']);
const active = TEMPLATE_LIBRARY.filter((t) => t.status === 'active');

describe('template library', () => {
  it('has at least 30 active, valid templates with unique ids', () => {
    assert.ok(active.length >= 30, `${active.length} active templates`);
    assert.deepEqual(validateLibrary(), []);
    assert.equal(new Set(TEMPLATE_LIBRARY.map((t) => t.id)).size, TEMPLATE_LIBRARY.length, 'ids are unique');
    for (const t of TEMPLATE_LIBRARY) {
      assert.ok(TemplateDef.safeParse(t).success, t.id);
      assert.ok(validateTemplate(t).ok, t.id);
      assert.ok(t.version >= 1);
    }
    assert.match(LIBRARY_VERSION, /^launchpilot-builtin-\d+$/);
  });

  it('covers the six categories with the required ideas', () => {
    for (const c of TEMPLATE_CATEGORIES) assert.ok(LIBRARY_BY_CATEGORY[c].length >= 5, `${c}: ${LIBRARY_BY_CATEGORY[c].length}`);
    for (const t of TEMPLATE_LIBRARY) assert.ok(LIBRARY_BY_CATEGORY[t.category].includes(t), `${t.id} is listed under its own category`);
    const ids = new Set(TEMPLATE_LIBRARY.map((t) => t.id));
    for (const id of [
      'tech_product_launch', 'tech_feature_highlight', 'tech_workflow_steps', 'tech_testimonial', 'tech_minimalist', 'tech_dark_premium',
      'hospitality_restaurant_promo', 'hospitality_cafe_atmosphere', 'hospitality_food_showcase', 'hospitality_event_announcement', 'hospitality_premium_dining',
      'ecommerce_product_spotlight', 'ecommerce_seasonal_promo', 'ecommerce_discount', 'ecommerce_new_collection', 'ecommerce_comparison',
      'services_corporate_announcement', 'services_trust', 'services_explainer', 'services_recruitment', 'services_case_study',
      'editorial_minimal', 'editorial_bold_typography', 'editorial_premium_luxury', 'editorial_lifestyle_story', 'editorial_modern_geometric',
      'events_event_promo', 'events_countdown', 'events_headline_poster', 'events_entertainment', 'events_community',
    ]) assert.ok(ids.has(id), `missing template ${id}`);
  });

  it('is not one layout in many colors: several families, density levels, tones and every format class are really used', () => {
    assert.ok(new Set(active.map((t) => t.family)).size >= 8, [...new Set(active.map((t) => t.family))].join(','));
    assert.ok(new Set(active.map((t) => t.density)).size >= 3);
    assert.ok(new Set(active.map((t) => t.tone)).size >= 3);
    for (const c of FORMAT_CLASSES) assert.ok(active.filter((t) => t.classes.includes(c)).length >= 3, `format class ${c}`);
    assert.ok(active.filter((t) => t.classes.length >= 2).length >= active.length * 0.9, 'templates are designed for more than one format');
    for (const f of new Set(active.map((t) => t.family))) assert.ok(active.filter((t) => t.family === f).length <= Math.ceil(active.length / 3), `family ${f} is not over-represented`);
  });

  it('is usable without extra facts: most templates need only copy, the brand and an optional picture; fact-gated ones are honest about it', () => {
    const plain = active.filter((t) => t.requires.every((r) => !FACTS.has(r)));
    assert.ok(plain.length >= active.length * 0.7, `${plain.length} of ${active.length} need no user-supplied fact`);
    for (const c of TEMPLATE_CATEGORIES) assert.ok(LIBRARY_BY_CATEGORY[c].some((t) => t.requires.every((r) => !FACTS.has(r))), `${c} has templates that need no facts`);
    // picture-free templates exist for every class a picture-less concept may need
    for (const c of ['square', 'portrait', 'story'] as const) assert.ok(active.some((t) => t.classes.includes(c) && !t.requires.includes('image')), `a template without a required picture for ${c}`);
  });

  it('every template shows the brand (one logo layer) and has sample copy for what it shows', () => {
    for (const t of active) {
      assert.equal(t.layers.filter((l) => l.type === 'logo').length, 1, `${t.id}: exactly one logo layer`);
      assert.ok(t.sample.headline.length >= 4, `${t.id}: sample headline`);
      for (const r of t.requires) if (FACTS.has(r)) assert.ok(typeof (t.sample as Record<string, unknown>)[r] === 'string', `${t.id}: sample has ${r}`);
      assert.ok(t.industries.length > 0 && t.description.length >= 10 && t.composition.length >= 10);
    }
  });

  it('is data only: no URL, HTML or script anywhere in any template', () => {
    for (const t of TEMPLATE_LIBRARY) assert.doesNotMatch(JSON.stringify(t), /https?:\/\/|<\/?[a-z][^>]*>|javascript:|data:text|on\w+\s*=/i, t.id);
  });

  it('every visual style of the style library has templates, and every style names templates that exist', () => {
    for (const s of STYLE_IDS) assert.ok(active.filter((t) => t.styles.includes(s)).length >= 2, `style ${s} has at least two templates`);
    for (const st of STYLES) assert.ok(active.some((t) => st.templateCategories.includes(t.category)), st.id);
  });
});
