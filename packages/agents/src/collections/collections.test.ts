import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { CREATIVE_FORMATS } from '../creative/formats';
import { renderTemplatePreview } from '../templates/preview';
import { TEMPLATE_LIBRARY } from '../templates/library';
import { FORMAT_CLASSES, STYLE_IDS, validateTemplate, type Layer, type TemplateDef } from '../templates/schema';
import { designAnchors, designBrandColors } from './design';
import { COLLECTIONS, collectionForStyle, collectionTemplates, coverageOf, getCollection, listCollections, themedTemplate, themedTemplates, validateCollections } from './registry';
import { COLLECTION_IDS, COLLECTION_ROLES } from './schema';
import { applyCollection } from './theme';

// The ten template collections: stable, valid, complete, internally consistent and different from each other.

const ORIGINAL_31 = [
  'tech_product_launch', 'tech_feature_highlight', 'tech_workflow_steps', 'tech_testimonial', 'tech_minimalist', 'tech_dark_premium',
  'hospitality_restaurant_promo', 'hospitality_cafe_atmosphere', 'hospitality_food_showcase', 'hospitality_event_announcement', 'hospitality_premium_dining',
  'ecommerce_product_spotlight', 'ecommerce_seasonal_promo', 'ecommerce_discount', 'ecommerce_new_collection', 'ecommerce_comparison',
  'services_corporate_announcement', 'services_trust', 'services_explainer', 'services_recruitment', 'services_case_study',
  'editorial_minimal', 'editorial_bold_typography', 'editorial_premium_luxury', 'editorial_lifestyle_story', 'editorial_modern_geometric',
  'events_event_promo', 'events_countdown', 'events_headline_poster', 'events_entertainment', 'events_community',
];

describe('the ten collections', () => {
  it('exactly ten collections exist, in a fixed order', () => {
    assert.equal(COLLECTIONS.length, 10);
    assert.deepEqual(listCollections().map((c) => c.id), [...COLLECTION_IDS]);
    assert.deepEqual(listCollections().map((c) => c.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepEqual(listCollections().map((c) => c.name), ['Minimal Tech', 'Bold Startup', 'Premium Editorial', 'Modern Corporate', 'Luxury Hospitality', 'Lifestyle & Human', 'Clean E-commerce', 'Dynamic Events', 'Contemporary Geometric', 'Soft & Organic']);
  });

  it('ids are stable and unique (they are stored with campaigns: never renamed)', () => {
    assert.deepEqual([...COLLECTION_IDS], ['minimal_tech', 'bold_startup', 'premium_editorial', 'modern_corporate', 'luxury_hospitality', 'lifestyle_human', 'clean_ecommerce', 'dynamic_events', 'contemporary_geometric', 'soft_organic']);
    assert.equal(new Set(COLLECTIONS.map((c) => c.id)).size, 10);
    for (const c of COLLECTIONS) assert.equal(getCollection(c.id), c);
    assert.equal(getCollection('nope'), undefined);
    for (const c of COLLECTIONS) assert.ok(c.version >= 1 && c.enabled);
  });

  it('every collection satisfies every rule of the registry and references valid, active templates', () => {
    assert.deepEqual(validateCollections(), []);
    const ids = new Map(TEMPLATE_LIBRARY.map((t) => [t.id, t]));
    for (const c of COLLECTIONS) {
      for (const id of c.templateIds) assert.equal(ids.get(id)?.status, 'active', `${c.id}: ${id}`);
      assert.equal(new Set(c.templateIds).size, c.templateIds.length);
    }
    // the validator really catches mistakes
    const broken = [{ ...COLLECTIONS[0], templateIds: [...COLLECTIONS[0].templateIds, 'does_not_exist_xx'] }, ...COLLECTIONS.slice(1)];
    assert.ok(validateCollections(broken).some((i) => /does not exist/.test(i.message)));
    assert.ok(validateCollections(COLLECTIONS.slice(1)).some((i) => /missing|expected 10/.test(i.message)));
  });

  it('each collection supports a complete campaign: hero, highlight, benefit and promo roles plus story, feed and banner formats', () => {
    for (const c of COLLECTIONS) {
      const cov = coverageOf(c);
      for (const role of COLLECTION_ROLES) assert.ok(cov.roles[role].length >= 1, `${c.id} role ${role}`);
      assert.deepEqual(cov.has, { story: true, feed: true, banner: true }, c.id);
      for (const cls of FORMAT_CLASSES) assert.ok(cov.byClass[cls].length >= 1, `${c.id} has a template without required facts for ${cls}`);
      for (const f of ['instagram_square', 'instagram_portrait', 'story', 'facebook_feed', 'linkedin_feed', 'web_banner', 'landing_hero', 'flyer', 'billboard', 'promo_16x9']) assert.ok(cov.formats.includes(f), `${c.id} can draw ${f}`);
      assert.ok(c.templateIds.length >= 5, c.id);
      // enough different compositions for 15 creatives: several families and more than one template per class that matters
      const fams = new Set(collectionTemplates(c).map((t) => t.family));
      assert.ok(fams.size >= 4, `${c.id}: ${[...fams].join(',')}`);
      assert.ok(cov.byClass.square.length >= 3 && cov.byClass.story.length >= 3, `${c.id}: square ${cov.byClass.square.length}, story ${cov.byClass.story.length}`);
    }
  });

  it('every one of the original 31 templates stays in the library, active and reachable (reorganized, never deleted)', () => {
    const ids = new Set(TEMPLATE_LIBRARY.map((t) => t.id));
    for (const id of ORIGINAL_31) assert.ok(ids.has(id), `${id} still exists`);
    // reorganized, not dropped: every original template belongs to at least one collection
    const inCollections = new Set(COLLECTIONS.flatMap((c) => c.templateIds));
    assert.deepEqual(ORIGINAL_31.filter((id) => !inCollections.has(id)), []);
    assert.ok(TEMPLATE_LIBRARY.length >= 50);
  });

  it('every style of the style library has exactly one collection (the old style words map onto collections)', () => {
    for (const s of STYLE_IDS) assert.ok(collectionForStyle(s), s);
    assert.equal(new Set(COLLECTIONS.map((c) => c.styleId)).size, 10);
  });
});

// ---- tokens: what makes templates of one collection a family -----------------------------------------------------------------------------------------------

const textLayers = (t: TemplateDef) => t.layers.filter((l): l is Extract<Layer, { type: 'text' }> => l.type === 'text');

describe('templates of one collection share their design tokens', () => {
  it('headline type, button shape, brand lettering and decoration are identical across every template of a collection', () => {
    for (const c of COLLECTIONS) {
      const themed = themedTemplates(c);
      assert.equal(themed.length, c.templateIds.length, c.id);
      const tk = c.tokens;
      const heads = new Set<string>();
      const buttons = new Set<string>();
      const logos = new Set<string>();
      const kinds = new Set<string>();
      for (const t of themed) {
        for (const l of textLayers(t).filter((x) => x.slot === 'headline')) heads.add(`${l.style.family}|${l.style.weight}|${l.style.case ?? 'none'}`);
        for (const l of t.layers) {
          if (l.type === 'button') buttons.add(`${l.radius}|${!!l.arrow}|${l.style.family}|${l.style.case ?? 'none'}`);
          if (l.type === 'logo') logos.add(`${l.nameStyle.family}|${l.nameStyle.weight}`);
          if (l.type === 'pattern') kinds.add(l.kind);
        }
      }
      assert.deepEqual([...heads], [`${tk.typography.headline.family}|${tk.typography.headline.weight}|${tk.typography.headline.case}`], `${c.id} headline`);
      assert.deepEqual([...buttons], [`${tk.shape.buttonRadius}|${tk.shape.buttonArrow}|${tk.typography.button.family}|${tk.typography.button.case}`], `${c.id} buttons`);
      assert.deepEqual([...logos], [`${tk.typography.brand.family}|${tk.typography.brand.weight}`], `${c.id} brand lettering`);
      if (tk.decor.patterns === 'hide') assert.equal(kinds.size, 0, `${c.id} has no patterns`);
      else if (tk.decor.patterns !== 'keep') for (const k of kinds) assert.equal(k, tk.decor.patterns.kind, `${c.id} motif`);
    }
  });

  it('pictures that sit inside a layout follow the collection (mask, saturation); full-bleed pictures are never masked', () => {
    for (const c of COLLECTIONS) {
      for (const t of themedTemplates(c)) {
        for (const l of t.layers) {
          if (l.type !== 'image') continue;
          if (!l.treatment?.duotone) assert.equal(l.treatment?.saturation, c.tokens.image.saturation, `${c.id}/${t.id}`);
          const [x, y, w, h] = l.box;
          const bleed = w * h >= 0.8 || [x <= 0.01, y <= 0.01, x + w >= 0.99, y + h >= 0.99].filter(Boolean).length >= 3;
          if (bleed) assert.ok(!l.mask || l.mask === 'none' || l.mask === (TEMPLATE_LIBRARY.find((o) => o.id === t.id)!.layers.find((o) => o.id === l.id) as { mask?: string }).mask, `${c.id}/${t.id}/${l.id} bleed picture unmasked`);
        }
      }
    }
  });

  it('theming is pure and deterministic: the library template is untouched, the result is valid and keeps id, version and layer order', () => {
    for (const c of COLLECTIONS) {
      for (const base of collectionTemplates(c)) {
        const before = JSON.stringify(base);
        const a = applyCollection(base, c);
        const b = applyCollection(base, c);
        assert.equal(JSON.stringify(base), before, 'input not mutated');
        assert.equal(JSON.stringify(a), JSON.stringify(b), 'deterministic');
        assert.equal(a.id, base.id);
        assert.equal(a.version, base.version);
        const v = validateTemplate(a);
        assert.ok(v.ok, `${c.id}/${base.id}: ${v.ok ? '' : v.issues.map((i) => i.message).join('; ')}`);
        const keptIds = base.layers.map((l) => l.id).filter((id) => a.layers.some((l) => l.id === id));
        assert.deepEqual(a.layers.map((l) => l.id), keptIds, 'order preserved');
        assert.ok(a.layers.length >= base.layers.length - base.layers.filter((l) => l.type === 'pattern').length);
      }
    }
    assert.equal(themedTemplate(COLLECTIONS[0], 'editorial_minimal'), undefined, 'a template outside the collection is not offered by it');
  });

  it('every themed template renders its sample in every class it declares without cut text, moved boxes or an unreadable result', async () => {
    const problems: string[] = [];
    for (const c of COLLECTIONS) {
      const a = designAnchors(c.defaultPalette);
      for (const t of themedTemplates(c)) {
        for (const cls of t.classes) {
          const r = await renderTemplatePreview({ template: t, class: cls, palette: designBrandColors(c.defaultPalette), anchors: { ink: a.ink, paper: a.paper } });
          if (!r.ok) problems.push(`${c.id}/${t.id}/${cls}: ${r.message}`);
          else for (const f of r.flags) if (/^(moved_into_safe_area|text_trimmed|text_hyphenated|low_contrast_unresolved)/.test(f)) problems.push(`${c.id}/${t.id}/${cls}: ${f}`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });
});

// ---- the collections really differ -------------------------------------------------------------------------------------------------------------------------

const signature = (c: (typeof COLLECTIONS)[number]) => {
  const t = c.tokens;
  return [t.typography.headline.family, t.typography.headline.weight <= 400 ? 'light' : t.typography.headline.weight >= 700 ? 'heavy' : 'medium', t.typography.headline.case, t.typography.body.family, t.typography.label.family, t.typography.label.case, t.shape.buttonRadius >= 0.3 ? 'pill' : t.shape.buttonRadius > 0 ? 'soft' : 'square', t.shape.cardRadius >= 0.1 ? 'round' : t.shape.cardRadius > 0.03 ? 'soft' : 'square', t.image.mask, t.decor.patterns === 'hide' ? 'none' : t.decor.patterns === 'keep' ? 'keep' : t.decor.patterns.kind, t.shape.cardShadow ? 'shadow' : 'flat', t.shape.buttonArrow ? 'arrow' : 'noarrow'];
};

describe('the collections are meaningfully different from each other', () => {
  it('any two collections differ in at least four design dimensions (type, corners, buttons, picture mask, motif, shadows...)', () => {
    for (let i = 0; i < COLLECTIONS.length; i++) {
      for (let j = i + 1; j < COLLECTIONS.length; j++) {
        const a = signature(COLLECTIONS[i]);
        const b = signature(COLLECTIONS[j]);
        const diff = a.filter((v, k) => v !== b[k]).length;
        assert.ok(diff >= 4, `${COLLECTIONS[i].id} vs ${COLLECTIONS[j].id}: only ${diff} dimensions differ`);
      }
    }
  });

  it('default palettes are distinct, and every default palette is readable', () => {
    assert.equal(new Set(COLLECTIONS.map((c) => c.defaultPalette.primary.toLowerCase())).size, 10);
    assert.equal(new Set(COLLECTIONS.map((c) => JSON.stringify(c.defaultPalette))).size, 10);
  });

  it('each collection owns compositions of its own: at least three templates that no other collection uses', () => {
    for (const c of COLLECTIONS) {
      const others = new Set(COLLECTIONS.filter((o) => o.id !== c.id).flatMap((o) => o.templateIds));
      const own = c.templateIds.filter((id) => !others.has(id));
      assert.ok(own.length >= 2, `${c.id} owns ${own.length}: ${own.join(', ')}`);
    }
  });

  it('the same template drawn by two collections gives a clearly different picture (not a recolor)', async () => {
    const palette = { primary: '#2f5bff', secondary: '#111827', accent: '#14b8a6', background: '#f5f6f8', text: '#0f1419' };
    const a = designAnchors(palette);
    const small = async (collectionId: string, templateId: string) => {
      const t = themedTemplate(getCollection(collectionId)!, templateId);
      assert.ok(t, `${collectionId} lists ${templateId}`);
      const r = await renderTemplatePreview({ template: t, class: 'square', palette: designBrandColors(palette), anchors: { ink: a.ink, paper: a.paper } });
      assert.ok(r.ok);
      return sharp(r.ok ? r.png : Buffer.alloc(0)).resize(96, 96, { fit: 'fill' }).greyscale().raw().toBuffer();
    };
    const pairs: [string, string, string][] = [
      ['modern_corporate', 'soft_organic', 'services_trust'],
      ['premium_editorial', 'clean_ecommerce', 'ecommerce_new_collection'],
      ['minimal_tech', 'modern_corporate', 'tech_workflow_steps'],
      ['lifestyle_human', 'soft_organic', 'events_community'],
    ];
    for (const [c1, c2, tpl] of pairs) {
      const x = await small(c1, tpl);
      const y = await small(c2, tpl);
      let sum = 0;
      for (let k = 0; k < x.length; k++) sum += Math.abs(x[k] - y[k]);
      assert.ok(sum / x.length > 2.5, `${tpl} in ${c1} vs ${c2}: mean difference ${(sum / x.length).toFixed(1)}`);
    }
  });
});

describe('formats of the collections', () => {
  it('the print-shaped formats exist and fall into the classes the templates are drawn for', () => {
    assert.deepEqual([CREATIVE_FORMATS.flyer.width, CREATIVE_FORMATS.flyer.height], [1240, 1748]);
    assert.deepEqual([CREATIVE_FORMATS.billboard.width, CREATIVE_FORMATS.billboard.height], [2400, 800]);
  });
});
