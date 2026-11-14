import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { analyzeSubject } from '../imagery/subject';
import { personScene, type SkinTone } from '../testing/photo-fixtures';
import { repairLoop } from './design-loop';
import { TEMPLATE_LIBRARY } from './library';
import { UI_LAYER_PATTERN, nextRepair, preflight, type PreflightInput } from './preflight';
import { renderTemplate } from './render';
import { validateTemplate, type Layer, type RenderSubject, type TemplateDef, type TemplateRenderInput } from './schema';

// THE DESIGN PREFLIGHT and its automatic repairs, on synthetic pictures (skin-tone faces with sensor noise on a dark backdrop, a flat logo
// banner). Local and deterministic: no model, no network, no real photograph, nothing billed.

/** A "group photo": people (shaded heads with eyes, brows, mouth; neck and shoulders) of mixed skin tones on a lit studio backdrop. */
const TONES: SkinTone[] = ['light', 'brown', 'very_light', 'deep', 'medium', 'dark'];
const groupPhoto = (w: number, h: number, faces: [number, number][], faceH = 0.12): Promise<Buffer> =>
  personScene({ width: w, height: h, people: faces.map(([x, y], i) => ({ x, y, size: faceH, tone: TONES[i % TONES.length] })), backdrop: 'studio' });

/** A flat graphic: a navy field with a white wordmark bar and a red diagonal (like a logo banner). Cropping it cuts the "letters". */
async function logoBanner(w: number, h: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#12305a"/><polygon points="${w * 0.7},0 ${w},0 ${w},${h} ${w * 0.45},${h}" fill="#d3232a"/><rect x="${w * 0.08}" y="${h * 0.4}" width="${w * 0.6}" height="${h * 0.2}" fill="#ffffff"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A wide white wordmark logo with transparency. */
const whiteLogo = () => sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect x="4" y="10" width="392" height="80" rx="8" fill="#ffffff"/></svg>')).png().toBuffer();

function tpl(id: string, layers: Layer[], classes: TemplateDef['classes'] = ['square', 'landscape', 'banner', 'portrait', 'story']): TemplateDef {
  const raw = { id, name: `Test ${id}`, version: 1, status: 'active', category: 'professional_services', description: 'A synthetic template for the preflight tests.', styles: ['modern_corporate'], industries: ['*'], channels: [], classes, requires: [], density: 'balanced', family: 'full-bleed', composition: 'A synthetic composition for the tests.', sample: { headline: 'Sample' }, tone: 'dark', layers };
  const v = validateTemplate(raw);
  assert.ok(v.ok, JSON.stringify(!v.ok && v.issues));
  return v.ok ? v.template : (raw as unknown as TemplateDef);
}

const TEXT = { family: 'sans' as const, weight: 700 };
const headline = (box: [number, number, number, number], extra: Partial<Extract<Layer, { type: 'text' }>> = {}): Layer => ({ id: 'headline', type: 'text', slot: 'headline', box, align: 'left', valign: 'middle', style: TEXT, color: 'white', size: { max: 0.06, min: 0.03 }, maxLines: 2, ...extra });
const photo = (box: [number, number, number, number] = [0, 0, 1, 1]): Layer => ({ id: 'photo', type: 'image', slot: 'hero', box });
const logoLayer = (box: [number, number, number, number]): Layer => ({ id: 'logo', type: 'logo', box, align: 'left', valign: 'top', nameStyle: TEXT, nameColor: 'white' });

const base = (template: TemplateDef, over: Partial<TemplateRenderInput> = {}): TemplateRenderInput => ({ template, width: 1200, height: 1200, content: { headline: 'Which risk needs whose decision?', cta: 'Explore the approach' }, palette: ['#12305a', '#d3232a', '#f4f5f7'], brandName: 'Acme Group', ...over });
const check = (res: Extract<Awaited<ReturnType<typeof renderTemplate>>, { ok: true }>, o: Partial<PreflightInput> = {}) => preflight({ report: res.report, flags: res.flags, layers: res.layers, hasLogo: false, hasPicture: true, templateHasImage: true, ...o });
const ok = async (input: TemplateRenderInput) => {
  const r = await renderTemplate(input);
  assert.ok(r.ok, r.ok ? '' : r.message);
  return r as Extract<typeof r, { ok: true }>;
};
const subjectOf = async (buf: Buffer): Promise<RenderSubject> => {
  const m = await analyzeSubject(buf);
  assert.ok(m);
  return { faces: m!.faces, subject: m!.subject, graphic: m!.graphic };
};

describe('subject analysis (local pixels, no model)', () => {
  it('finds the faces of a group photo and the subject box around the people; a flat logo banner is a graphic', async () => {
    const group = await groupPhoto(1200, 800, [[0.15, 0.3], [0.38, 0.32], [0.62, 0.3], [0.85, 0.33]]);
    const m = (await analyzeSubject(group))!;
    assert.equal(m.graphic, false);
    assert.equal(m.faces.length, 4, JSON.stringify(m.faces));
    for (const f of m.faces) assert.ok(f[2] > 0.03 && f[3] > 0.06, 'a face is a real region, not a speck');
    assert.ok(m.subject[0] < 0.12 && m.subject[0] + m.subject[2] > 0.88, 'the subject spans the whole group');
    const banner = (await analyzeSubject(await logoBanner(1200, 630)))!;
    assert.equal(banner.graphic, true);
    assert.equal(banner.faces.length, 0);
  });
});

describe('crop and focal visibility', () => {
  it('a narrow picture box keeps faces WHOLE (a person left out entirely rather than cut in half); without subject data the centre crop cuts one', async () => {
    // four people across a wide photo; the picture box is a tall narrow column: not everyone fits
    const group = await groupPhoto(1600, 900, [[0.2, 0.35], [0.4, 0.35], [0.6, 0.35], [0.8, 0.35]], 0.18);
    const t = tpl('test_column', [{ id: 'bg', type: 'fill', fill: 'ink' }, photo([0.1, 0.05, 0.35, 0.9]), headline([0.5, 0.4, 0.45, 0.2])]);
    const subject = await subjectOf(group);
    const aware = await ok(base(t, { images: { hero: group }, subject }));
    const cut = (r: typeof aware) => r.report.hero!.faces.filter((f) => f.inFrame > 0.15 && f.inFrame < 0.85).length;
    assert.equal(cut(aware), 0, `no face is cut: ${JSON.stringify(aware.report.hero!.faces.map((f) => f.inFrame))}`);
    assert.ok(aware.report.hero!.faces.some((f) => f.inFrame >= 0.97), 'at least one person is fully in the frame');
    assert.ok(aware.flags.includes('crop_subject_aware:hero'));
    assert.equal(check(aware).checks.find((c) => c.id === 'face_crop')!.status, 'pass');
    // the earlier behaviour (centre crop on the focus point) is measured with the same subject data, but without letting it steer the crop
    const blind = await ok(base(t, { images: { hero: group }, heroFocus: [0.5, 0.5] }));
    assert.equal(blind.report.hero!.faces.length, 0, 'without subject data nothing is measured or steered');
  });

  it('a wide billboard keeps the whole group in the frame', async () => {
    const group = await groupPhoto(1600, 1600, [[0.3, 0.42], [0.5, 0.4], [0.7, 0.42]], 0.1);
    const t = tpl('test_billboard', [photo([0, 0, 1, 1]), headline([0.05, 0.75, 0.6, 0.15])], ['banner']);
    const r = await ok(base(t, { width: 2400, height: 800, images: { hero: group }, subject: await subjectOf(group) }));
    assert.ok(r.report.hero!.faces.every((f) => f.inFrame >= 0.97), JSON.stringify(r.report.hero!.faces.map((f) => f.inFrame)));
    assert.equal(check(r).checks.find((c) => c.id === 'face_crop')!.status, 'pass');
  });

  it('a flat graphic (logo banner) is FITTED whole, never cropped: its letters are not cut', async () => {
    const banner = await logoBanner(1200, 630);
    const t = tpl('test_square_photo', [photo([0, 0, 1, 1]), headline([0.05, 0.8, 0.9, 0.12])]);
    const r = await ok(base(t, { images: { hero: banner }, subject: await subjectOf(banner) }));
    assert.equal(r.report.hero!.fit, 'contain');
    assert.ok(r.flags.includes('image_fitted:hero'));
    assert.equal(check(r).checks.find((c) => c.id === 'graphic_crop')!.status, 'pass');
  });
});

describe('overlay occlusion and the opacity rules', () => {
  const group = () => groupPhoto(1200, 1200, [[0.25, 0.42], [0.5, 0.4], [0.75, 0.42]], 0.13);
  const bandTemplate = () =>
    tpl('test_band', [
      photo(),
      // a dark band right across the faces, with the headline on it (the "dark panel over people" of the field report)
      { id: 'band', type: 'rect', box: [0, 0.3, 1, 0.25], fill: '#0b1530' },
      headline([0.06, 0.62, 0.88, 0.14]),
    ]);

  it('a panel over the faces FAILS the face check, and the repair loop renders again until the people are visible; the text keeps full opacity', async () => {
    const hero = await group();
    const subject = await subjectOf(hero);
    const t = bandTemplate();
    const first = await ok(base(t, { images: { hero }, subject }));
    const pre = check(first);
    assert.equal(pre.checks.find((c) => c.id === 'face_occlusion')!.status, 'fail', pre.checks.map((c) => `${c.id}:${c.status}`).join(' '));
    assert.ok(pre.checks.find((c) => c.id === 'face_occlusion')!.layers!.includes('band'));
    const loop = await repairLoop('test_band', (tune) => renderTemplate(base(t, { images: { hero }, subject, tune })), (res) => check(res), 5);
    assert.ok(loop.renders > 1, 'it was rendered again after the failed check');
    const best = loop.best!;
    assert.ok(best.actions.some((a) => a.kind === 'opacity' && a.target === 'band') || best.actions.some((a) => a.kind === 'hide' && a.target === 'band'), JSON.stringify(best.actions));
    assert.notEqual(best.pre.checks.find((c) => c.id === 'face_occlusion')!.status, 'fail', best.pre.failures.map((f) => f.detail).join(' | '));
    const v0 = Math.min(...first.report.hero!.faces.map((f) => f.visibility ?? 1));
    const v1 = Math.min(...best.res.report.hero!.faces.map((f) => f.visibility ?? 1));
    assert.ok(v1 > v0 + 0.2, `the faces became visible (${v0} -> ${v1})`);
    // never the text: the headline is drawn in full colour
    assert.ok(best.res.report.texts.every((x) => x.contrast >= 0.85));
    assert.ok(!best.res.flags.some((f) => f.startsWith('layer_lightened:headline') || f.startsWith('layer_hidden:headline')));
  });

  it('a template opacity on TEXT never makes it see-through: over a picture it is drawn in full colour (and says so)', async () => {
    const hero = await group();
    const t = tpl('test_faded_text', [photo(), { id: 'scrim', type: 'rect', box: [0, 0.7, 1, 0.3], fill: '#000000', opacity: 0.6 }, headline([0.06, 0.74, 0.88, 0.2], { opacity: 0.4 })]);
    const r = await ok(base(t, { images: { hero } }));
    assert.ok(r.flags.includes('text_toned:headline'));
    // the glyphs are solid: pixels inside the text block reach (almost) pure white, which a 40%-opaque white would never do over a dark scrim
    const raw = await sharp(r.png).raw().toBuffer({ resolveWithObject: true });
    const tr = r.report.texts[0].rect;
    let bright = 0;
    for (let y = Math.floor(tr.y); y < tr.y + tr.h; y += 2) for (let x = Math.floor(tr.x); x < tr.x + tr.w; x += 2) {
      const i = (y * raw.info.width + x) * raw.info.channels;
      if (raw.data[i] > 235 && raw.data[i + 1] > 235 && raw.data[i + 2] > 235) bright++;
    }
    assert.ok(bright > 50, `solid white glyph pixels: ${bright}`);
  });

  it('a light card that carries dark text is NOT made see-through (it would turn muddy): only a dark panel behind light text is lightened', () => {
    const report = {
      width: 1000, height: 1000, safe: { l: 60, t: 60, r: 940, b: 940 },
      hero: { layerId: 'photo', rect: { x: 0, y: 0, w: 1000, h: 1000 }, fit: 'cover' as const, zoom: 1, graphic: false, rotated: false, cropLoss: 0, subjectInFrame: 1, subjectShare: 0.5, subjectVisibility: 0.4, pictureVisibility: 0.5, faces: [{ rect: { x: 100, y: 400, w: 80, h: 100 }, area: 8000, inFrame: 1, visibility: 0.3 }] },
      texts: [{ layerId: 'headline', slot: 'headline' as const, rect: { x: 80, y: 600, w: 400, h: 80 }, size: 40, contrast: 1, busy: 0.02, trimmed: false, backed: false, lum: 0.02 }],
      buttons: [],
      logo: null,
      decor: [{ layerId: 'card', type: 'rect', rect: { x: 50, y: 350, w: 500, h: 400 }, opacity: 1, area: 0.2, afterHero: true, lum: 0.95 }],
    };
    const p = preflight({ report, flags: [], layers: ['photo', 'card', 'headline'], hasLogo: false, hasPicture: true, templateHasImage: true });
    assert.equal(p.checks.find((c) => c.id === 'face_occlusion')!.status, 'fail');
    const n = nextRepair(p, report, {});
    assert.ok(!n?.tune.layerOpacity?.card, 'the light text card keeps its opacity');
    const dark = { ...report, texts: [{ ...report.texts[0], lum: 0.95 }], decor: [{ ...report.decor[0], lum: 0.02 }] };
    const n2 = nextRepair(preflight({ report: dark, flags: [], layers: ['photo', 'card', 'headline'], hasLogo: false, hasPicture: true, templateHasImage: true }), dark, {});
    assert.equal(n2?.tune.layerOpacity?.card, 0.75, 'a dark band behind light text is lowered moderately');
  });
});

describe('logo visibility', () => {
  it('a logo that is too small fails, is enlarged by the repair and passes; it stays inside the safe area', async () => {
    const hero = await groupPhoto(1200, 1200, [[0.5, 0.45]], 0.2);
    const t = tpl('test_tiny_logo', [photo(), logoLayer([0.06, 0.06, 0.08, 0.02]), headline([0.06, 0.75, 0.88, 0.15])]);
    const logo = await whiteLogo();
    const first = await ok(base(t, { images: { hero }, logo, logoAdapt: true }));
    const pre = check(first, { hasLogo: true });
    assert.equal(pre.checks.find((c) => c.id === 'logo_visibility')!.status, 'fail');
    assert.match(pre.checks.find((c) => c.id === 'logo_visibility')!.detail, /too small/);
    const loop = await repairLoop('test_tiny_logo', (tune) => renderTemplate(base(t, { images: { hero }, logo, logoAdapt: true, tune })), (res) => check(res, { hasLogo: true }), 5);
    assert.equal(loop.best!.pre.checks.find((c) => c.id === 'logo_visibility')!.status, 'pass', loop.best!.pre.failures.map((f) => f.detail).join(' | '));
    assert.ok(loop.best!.res.flags.includes('logo_enlarged'));
    const lr = loop.best!.res.report.logo!.rect;
    const s = loop.best!.res.report.safe;
    assert.ok(lr.x >= s.l - 1 && lr.y >= s.t - 1 && lr.x + lr.w <= s.r + 1 && lr.y + lr.h <= s.b + 1, 'inside the safe area');
  });

  it('an approved white logo on a template plate that is also white gets a contrasting plate (it never vanishes)', async () => {
    const t = tpl('test_plate', [{ id: 'bg', type: 'fill', fill: '#f4f5f7' }, { id: 'logo', type: 'logo', box: [0.06, 0.06, 0.3, 0.08], align: 'left', valign: 'top', plate: { fill: 'white', padding: 0.01, radius: 0.2 }, nameStyle: TEXT, nameColor: 'ink' }, headline([0.06, 0.4, 0.88, 0.2], { color: 'ink' })]);
    const r = await ok(base(t, { logo: await whiteLogo(), logoAdapt: true }));
    assert.ok(r.flags.includes('logo_plate_recoloured'));
    assert.ok(r.report.logo!.contrast >= 2.2, `contrast ${r.report.logo!.contrast}`);
  });
});

describe('text safe area and the call to action', () => {
  it('text placed outside the canvas is moved into the safe area; the check confirms every text block is inside', async () => {
    const t = tpl('test_edge', [{ id: 'bg', type: 'fill', fill: 'ink' }, headline([-0.1, 0.9, 0.7, 0.2])]);
    const r = await ok(base(t, { images: {} }));
    assert.ok(r.flags.some((f) => f.startsWith('moved_into_safe_area:headline')));
    assert.equal(check(r, { hasPicture: false, templateHasImage: false }).checks.find((c) => c.id === 'text_safe_area')!.status, 'pass');
  });

  it('a call to action that does not fit its button is never cut: the button grows into FREE space only (never over the headline)', async () => {
    const t = tpl('test_button', [
      { id: 'bg', type: 'fill', fill: 'paper' },
      headline([0.06, 0.3, 0.4, 0.4], { color: 'ink' }),
      { id: 'cta', type: 'button', box: [0.5, 0.45, 0.14, 0.1], fill: 'primary', radius: 0.3, style: { family: 'sans', weight: 700 }, color: 'onPrimary', size: { max: 0.04, min: 0.03 }, arrow: true },
    ], ['banner']);
    const r = await ok(base(t, { width: 2400, height: 800, content: { headline: 'Which risk needs whose decision?', cta: 'Explore the Firmenfels approach' } }));
    assert.ok(r.flags.includes('button_widened:cta'), r.flags.join(','));
    assert.ok(!r.report.buttons[0].trimmed, 'the call to action is whole');
    const h = r.report.texts[0].rect;
    const b = r.report.buttons[0].rect;
    assert.ok(b.x >= h.x + h.w - 1, 'it grew to the right, away from the headline');
    assert.equal(check(r, { hasPicture: false, templateHasImage: false }).checks.find((c) => c.id === 'text_collision')!.status, 'pass');
  });
});

describe('final asset purity: no editor or preview elements', () => {
  it('the built-in library has no slider arrows, carousel dots, selection handles, window chrome or progress knobs', () => {
    const found = TEMPLATE_LIBRARY.flatMap((t) => t.layers.filter((l) => UI_LAYER_PATTERN.test(l.id)).map((l) => `${t.id}/${l.id}`));
    assert.deepEqual(found, []);
    const comparison = TEMPLATE_LIBRARY.find((t) => t.id === 'ecommerce_comparison')!;
    assert.ok(!comparison.layers.some((l) => /chevron|badge/.test(l.id)), 'the before/after slider handle is gone');
    assert.ok(!TEMPLATE_LIBRARY.find((t) => t.id === 'tech_minimalist')!.layers.some((l) => /^handle-/.test(l.id)));
    assert.ok(!TEMPLATE_LIBRARY.find((t) => t.id === 'tech_feature_highlight')!.layers.some((l) => /^(dot-\d|chip)/.test(l.id)));
    assert.ok(!TEMPLATE_LIBRARY.find((t) => t.id === 'events_countdown')!.layers.some((l) => l.id === 'knob'));
  });

  it('a template that still carries one fails the purity check, and the repair renders it again without it', async () => {
    const t = tpl('test_slider', [
      { id: 'bg', type: 'fill', fill: 'ink' },
      headline([0.06, 0.3, 0.88, 0.2]),
      { id: 'arrow-left', type: 'polygon', points: [[0.04, 0.5], [0.08, 0.46], [0.08, 0.54]], fill: 'white' },
      { id: 'arrow-right', type: 'polygon', points: [[0.96, 0.5], [0.92, 0.46], [0.92, 0.54]], fill: 'white' },
    ]);
    const first = await ok(base(t));
    const pre = check(first, { hasPicture: false, templateHasImage: false });
    assert.equal(pre.checks.find((c) => c.id === 'final_asset_purity')!.status, 'fail');
    const loop = await repairLoop('test_slider', (tune) => renderTemplate(base(t, { tune })), (res) => check(res, { hasPicture: false, templateHasImage: false }), 3);
    assert.equal(loop.best!.pre.passed, true, loop.best!.pre.failures.map((f) => f.detail).join(' | '));
    assert.ok(!loop.best!.res.layers.includes('arrow-left') && !loop.best!.res.layers.includes('arrow-right'));
    assert.deepEqual(loop.best!.actions.map((a) => [a.kind, a.target]), [['hide', 'arrow-left'], ['hide', 'arrow-right']]);
  });
});

describe('subject size', () => {
  it('a group photo shrunk into a small tile fails (people as a thumbnail), the same photo full-bleed passes', async () => {
    const hero = await groupPhoto(1200, 1200, [[0.3, 0.4], [0.5, 0.38], [0.7, 0.4]], 0.08);
    const subject = await subjectOf(hero);
    const tile = tpl('test_tile', [{ id: 'bg', type: 'fill', fill: 'paper' }, photo([0.4, 0.45, 0.16, 0.2]), headline([0.06, 0.1, 0.88, 0.2], { color: 'ink' })], ['story']);
    const small = await ok(base(tile, { width: 1080, height: 1920, images: { hero }, subject }));
    assert.equal(check(small).checks.find((c) => c.id === 'subject_size')!.status, 'fail');
    const full = tpl('test_full', [photo(), headline([0.06, 0.8, 0.88, 0.12])], ['story']);
    const big = await ok(base(full, { width: 1080, height: 1920, images: { hero }, subject }));
    assert.equal(check(big).checks.find((c) => c.id === 'subject_size')!.status, 'pass');
  });
});
