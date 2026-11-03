import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { CREATIVE_FORMATS } from '../creative/formats';
import { directionFor } from '../hybrid/direction';
import { checkDesignFit, designFormatIds } from '../hybrid/design-plan';
import { planHybrid } from '../hybrid/plan';
import { mergeHybrid } from '../hybrid/settings';
import { renderTemplatePreview } from '../templates/preview';
import { renderTemplate } from '../templates/render';
import { TEMPLATE_LIBRARY } from '../templates/library';
import { FORMAT_OPTIONS, FORMAT_OPTION_KEYS, checkPalette, designAnchors, designBrandColors, formatIdsOf, formatKeysFromProject, newDesign, paletteKeyOf, parseDesign, switchCollection, editPaletteRole } from './design';
import { COLLECTIONS, getCollection, themedTemplate } from './registry';

const base = () => newDesign('premium_editorial', { formats: ['instagram_post', 'website_banner'] });

describe('the campaign design is ONE validated object', () => {
  it('a valid design round-trips; hex colors are normalized to lower case', () => {
    const d = base();
    const r = parseDesign({ ...d, palette: { ...d.palette, primary: '#6B2D3C' } });
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.design.palette.primary, '#6b2d3c');
  });

  it('an invalid design is refused with a reason, never repaired: unknown collection, bad color, unknown format, bad version', () => {
    const d = base();
    assert.equal(parseDesign({ ...d, collectionId: 'retro_arcade' }).ok, false);
    assert.equal(parseDesign({ ...d, palette: { ...d.palette, accent: 'orange' } }).ok, false);
    assert.equal(parseDesign({ ...d, formats: ['tv_commercial'] }).ok, false);
    assert.equal(parseDesign({ ...d, version: 2 }).ok, false);
    assert.equal(parseDesign(null).ok, false);
    const bad = parseDesign({ ...d, collectionId: 'retro_arcade' });
    assert.ok(!bad.ok && /collection|Invalid/i.test(bad.message));
  });

  it('a new design is a draft: nothing is confirmed, every color says it is a default', () => {
    const d = newDesign('bold_startup');
    assert.equal(d.confirmed, false);
    assert.equal(d.confirmedAt, null);
    assert.deepEqual(d.overridden, []);
    for (const e of Object.values(d.paletteEvidence)) assert.equal(e!.source, 'collection_default');
    assert.equal(d.collectionVersion, getCollection('bold_startup')!.version);
  });

  it('the palette key identifies a palette; editing a color changes it and un-confirms the design', () => {
    const d = { ...base(), confirmed: true, confirmedAt: new Date().toISOString() };
    const e = editPaletteRole(d, 'accent', '#00ff88');
    assert.notEqual(paletteKeyOf(d.palette), paletteKeyOf(e.palette));
    assert.equal(e.confirmed, false);
    assert.deepEqual(e.overridden, ['accent']);
    assert.equal(paletteKeyOf(e.palette), paletteKeyOf({ ...d.palette, accent: '#00ff88' }));
  });
});

describe('one selection only: nothing can contradict the design', () => {
  it('the collection is chosen ONCE: the old style field cannot disagree with it', () => {
    const d = newDesign('premium_editorial');
    const s = mergeHybrid({ style: 'bold_startup', design: d });
    assert.equal(s.design?.collectionId, 'premium_editorial');
    assert.equal(s.style, getCollection('premium_editorial')!.styleId, 'the legacy field mirrors the collection');
    // without a design the legacy field keeps its old meaning
    assert.equal(mergeHybrid({ style: 'bold_startup' }).style, 'bold_startup');
    assert.equal(mergeHybrid({}).design, null);
    assert.throws(() => mergeHybrid({ design: { ...d, collectionId: 'nope' } }), /not valid/);
  });

  it('the palette is chosen ONCE: the visual direction (Visual Researcher input) uses the approved palette, the collection style and its own type system', () => {
    let d = newDesign('luxury_hospitality');
    d = editPaletteRole(d, 'primary', '#123456');
    const s = mergeHybrid({ style: 'bold_startup', design: d });
    const vb = { business: 'Villa Nova', offering: 'boutique hotel', valueProposition: '', campaignGoal: 'bookings', audience: { primary: 'couples', secondary: [], segments: [] }, brand: { tone: 'warm', visualDirection: 'playful', constraints: [], palette: ['#ff0000', '#00ff00'], observed: [] }, locale: { geography: [], language: 'en' }, channels: [], avoid: [] };
    const dir = directionFor({ visualBrief: vb as never, projectName: 'Villa Nova', channels: ['instagram'], palette: ['#ff0000', '#00ff00'], hasBrandPalette: true, settings: s, referencePalettes: {} });
    const c = getCollection('luxury_hospitality')!;
    assert.equal(dir.styleId, c.styleId, 'the style of the collection, not the legacy "bold_startup"');
    assert.deepEqual(dir.secondaryStyleIds, []);
    assert.equal(dir.colors.primary, '#123456', 'the user\'s color, not the measured brand palette of the brief');
    assert.equal(dir.colors.accent, d.palette.accent);
    assert.equal(dir.origin, 'user_approved');
    assert.equal(dir.typography.headline, c.tokens.typography.headline.family);
    assert.ok(dir.references.some((r) => r.id === 'campaign-design' && r.permission === 'owned_by_user'));
  });

  it('background and text become the neutral surfaces: a dark brand keeps its dark background', () => {
    const light = designAnchors({ primary: '#2f5bff', secondary: '#111827', accent: '#14b8a6', background: '#f5f6f8', text: '#0f1419' });
    assert.deepEqual([light.ink, light.paper, light.backgroundMode], ['#0f1419', '#f5f6f8', 'light']);
    const dark = designAnchors({ primary: '#7c3aed', secondary: '#1e1b4b', accent: '#ffe14d', background: '#0e0b1f', text: '#ffffff' });
    assert.deepEqual([dark.ink, dark.paper, dark.backgroundMode], ['#0e0b1f', '#ffffff', 'dark']);
    assert.deepEqual(designBrandColors({ primary: '#111111', secondary: '#222222', accent: '#333333', background: '#ffffff', text: '#000000' }), ['#111111', '#222222', '#333333']);
  });
});

describe('palette: the renderer uses exactly what the user approved', () => {
  const palette = { primary: '#d4145a', secondary: '#1b1464', accent: '#fbb03b', background: '#fff7ed', text: '#1a1a1a' };

  it('palette changes update the preview (the same collection and template, another palette: other pixels), and the collection look stays', async () => {
    const c = getCollection('bold_startup')!;
    const t = themedTemplate(c, 'bold_big_claim')!;
    const draw = async (p: typeof palette) => {
      const a = designAnchors(p);
      const r = await renderTemplatePreview({ template: t, class: 'square', palette: designBrandColors(p), anchors: { ink: a.ink, paper: a.paper } });
      assert.ok(r.ok);
      return r.ok ? r.png : Buffer.alloc(0);
    };
    const one = await draw(palette);
    const two = await draw({ ...palette, primary: '#0a8f4c', accent: '#3b82f6' });
    assert.notDeepEqual(one, two);
    const px = async (png: Buffer, x: number, y: number) => (await sharp(png).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer()).toString('hex');
    // the brand field of this template is the primary color: it follows the palette exactly
    assert.equal(await px(one, 5, 5), 'd4145a');
    assert.equal(await px(two, 5, 5), '0a8f4c');
  });

  it('the approved background and text are used exactly as the surfaces (a light template paints the approved paper color)', async () => {
    const c = getCollection('minimal_tech')!;
    const t = themedTemplate(c, 'tech_minimalist')!;
    const a = designAnchors({ ...palette, background: '#fdf6e3', text: '#073642' });
    const r = await renderTemplate({ template: t, width: 1080, height: 1080, content: { headline: 'Hello there' }, palette: [palette.primary, palette.secondary, palette.accent], anchors: { ink: a.ink, paper: a.paper }, brandName: 'X' });
    assert.ok(r.ok);
    const px = (await sharp(r.ok ? r.png : Buffer.alloc(0)).extract({ left: 540, top: 20, width: 1, height: 1 }).raw().toBuffer()).toString('hex');
    assert.equal(px, 'fdf6e3');
  });

  it('contrast is validated: unreadable text is an error, near-duplicates of the background a warning', () => {
    assert.equal(checkPalette(palette).ok, true);
    assert.equal(checkPalette({ ...palette, text: '#fff1e0' }).ok, false);
    assert.equal(checkPalette({ ...palette, accent: '#7f7f7f' }).ok, true);
    assert.ok(checkPalette({ ...palette, accent: '#fff6ea' }).warnings.some((w) => /close to the background/.test(w)));
  });
});

describe('collections and palettes work together', () => {
  it('changing the collection never silently discards edited colors', () => {
    let d = editPaletteRole(newDesign('minimal_tech'), 'primary', '#aa2244');
    d = editPaletteRole(d, 'text', '#101010');
    for (const c of COLLECTIONS) {
      const r = switchCollection(d, c.id);
      assert.equal(r.design.palette.primary, '#aa2244', c.id);
      assert.equal(r.design.palette.text, '#101010', c.id);
      assert.equal(r.design.collectionId, c.id);
      assert.equal(r.design.confirmed, false);
    }
  });

  it('an incompatible palette is explained, not blocked, as long as the text stays readable', () => {
    const d = editPaletteRole(newDesign('minimal_tech'), 'background', '#0b1020');
    const sw = switchCollection(editPaletteRole(d, 'text', '#ffffff'), 'premium_editorial');
    assert.equal(sw.fit.ok, true);
    assert.ok(sw.fit.notes.some((n) => /light backgrounds/.test(n)), sw.fit.notes.join(' | '));
  });
});

// ---- formats -----------------------------------------------------------------------------------------------------------------------------------------

describe('output formats of the design', () => {
  it('every option maps onto real creative formats, the project defaults use the same keys, unknown keys are dropped', () => {
    for (const k of FORMAT_OPTION_KEYS) for (const id of FORMAT_OPTIONS[k].formatIds) assert.ok(CREATIVE_FORMATS[id], `${k} -> ${id}`);
    assert.deepEqual(formatIdsOf(['instagram_post', 'website_banner']), ['instagram_square', 'instagram_portrait', 'web_banner', 'landing_hero']);
    assert.deepEqual(formatKeysFromProject(['instagram_post', 'flyer', 'carrier_pigeon']), ['instagram_post', 'flyer']);
    assert.deepEqual(formatKeysFromProject(null), []);
  });

  it('the template creatives rotate through exactly the chosen formats, each concept starting at another one', () => {
    const concepts = Array.from({ length: 5 }, (_, i) => ({ id: `K${i + 1}`, name: `Concept ${i + 1}`, channels: ['instagram', 'facebook'] as never }));
    const ids = ['story', 'web_banner', 'flyer'];
    const plan = planHybrid({ concepts, originals: 5, templateCreatives: 15, channelPriority: ['instagram'], fixedSize: null, brandImages: 0, basis: 'forecast', formatIds: ids });
    assert.equal(plan.slots.length, 15);
    assert.deepEqual([...new Set(plan.slots.map((s) => s.formatId))].sort(), [...ids].sort());
    for (const f of ids) assert.equal(plan.slots.filter((s) => s.formatId === f).length, 5, `${f} used evenly`);
    const flyer = plan.slots.find((s) => s.formatId === 'flyer')!;
    assert.deepEqual([flyer.width, flyer.height], [1240, 1748]);
    // without chosen formats the earlier behaviour is unchanged
    const legacy = planHybrid({ concepts, originals: 5, templateCreatives: 15, channelPriority: ['instagram'], fixedSize: null, brandImages: 0, basis: 'forecast' });
    assert.ok(new Set(legacy.slots.map((s) => s.formatId)).size >= 3);
    assert.ok(!legacy.slots.some((s) => s.formatId === 'flyer'));
  });

  it('designFormatIds follows the design and only the formats the collection can draw', () => {
    assert.equal(designFormatIds({ design: null }), undefined);
    assert.equal(designFormatIds({ design: newDesign('minimal_tech') }), undefined, 'no format chosen: the formats follow the strategy');
    assert.deepEqual(designFormatIds({ design: newDesign('minimal_tech', { formats: ['instagram_story', 'billboard'] }) }), ['story', 'billboard']);
  });

  it('a format the collection cannot draw is explained BEFORE spending, with options; nothing is switched silently', () => {
    const noBanner = TEMPLATE_LIBRARY.filter((t) => !t.classes.includes('banner'));
    const fit = checkDesignFit({ collectionId: 'minimal_tech', formatKeys: ['instagram_post', 'billboard'], hasPicture: true, facts: {}, templateCreatives: 15, library: noBanner });
    assert.equal(fit.ok, false);
    assert.deepEqual(fit.unsupported.map((f) => f.key), ['billboard']);
    assert.match(fit.messages.join(' '), /Minimal Tech has no template for Billboard/);
    assert.ok(fit.options.plan.length >= 2);
    assert.ok(fit.options.formats.some((f) => f.key === 'instagram_post'));
    const ok = checkDesignFit({ collectionId: 'minimal_tech', formatKeys: ['instagram_post', 'billboard'], hasPicture: true, facts: {}, templateCreatives: 15 });
    assert.equal(ok.ok, true);
  });

  it('without a picture, templates that need one are not counted; facts the user gave unlock templates that need them', () => {
    const noPic = checkDesignFit({ collectionId: 'luxury_hospitality', formatKeys: ['instagram_story'], hasPicture: false, facts: {}, templateCreatives: 15 });
    const withPic = checkDesignFit({ collectionId: 'luxury_hospitality', formatKeys: ['instagram_story'], hasPicture: true, facts: {}, templateCreatives: 15 });
    assert.ok(withPic.thin.length <= noPic.thin.length);
    assert.equal(withPic.ok, true);
  });
});
