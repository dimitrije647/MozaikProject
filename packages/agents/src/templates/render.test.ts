import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { makePng } from '../testing/fixtures';
import { button, canvas, circle, defineTemplate, ellipse, fill, grad, img, line, logo, patch, pattern, poly, rect, scrim, text } from './dsl';
import { EDITORIAL_BRAND } from './library/editorial-brand';
import { HOSPITALITY } from './library/hospitality';
import { TECH_SAAS } from './library/tech-saas';
import { PREVIEW_PALETTE, placeholderImage } from './preview';
import { renderTemplate, safeAreaFor } from './render';
import { FORMAT_CLASSES, type CreativeContent, type FormatClass, type TemplateDef, type TemplateRenderInput } from './schema';
import { tokenize, xmlEscape } from './text-fit';

// ---- helpers ---------------------------------------------------------------------------------------------------------------------------

const SIZES: Record<FormatClass, [number, number]> = { square: [540, 540], portrait: [540, 675], story: [540, 960], landscape: [600, 314], banner: [600, 150] };

function tpl(over: Partial<TemplateDef> & { layers: TemplateDef['layers'] }): TemplateDef {
  return {
    id: 'test_template',
    name: 'Test template',
    version: 1,
    status: 'draft',
    category: 'tech_saas',
    description: 'A template made for the unit tests.',
    styles: ['minimalist_tech'],
    industries: ['*'],
    channels: [],
    classes: ['square'],
    requires: [],
    density: 'balanced',
    family: 'centered',
    composition: 'A test composition used by the unit tests.',
    sample: { headline: 'Sample headline' },
    tone: 'light',
    ...over,
  };
}

const input = (template: TemplateDef, over: Partial<TemplateRenderInput> = {}): TemplateRenderInput => ({
  template,
  width: 540,
  height: 540,
  content: { headline: 'Hello world' },
  palette: PREVIEW_PALETTE,
  brandName: 'Acme',
  ...over,
});

interface Px {
  data: Buffer;
  w: number;
  h: number;
}

async function decode(png: Buffer): Promise<Px> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

function near(px: Px, i: number, c: [number, number, number], tol: number) {
  return Math.abs(px.data[i * 3] - c[0]) <= tol && Math.abs(px.data[i * 3 + 1] - c[1]) <= tol && Math.abs(px.data[i * 3 + 2] - c[2]) <= tol;
}

function countNear(px: Px, hex: string, tol = 20): number {
  const c = rgb(hex);
  let n = 0;
  for (let i = 0; i < px.w * px.h; i++) if (near(px, i, c, tol)) n++;
  return n;
}

/** Bounding box of every pixel that differs from the background color. */
function inkBounds(px: Px, bgHex: string, tol = 40): { l: number; t: number; r: number; b: number } | null {
  const bg = rgb(bgHex);
  let l = px.w;
  let t = px.h;
  let r = -1;
  let b = -1;
  for (let y = 0; y < px.h; y++) {
    for (let x = 0; x < px.w; x++) {
      if (!near(px, y * px.w + x, bg, tol)) {
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        if (y > b) b = y;
      }
    }
  }
  return r < 0 ? null : { l, t, r: r + 1, b: b + 1 };
}

async function renderOk(inp: TemplateRenderInput) {
  const r = await renderTemplate(inp);
  assert.ok(r.ok, r.ok ? '' : `${r.reason}: ${r.message}`);
  if (!r.ok) throw new Error('unreachable');
  return r;
}

/** A white page with one black text layer in a box that lies inside every safe area. */
const textBox = (over: Partial<Parameters<typeof text>[3]> = {}, box: [number, number, number, number] = [0.12, 0.3, 0.76, 0.34]) =>
  tpl({
    layers: [fill('bg', '#ffffff'), text('headline', 'headline', box, { size: [0.1, 0.03], lines: 5, color: '#000000', weight: 700, ...over })],
  });

function assertInside(b: { l: number; t: number; r: number; b: number } | null, box: [number, number, number, number], w: number, h: number, tol: number, label: string) {
  assert.ok(b, `${label}: something was drawn`);
  if (!b) return;
  assert.ok(b.l >= box[0] * w - tol && b.r <= (box[0] + box[2]) * w + tol, `${label}: horizontally inside the box (${b.l}..${b.r} vs ${box[0] * w}..${(box[0] + box[2]) * w})`);
  assert.ok(b.t >= box[1] * h - tol && b.b <= (box[1] + box[3]) * h + tol, `${label}: vertically inside the box (${b.t}..${b.b} vs ${box[1] * h}..${(box[1] + box[3]) * h})`);
}

// ---- reference templates ---------------------------------------------------------------------------------------------------------------

const REFERENCES: TemplateDef[] = [...TECH_SAAS, ...HOSPITALITY, ...EDITORIAL_BRAND].filter((t) => ['tech_product_launch', 'hospitality_restaurant_promo', 'editorial_minimal'].includes(t.id));

describe('renderTemplate: reference templates', () => {
  it('has the three reference templates', () => {
    assert.deepEqual(REFERENCES.map((t) => t.id).sort(), ['editorial_minimal', 'hospitality_restaurant_promo', 'tech_product_launch']);
    for (const t of REFERENCES) assert.ok(t.classes.length >= 2 && t.classes.length <= 4, t.id);
  });

  it('outputs a valid sRGB PNG of EXACT dimensions for every class a template declares, with its own sample and no warnings', async () => {
    for (const t of REFERENCES) {
      for (const cls of t.classes) {
        const [w, h] = [SIZES[cls][0] * 2, SIZES[cls][1] * 2];
        const hero = await placeholderImage(w, h, PREVIEW_PALETTE, t.id);
        const r = await renderOk({ ...input(t, { width: w, height: h, content: t.sample as CreativeContent, brandName: t.sample.brand ?? 'Acme', images: { hero } }) });
        const meta = await sharp(r.png).metadata();
        assert.deepEqual([meta.format, meta.width, meta.height, meta.space, meta.hasAlpha], ['png', w, h, 'srgb', false], `${t.id} ${cls}`);
        assert.deepEqual([r.width, r.height], [w, h]);
        assert.deepEqual(r.flags.filter((f) => f !== 'logo_missing_name_used'), [], `${t.id} ${cls} renders its sample without warnings`);
        assert.ok(r.drawn.includes('headline'));
        assert.ok(r.layers.length >= 4, `${t.id} ${cls}`);
      }
    }
  });

  it('refuses a class the template was not designed for instead of stretching it', async () => {
    for (const t of REFERENCES) {
      const missing = FORMAT_CLASSES.filter((c) => !t.classes.includes(c));
      assert.ok(missing.length > 0, `${t.id} declares fewer than all five classes`);
      for (const cls of missing) {
        const [w, h] = SIZES[cls];
        const r = await renderTemplate(input(t, { width: w, height: h, content: t.sample as CreativeContent, images: { hero: await makePng(1200, 1200, '#336699') } }));
        assert.equal(r.ok, false, `${t.id} ${cls}`);
        if (!r.ok) assert.equal(r.reason, 'unsupported_format');
      }
    }
  });

  it('puts the brand primary color on the canvas (hospitality panel) and follows a different brand', async () => {
    const t = HOSPITALITY[0];
    const hero = await placeholderImage(540, 540, PREVIEW_PALETTE, 'x');
    for (const primary of ['#3157d5', '#c2410c']) {
      const r = await renderOk(input(t, { content: t.sample as CreativeContent, palette: [primary, '#fde68a'], images: { hero } }));
      const px = await decode(r.png);
      const share = countNear(px, primary, 10) / (px.w * px.h);
      assert.ok(share > 0.25, `${primary} covers ${(share * 100).toFixed(0)}% of the canvas`);
    }
  });

  it('survives an 85+ character headline, a very long word and a long support line in every class', async () => {
    const longHeadline = 'Our new platform helps small teams plan, build, ship and measure every single campaign in one calm place';
    assert.ok(longHeadline.length > 85);
    for (const t of REFERENCES) {
      for (const cls of t.classes) {
        const [w, h] = SIZES[cls];
        const hero = await placeholderImage(w * 2, h * 2, PREVIEW_PALETTE, t.id);
        for (const headline of [longHeadline, 'Pneumonoultramicroscopicsilicovolcanoconiosis everywhere']) {
          const r = await renderOk(input(t, { width: w * 2, height: h * 2, content: { ...(t.sample as CreativeContent), headline, support: `${longHeadline}. ${longHeadline}.` }, images: { hero } }));
          assert.ok(r.drawn.includes('headline'));
          assert.ok(!r.flags.some((f) => f.startsWith('moved_into_safe_area')), `${t.id} ${cls}: ${r.flags.join(',')}`);
        }
      }
    }
  });
});

// ---- contract: refusals ----------------------------------------------------------------------------------------------------------------

describe('renderTemplate: refusals and robustness', () => {
  const simple = textBox();

  it('refuses a size whose class is not declared (no stretching, no letterboxing)', async () => {
    for (const cls of FORMAT_CLASSES.filter((c) => c !== 'square')) {
      const [w, h] = SIZES[cls];
      const r = await renderTemplate(input(simple, { width: w, height: h }));
      assert.equal(r.ok, false, cls);
      if (!r.ok) {
        assert.equal(r.reason, 'unsupported_format');
        assert.match(r.message, /square/);
      }
    }
    assert.equal((await renderTemplate(input(simple))).ok, true);
  });

  it('refuses invalid sizes without throwing', async () => {
    for (const [w, h] of [[0, 0], [10, 10], [540.5, 540], [Number.NaN, 540], [9000, 9000], [-540, 540]]) {
      const r = await renderTemplate(input(simple, { width: w, height: h }));
      assert.equal(r.ok, false, `${w}x${h}`);
      if (!r.ok) assert.equal(r.reason, 'unsupported_format');
    }
  });

  it('refuses when required content or assets are missing, accepts when present', async () => {
    const quote = tpl({
      requires: ['quote', 'logo', 'image'],
      layers: [fill('bg', 'paper'), img('photo', 'hero', [0, 0, 1, 0.5]), logo('logo', [0.1, 0.55, 0.3, 0.08]), text('headline', 'headline', [0.1, 0.65, 0.8, 0.12], { size: 0.06 }), text('quote', 'quote', [0.1, 0.78, 0.8, 0.12], { size: 0.04 })],
    });
    const hero = await makePng(600, 600, '#336699');
    const mark = await makePng(200, 80, '#ff0000');
    const base = { content: { headline: 'H', quote: 'Q' } as CreativeContent, images: { hero }, logo: mark };
    assert.equal((await renderTemplate(input(quote, base))).ok, true);
    for (const [label, over] of [
      ['quote', { content: { headline: 'H' } as CreativeContent }],
      ['quote (blank)', { content: { headline: 'H', quote: '   ' } as CreativeContent }],
      ['logo', { logo: null }],
      ['image', { images: {} }],
      ['headline', { content: { headline: ' ', quote: 'Q' } as CreativeContent }],
    ] as const) {
      const r = await renderTemplate(input(quote, { ...base, ...over }));
      assert.equal(r.ok, false, label);
      if (!r.ok) assert.equal(r.reason, 'missing_required', label);
    }
  });

  it('omits optional text layers without content (and lists only what was drawn)', async () => {
    const t = tpl({
      layers: [
        fill('bg', '#ffffff'),
        text('headline', 'headline', [0.1, 0.2, 0.8, 0.15], { size: 0.07, color: '#000000' }),
        text('eyebrow', 'eyebrow', [0.1, 0.1, 0.8, 0.05], { size: 0.03, color: '#000000' }),
        text('support', 'support', [0.1, 0.4, 0.8, 0.1], { size: 0.04, color: '#000000' }),
        button('cta', [0.1, 0.6, 0.4, 0.1]),
      ],
    });
    const a = await renderOk(input(t, { content: { headline: 'Only a headline' } }));
    assert.deepEqual(a.drawn, ['headline']);
    assert.deepEqual(a.layers, ['bg', 'headline']);
    const b = await renderOk(input(t, { content: { headline: 'All of it', support: 'Support copy', eyebrow: 'Eyebrow', cta: 'Go' } }));
    assert.deepEqual([...b.drawn].sort(), ['cta', 'eyebrow', 'headline', 'support']);
    assert.deepEqual(b.layers, ['bg', 'headline', 'eyebrow', 'support', 'cta']);
  });

  it('never throws on malformed input', async () => {
    const garbage: unknown[] = [
      { template: {}, width: 540, height: 540, content: { headline: 'x' }, palette: [], brandName: 'x' },
      { template: null, width: 540, height: 540, content: { headline: 'x' }, palette: [], brandName: 'x' },
      input(simple, { content: null as never }),
      input(simple, { palette: undefined as never }),
      input(simple, { palette: [null, 5, {}] as never }),
      input(simple, { brandName: undefined as never }),
      input(simple, { images: { hero: 'string' as never } }),
      input(simple, { heroFocus: [Number.NaN, 2] }),
      undefined,
    ];
    for (const g of garbage) {
      const r = await renderTemplate(g as TemplateRenderInput);
      assert.ok(typeof r.ok === 'boolean');
      if (!r.ok) assert.ok(['render_failed', 'unsupported_format', 'missing_required', 'image_unreadable'].includes(r.reason));
    }
    const bad = await renderTemplate({ template: {}, width: 540, height: 540, content: { headline: 'x' }, palette: [], brandName: 'x' } as unknown as TemplateRenderInput);
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.reason, 'render_failed');
  });

  it('copes with degenerate boxes and sizes', async () => {
    const t = tpl({
      layers: [
        fill('bg', '#ffffff'),
        text('headline', 'headline', [0.2, 0.2, 0, 0], { size: 0.1, color: '#000000' }),
        text('support', 'support', [0.2, 0.4, 0.001, 0.4], { size: 0.1, color: '#000000' }),
        img('photo', 'hero', [0.5, 0.5, 0, 0]),
        button('cta', [0.1, 0.6, 0, 0]),
        logo('logo', [0.1, 0.8, 0, 0]),
        rect('r', [0.1, 0.1, 0, 0], { fill: 'primary' }),
      ],
    });
    const r = await renderTemplate(input(t, { content: { headline: 'Zero', support: 'Thin', cta: 'Go' }, images: { hero: await makePng(100, 100, '#123456') }, logo: await makePng(50, 50, '#654321') }));
    assert.ok(typeof r.ok === 'boolean');
  });

  it('does not modify the template it is given', async () => {
    const t = textBox();
    const before = JSON.stringify(t);
    await renderOk(input(t));
    assert.equal(JSON.stringify(t), before);
  });
});

// ---- images and logos ------------------------------------------------------------------------------------------------------------------

describe('renderTemplate: images', () => {
  const photoOnly = (over: Partial<Parameters<typeof img>[3]> = {}, requires: TemplateDef['requires'] = []) =>
    tpl({ requires, layers: [fill('bg', '#ffffff'), img('photo', 'hero', [0, 0, 1, 1], over), text('headline', 'headline', [0.1, 0.8, 0.8, 0.1], { size: 0.05, color: '#000000' })] });

  it('draws the hero picture, cover-cropped, and never modifies the input buffer', async () => {
    const hero = await makePng(900, 900, '#00ff00');
    const copy = Buffer.from(hero);
    const r = await renderOk(input(photoOnly({}, ['image']), { images: { hero } }));
    assert.ok(hero.equals(copy), 'input buffer untouched');
    const px = await decode(r.png);
    assert.ok(countNear(px, '#00ff00', 12) / (px.w * px.h) > 0.9);
    assert.ok(!r.flags.includes('hero_missing_fallback'));
    assert.ok(!r.flags.some((f) => f.startsWith('image_low_resolution')));
  });

  it('flags a picture that has to be enlarged too much, but still renders it', async () => {
    const r = await renderOk(input(photoOnly(), { images: { hero: await makePng(200, 200, '#00ff00') } }));
    assert.ok(r.flags.includes('image_low_resolution:hero'), r.flags.join(','));
    const px = await decode(r.png);
    assert.ok(countNear(px, '#00ff00', 12) / (px.w * px.h) > 0.9);
  });

  it('uses the fallback and says so when the hero is missing and the template does not require it', async () => {
    for (const fb of ['gradient', 'brandPattern'] as const) {
      const r = await renderOk(input(photoOnly({ fallback: fb }), { palette: ['#c2410c', '#fde68a'] }));
      assert.ok(r.flags.includes('hero_missing_fallback'));
      const px = await decode(r.png);
      assert.ok(countNear(px, '#c2410c', 60) / (px.w * px.h) > 0.3, `${fb}: brand-colored fallback`);
    }
    const none = await renderOk(input(photoOnly({ fallback: 'none' })));
    assert.ok(none.flags.includes('hero_missing_fallback'));
    assert.ok(!none.layers.includes('photo'));
  });

  it('crops around the focus point (heroFocus beats the layer focus)', async () => {
    const left = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#0000ff' } }).composite([{ input: await makePng(200, 200, '#ff0000'), left: 0, top: 0 }]).png().toBuffer();
    const t = tpl({ layers: [fill('bg', '#ffffff'), img('photo', 'hero', [0.25, 0.25, 0.5, 0.5], { focus: [1, 0.5] }), text('headline', 'headline', [0.1, 0.85, 0.8, 0.08], { size: 0.04, color: '#000000' })] });
    const center = (px: Px) => {
      const i = (270 * px.w + 270) * 3;
      return [px.data[i], px.data[i + 1], px.data[i + 2]];
    };
    const blue = await decode((await renderOk(input(t, { images: { hero: left } }))).png);
    assert.deepEqual(center(blue), [0, 0, 255], 'layer focus on the right side shows the blue half');
    const red = await decode((await renderOk(input(t, { images: { hero: left }, heroFocus: [0, 0.5] }))).png);
    assert.deepEqual(center(red), [255, 0, 0], 'heroFocus on the left shows the red half');
  });

  it('rejects svg, pdf, garbage, empty and oversized buffers as image_unreadable (never throws)', async () => {
    const t = photoOnly();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/><script>alert(1)</script></svg>');
    const bad: [string, Buffer][] = [
      ['svg', svg],
      ['svg with xml header', Buffer.from(`<?xml version="1.0"?>${svg.toString()}`)],
      ['pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF')],
      ['garbage', Buffer.from('this is not an image at all, just text'.repeat(20))],
      ['random bytes', Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 131 + 17) % 251))],
      ['empty', Buffer.alloc(0)],
      ['truncated png', (await makePng(300, 300, '#112233')).subarray(0, 60)],
      ['larger than 25 MB', Buffer.alloc(26 * 1024 * 1024)],
    ];
    for (const [label, buf] of bad) {
      for (const slot of ['hero', 'secondary'] as const) {
        const r = await renderTemplate(input(t, { images: { [slot]: buf } }));
        assert.equal(r.ok, false, `${label} as ${slot}`);
        if (!r.ok) assert.equal(r.reason, 'image_unreadable', label);
      }
      const asLogo = await renderTemplate(input(t, { logo: buf }));
      assert.equal(asLogo.ok, false, `${label} as logo`);
      if (!asLogo.ok) assert.equal(asLogo.reason, 'image_unreadable');
    }
  });

  it('rejects a picture above the 50 megapixel decode cap', async () => {
    const huge = await sharp({ create: { width: 8200, height: 6400, channels: 3, background: '#808080' } }).png({ compressionLevel: 9 }).toBuffer();
    assert.ok(huge.length < 25 * 1024 * 1024);
    const r = await renderTemplate(input(photoOnly(), { images: { hero: huge } }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'image_unreadable');
  });

  it('accepts every raster format sharp can write', async () => {
    const base = sharp({ create: { width: 300, height: 300, channels: 3, background: '#2255aa' } });
    const formats: [string, Buffer][] = [
      ['png', await base.clone().png().toBuffer()],
      ['jpeg', await base.clone().jpeg().toBuffer()],
      ['webp', await base.clone().webp().toBuffer()],
      ['gif', await base.clone().gif().toBuffer()],
      ['tiff', await base.clone().tiff().toBuffer()],
    ];
    try {
      formats.push(['avif', await base.clone().avif({ effort: 0 }).toBuffer()]);
    } catch {
      /* avif encoder not available on this build */
    }
    for (const [label, hero] of formats) {
      const r = await renderTemplate(input(photoOnly(), { images: { hero } }));
      assert.equal(r.ok, true, label);
    }
  });

  it('handles grayscale, 16-bit, palette, alpha and CMYK pictures, EXIF rotation and plain Uint8Array input', async () => {
    const solid = (bg: string | { r: number; g: number; b: number; alpha: number }, channels: 3 | 4 = 3) => sharp({ create: { width: 400, height: 400, channels, background: bg } });
    const center = (px: Px) => {
      const i = (270 * px.w + 270) * 3;
      return [px.data[i], px.data[i + 1], px.data[i + 2]];
    };
    const cases: [string, Buffer, [number, number, number]][] = [
      ['grayscale', await solid('#808080').grayscale().png().toBuffer(), [128, 128, 128]],
      ['16-bit', await solid('#ff0000').toColourspace('rgb16').png().toBuffer(), [255, 0, 0]],
      ['palette png', await solid('#00ff00').png({ palette: true, colours: 8 }).toBuffer(), [0, 255, 0]],
      ['alpha png (flattened on the page)', await solid({ r: 0, g: 0, b: 255, alpha: 1 }, 4).png().toBuffer(), [0, 0, 255]],
      ['cmyk jpeg', await solid('#ff0000').toColourspace('cmyk').jpeg().toBuffer(), [255, 0, 0]],
    ];
    for (const [label, hero, want] of cases) {
      const px = await decode((await renderOk(input(photoOnly(), { images: { hero } }))).png);
      const got = center(px);
      assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= 40), `${label}: ${got} vs ${want}`);
    }
    const asBytes = new Uint8Array(await makePng(300, 300, '#00ff00'));
    const u8 = await renderOk(input(photoOnly(), { images: { hero: asBytes as unknown as Buffer } }));
    assert.ok(countNear(await decode(u8.png), '#00ff00', 12) > 100000);
    // top half red / bottom half blue, stored with EXIF orientation 6 (to be shown rotated clockwise): red ends up on the RIGHT
    const stored = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#0000ff' } }).composite([{ input: await makePng(400, 100, '#ff0000'), left: 0, top: 0 }]).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer();
    const rotated = await decode((await renderOk(input(photoOnly(), { images: { hero: stored } }))).png);
    const at = (x: number, y: number) => {
      const i = (y * rotated.w + x) * 3;
      return [rotated.data[i], rotated.data[i + 1], rotated.data[i + 2]];
    };
    assert.ok(at(100, 270)[2] > 200 && at(100, 270)[0] < 60, 'left side is blue');
    assert.ok(at(440, 270)[0] > 200 && at(440, 270)[2] < 60, 'right side is red');
  });

  it('applies masks, treatments, border, shadow, rotation and opacity to pictures', async () => {
    const hero = await makePng(900, 900, '#cc5533');
    const masks = ['none', 'circle', 'rounded', 'arch', 'cut-left', 'cut-right'] as const;
    for (const mask of masks) {
      const t = tpl({
        layers: [
          fill('bg', '#ffffff'),
          img('photo', 'hero', [0.1, 0.1, 0.8, 0.6], { mask, radius: 0.1, border: { color: '#000000', width: 0.01 }, shadow: true, scrim: scrim(90, 'ink', 0, 'ink', 0.5), tint: { color: 'primary', opacity: 0.2 }, saturation: 0.5, rotate: mask === 'circle' ? 10 : undefined, opacity: 0.9 }),
          text('headline', 'headline', [0.1, 0.8, 0.8, 0.1], { size: 0.05, color: '#000000' }),
        ],
      });
      const r = await renderOk(input(t, { images: { hero } }));
      const px = await decode(r.png);
      const b = inkBounds(px, '#ffffff');
      assert.ok(b && b.r - b.l > 100, mask);
    }
  });

  it('duotone maps the picture between the two colors', async () => {
    const hero = await makePng(600, 600, '#ffffff');
    const t = tpl({ layers: [fill('bg', '#000000'), img('photo', 'hero', [0, 0, 1, 1], { duotone: { shadow: '#000000', light: '#ff8800' } }), text('headline', 'headline', [0.1, 0.8, 0.8, 0.1], { size: 0.05, color: '#ffffff' })] });
    const px = await decode((await renderOk(input(t, { images: { hero } }))).png);
    assert.ok(countNear(px, '#ff8800', 12) / (px.w * px.h) > 0.9);
  });
});

describe('renderTemplate: logo', () => {
  const logoTpl = (align: 'left' | 'center' | 'right' = 'left', plate = false) =>
    tpl({ layers: [fill('bg', '#ffffff'), logo('logo', [0.1, 0.1, 0.3, 0.15], { align, valign: 'top', nameColor: '#000000', plate: plate ? { fill: '#ffee00', padding: 0.02, radius: 0.2 } : undefined }), text('headline', 'headline', [0.1, 0.7, 0.8, 0.1], { size: 0.05, color: '#000000' })] });

  it('places the logo inside its box, contained and never stretched', async () => {
    const mark = await makePng(400, 400, '#ff00ff'); // square logo in a 162x81 box -> a 81x81 square at the left edge
    const px = await decode((await renderOk(input(logoTpl('left'), { logo: mark }))).png);
    const mag = (() => {
      let l = px.w, t = px.h, r = -1, bb = -1;
      const c = rgb('#ff00ff');
      for (let y = 0; y < px.h; y++) for (let x = 0; x < px.w; x++) if (near(px, y * px.w + x, c, 10)) ((l = Math.min(l, x)), (r = Math.max(r, x)), (t = Math.min(t, y)), (bb = Math.max(bb, y)));
      return { l, t, r: r + 1, b: bb + 1 };
    })();
    assert.ok(Math.abs(mag.l - 54) <= 2 && Math.abs(mag.t - 54) <= 2, `top-left of the logo (${mag.l},${mag.t})`);
    assert.ok(Math.abs(mag.r - mag.l - (mag.b - mag.t)) <= 2, 'aspect ratio kept (square stays square)');
    assert.ok(mag.r <= 54 + 162 + 1 && mag.b <= 54 + 81 + 1, 'inside the box');
    const centered = await decode((await renderOk(input(logoTpl('center'), { logo: mark }))).png);
    const c = rgb('#ff00ff');
    let minX = centered.w;
    let maxX = -1;
    for (let y = 0; y < centered.h; y++) for (let x = 0; x < centered.w; x++) if (near(centered, y * centered.w + x, c, 10)) ((minX = Math.min(minX, x)), (maxX = Math.max(maxX, x)));
    assert.ok(Math.abs((minX + maxX + 1) / 2 - 135) <= 2, 'centered in the box (x center 135)');
  });

  it('crops transparent margins of a logo and keeps its colors', async () => {
    const padded = await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: await makePng(100, 100, '#00aa00'), left: 150, top: 50 }]).png().toBuffer();
    const px = await decode((await renderOk(input(logoTpl('left'), { logo: padded }))).png);
    assert.ok(countNear(px, '#00aa00', 10) > 3000, 'the visible mark fills the box height');
  });

  it('draws a plate behind the logo when asked', async () => {
    const mark = await makePng(400, 200, '#222222');
    const px = await decode((await renderOk(input(logoTpl('left', true), { logo: mark }))).png);
    assert.ok(countNear(px, '#ffee00', 10) > 500, 'plate color present');
    assert.ok(countNear(px, '#222222', 10) > 500, 'logo on top of it');
  });

  it('applies opacity and rotation to the whole logo mark (plate included)', async () => {
    const t = tpl({ layers: [fill('bg', '#ffffff'), logo('logo', [0.1, 0.1, 0.4, 0.2], { align: 'left', valign: 'top', opacity: 0.5, rotate: 10, plate: { fill: '#ffee00', padding: 0.01, radius: 0.1 } }), text('headline', 'headline', [0.1, 0.7, 0.8, 0.1], { size: 0.05, color: '#000000' })] });
    const r = await renderOk(input(t, { logo: await makePng(400, 200, '#ff00ff') }));
    const px = await decode(r.png);
    let magentaish = 0;
    for (let i = 0; i < px.w * px.h; i++) if (near(px, i, [255, 128, 255], 14)) magentaish++;
    assert.ok(magentaish > 1500, `half-transparent magenta over white (${magentaish})`);
    assert.equal(countNear(px, '#ff00ff', 6), 0, 'no fully opaque magenta');
  });

  it('draws the brand NAME in the logo box when there is no logo, and says so', async () => {
    const r = await renderOk(input(logoTpl('left'), { brandName: 'Acme Studio' }));
    assert.ok(r.flags.includes('logo_missing_name_used'));
    assert.ok(r.layers.includes('logo'));
    const px = await decode(r.png);
    const region = { l: 54, t: 54, r: 54 + 162, b: 54 + 81 };
    // the name is the only ink above the headline
    let ink = 0;
    for (let y = 0; y < 300; y++) for (let x = 0; x < px.w; x++) if (!near(px, y * px.w + x, rgb('#ffffff'), 40)) ink++;
    assert.ok(ink > 200, 'name drawn');
    let outside = 0;
    for (let y = 0; y < 300; y++) for (let x = 0; x < px.w; x++) if (!near(px, y * px.w + x, rgb('#ffffff'), 40) && (x < region.l - 3 || x > region.r + 3 || y < region.t - 3 || y > region.b + 3)) outside++;
    assert.equal(outside, 0, 'the name stays inside the logo box');
    const none = await renderOk(input(logoTpl('left'), { brandName: '   ' }));
    assert.ok(none.flags.includes('logo_missing_no_name'));
    assert.ok(!none.layers.includes('logo'));
  });
});

// ---- text ------------------------------------------------------------------------------------------------------------------------------

describe('renderTemplate: text fitting', () => {
  const BOX: [number, number, number, number] = [0.12, 0.3, 0.76, 0.34];
  const cases: [string, string][] = [
    ['short headline', 'Hello'],
    ['long headline (92 chars)', 'Our new platform helps small teams plan, build, ship and measure every campaign in one place'],
    ['one very long word', 'Pneumonoultramicroscopicsilicovolcanoconiosis'],
    ['long word between words', 'Please read Donaudampfschifffahrtsgesellschaftskapitän today'],
    ['Cyrillic', 'Ово је веома дугачак наслов на ћирилици који мора да стане у оквир без прелива'],
    ['Latin extended', 'Žarko čuva šećer, ćevapčiće i đurđevak u Łódźu pod Ångström-skim svetlom'],
    ['CJK', '这是一个非常长的标题用来测试文字是否会正确换行并且不会溢出画布边界的情况下仍然保持可读性和美观'],
    ['Japanese + Latin', '新製品の発売記念キャンペーン Launch Week で全品20%オフ、今すぐお申し込みください'],
    ['Arabic (RTL)', 'هذا عنوان طويل جدا لاختبار الالتفاف التلقائي للنص العربي داخل الإطار المحدد'],
    ['Hebrew (RTL)', 'זוהי כותרת ארוכה מאוד שנועדה לבדוק את גלישת הטקסט בתוך המסגרת'],
    ['no spaces at all', 'a'.repeat(120)],
    ['emoji and symbols', 'Sale ★★★ 50% off → today only ✓'],
  ];

  for (const [label, headline] of cases) {
    it(`fits "${label}" inside its box without overflow or errors`, async () => {
      const r = await renderOk(input(textBox({}, BOX), { content: { headline } }));
      const b = inkBounds(await decode(r.png), '#ffffff');
      assertInside(b, BOX, 540, 540, 8, label);
      assert.deepEqual(r.drawn, ['headline']);
    });
  }

  it('shrinks long text and says so; does not shrink short text', async () => {
    const short = await renderOk(input(textBox(), { content: { headline: 'Hello' } }));
    assert.ok(!short.flags.some((f) => f.startsWith('text_shrunk')));
    const long = await renderOk(input(textBox(), { content: { headline: cases[1][1] } }));
    assert.ok(long.flags.includes('text_shrunk:headline'), long.flags.join(','));
  });

  it('trims with an ellipsis and flags it when even the minimum size cannot hold the text', async () => {
    const t = textBox({ size: [0.05, 0.045], lines: 2 }, [0.12, 0.3, 0.5, 0.12]);
    const r = await renderOk(input(t, { content: { headline: cases[1][1] + ', then do it all over again every single week of the year' } }));
    assert.ok(r.flags.includes('text_trimmed:headline'), r.flags.join(','));
    assertInside(inkBounds(await decode(r.png), '#ffffff'), [0.12, 0.3, 0.5, 0.12], 540, 540, 8, 'trimmed');
  });

  it('honours alignment, valign, upper case and maxLines', async () => {
    const left = inkBounds(await decode((await renderOk(input(textBox({ align: 'left' }), { content: { headline: 'Aligned' } }))).png), '#ffffff');
    const right = inkBounds(await decode((await renderOk(input(textBox({ align: 'right' }), { content: { headline: 'Aligned' } }))).png), '#ffffff');
    const center = inkBounds(await decode((await renderOk(input(textBox({ align: 'center' }), { content: { headline: 'Aligned' } }))).png), '#ffffff');
    assert.ok(left && right && center);
    assert.ok(left.l < center.l && center.l < right.l);
    assert.ok(Math.abs((center.l + center.r) / 2 - 270) <= 6);
    const top = inkBounds(await decode((await renderOk(input(textBox({ valign: 'top' }), { content: { headline: 'Aligned' } }))).png), '#ffffff');
    const bottom = inkBounds(await decode((await renderOk(input(textBox({ valign: 'bottom' }), { content: { headline: 'Aligned' } }))).png), '#ffffff');
    assert.ok(top && bottom && top.t < bottom.t);
    const lower = await decode((await renderOk(input(textBox({ upper: true, color: '#000000' }), { content: { headline: 'ab' } }))).png);
    const lowerB = inkBounds(lower, '#ffffff');
    assert.ok(lowerB && lowerB.b - lowerB.t > 20, 'upper-case letters are taller than x-height letters');
    const capped = await renderOk(input(textBox({ lines: 1, size: [0.06, 0.03] }), { content: { headline: 'one two three four five six seven eight nine ten eleven twelve' } }));
    const cb = inkBounds(await decode(capped.png), '#ffffff');
    assert.ok(cb && cb.b - cb.t < 60, 'a single line');
  });

  it('draws right-to-left text starting at the right when the layer is left-aligned', async () => {
    const b = inkBounds(await decode((await renderOk(input(textBox({ align: 'left' }), { content: { headline: 'مرحبا بكم' } }))).png), '#ffffff');
    assert.ok(b);
    assert.ok(b.r > 400, `anchored to the right edge of the box (${b.l}..${b.r})`);
  });

  it('bounds very long copy (cut with an ellipsis, flagged) so rendering stays fast', async () => {
    const t0 = Date.now();
    const r = await renderOk(input(textBox({ lines: 8 }), { content: { headline: 'word '.repeat(5000) + 'end' } }));
    assert.ok(r.flags.includes('text_trimmed:headline'), r.flags.join(','));
    assertInside(inkBounds(await decode(r.png), '#ffffff'), BOX, 540, 540, 8, 'huge copy');
    assert.ok(Date.now() - t0 < 5000);
  });

  it('keeps XML injection harmless and renders the characters as text', async () => {
    const evil = `</text><script>alert(1)</script><image href="http://evil.example/x.png"/> & < > " ' ]]>`;
    const t = tpl({ layers: [fill('bg', '#ffffff'), logo('logo', [0.1, 0.05, 0.3, 0.06], { nameColor: '#000000' }), text('headline', 'headline', [0.1, 0.3, 0.8, 0.3], { size: [0.06, 0.03], color: '#000000', lines: 4 })] });
    const r = await renderOk(input(t, { content: { headline: evil }, brandName: evil }));
    assert.deepEqual(r.drawn, ['headline']);
    assertInside(inkBounds(await decode(r.png), '#ffffff'), [0.1, 0.05, 0.8, 0.55], 540, 540, 6, 'injection');
    assert.equal(xmlEscape(evil).includes('<'), false);
    assert.equal(xmlEscape('a\u0000b\u0008c\ud800d'), 'abcd', 'characters XML cannot hold are dropped');
    const ctl = await renderOk(input(textBox(), { content: { headline: 'Control\u0000\u0001\u0008 chars\u000b￾ here' } }));
    assert.ok(ctl.drawn.includes('headline'));
  });

  it('tokenizes CJK per character and Latin per word', () => {
    assert.deepEqual(tokenize('新製品 Launch week').map((t) => t.t), ['新', '製', '品', 'Launch', 'week']);
    assert.deepEqual(tokenize('Hello世界').map((t) => [t.t, t.sp]), [['Hello', false], ['世', false], ['界', false]]);
    assert.deepEqual(tokenize('  a   b  ').map((t) => t.t), ['a', 'b']);
  });
});

// ---- safe area, contrast, determinism --------------------------------------------------------------------------------------------------

describe('renderTemplate: safe area', () => {
  it('uses the CREATIVE_FORMATS margins for known sizes and 6% otherwise', () => {
    const sq = safeAreaFor(1080, 1080);
    assert.deepEqual([sq.l, sq.r, sq.t, sq.b].map(Math.round), [86, 994, 76, 1004]);
    const story = safeAreaFor(1080, 1920);
    assert.deepEqual([story.t, story.b].map(Math.round), [269, 1651]);
    const odd = safeAreaFor(1000, 700);
    assert.deepEqual([odd.l, odd.t, odd.r, odd.b].map(Math.round), [60, 42, 940, 658]);
    const scaledStory = safeAreaFor(540, 960);
    assert.equal(Math.round(scaledStory.t), 134, 'the same ratio as a known format uses its margins');
  });

  for (const cls of ['square', 'story', 'landscape', 'banner'] as const) {
    it(`clamps text, button and logo into the safe area (${cls}) and flags it`, async () => {
      const [w, h] = SIZES[cls];
      const t = tpl({
        classes: [cls],
        layers: [
          fill('bg', '#ffffff'),
          text('headline', 'headline', [-0.05, -0.05, 0.5, 0.2], { size: 0.1, color: '#000000', lines: 2 }),
          text('support', 'support', [0.6, 0.9, 0.5, 0.2], { size: 0.08, color: '#000000', lines: 2 }),
          button('cta', [0.7, 0.82, 0.4, 0.2], { fill: '#000000', color: '#ffffff' }),
          logo('logo', [-0.1, 0.4, 0.3, 0.1], { nameColor: '#000000' }),
        ],
      });
      const r = await renderOk(input(t, { width: w, height: h, content: { headline: 'Moved', support: 'Support copy here', cta: 'Go' } }));
      for (const id of ['headline', 'support', 'cta', 'logo']) assert.ok(r.flags.includes(`moved_into_safe_area:${id}`), `${id}: ${r.flags.join(',')}`);
      const safe = safeAreaFor(w, h);
      const b = inkBounds(await decode(r.png), '#ffffff');
      assert.ok(b);
      assert.ok(b.l >= safe.l - 3 && b.t >= safe.t - 3 && b.r <= safe.r + 3 && b.b <= safe.b + 3, `ink ${JSON.stringify(b)} inside ${JSON.stringify(safe)}`);
    });
  }

  it('lets decoration and pictures bleed past the safe area', async () => {
    const t = tpl({ layers: [fill('bg', '#ffffff'), rect('bar', [-0.1, -0.1, 1.2, 0.2], { fill: '#ff0000' }), img('photo', 'hero', [0, 0.9, 1, 0.2]), text('headline', 'headline', [0.1, 0.4, 0.8, 0.1], { size: 0.05, color: '#000000' })] });
    const r = await renderOk(input(t, { images: { hero: await makePng(600, 200, '#0000ff') } }));
    assert.deepEqual(r.flags.filter((f) => f.startsWith('moved')), []);
    const px = await decode(r.png);
    assert.deepEqual([px.data[0], px.data[1], px.data[2]], [255, 0, 0], 'bleeds to the corner');
    const last = (px.h - 1) * px.w * 3;
    assert.deepEqual([px.data[last], px.data[last + 1], px.data[last + 2]], [0, 0, 255], 'picture bleeds off the bottom');
  });
});

describe('renderTemplate: style anchors', () => {
  it('takes the neutral ink and paper from the visual style when the brand gives none, and never fails on a bad style id', async () => {
    const t = tpl({ layers: [fill('bg', 'paper'), rect('bar', [0.1, 0.1, 0.3, 0.1], { fill: 'ink' }), text('headline', 'headline', [0.1, 0.4, 0.8, 0.2], { size: 0.08, color: 'onPaper' })] });
    const { getStyle } = await import('./styles');
    const style = getStyle('luxury_hospitality');
    const px = await decode((await renderOk(input(t, { palette: [], styleId: 'luxury_hospitality' }))).png);
    assert.deepEqual([px.data[0], px.data[1], px.data[2]], rgb(style.color.paper.toLowerCase()), 'canvas = the style paper');
    assert.ok(countNear(px, style.color.ink.toLowerCase(), 3) > 500, 'bar = the style ink');
    const bad = await renderTemplate(input(t, { palette: [], styleId: 'no_such_style' as never }));
    assert.equal(bad.ok, true);
  });
});

describe('renderTemplate: contrast', () => {
  it('adjusts text that would be unreadable and flags it', async () => {
    const t = tpl({ layers: [fill('bg', 'paper'), text('headline', 'headline', [0.1, 0.3, 0.8, 0.2], { size: 0.1, color: 'paper', weight: 800 })] });
    const r = await renderOk(input(t));
    assert.ok(r.flags.includes('low_contrast_adjusted:headline'), r.flags.join(','));
    const px = await decode(r.png);
    let darkest = 255;
    for (let i = 0; i < px.w * px.h; i++) darkest = Math.min(darkest, px.data[i * 3]);
    assert.ok(darkest < 80, `text became dark (${darkest})`);
  });

  it('adjusts a low-contrast BRAND color (yellow on near white) and keeps readable brand colors', async () => {
    const t = tpl({ layers: [fill('bg', '#ffffff'), text('headline', 'headline', [0.1, 0.3, 0.8, 0.2], { size: 0.05, color: 'primary', weight: 400 })] });
    const yellow = await renderOk(input(t, { palette: ['#ffe600'] }));
    assert.ok(yellow.flags.includes('low_contrast_adjusted:headline'));
    const navy = await renderOk(input(t, { palette: ['#0a2a66'] }));
    assert.deepEqual(navy.flags, []);
    const px = await decode(navy.png);
    assert.ok(countNear(px, '#0a2a66', 30) > 100, 'the navy brand color is used as is');
  });

  it('checks the text against the picture behind it, not against the template background', async () => {
    const t = tpl({ layers: [fill('bg', '#000000'), img('photo', 'hero', [0, 0, 1, 1]), text('headline', 'headline', [0.1, 0.3, 0.8, 0.2], { size: 0.1, color: '#ffffff', weight: 800 })] });
    const lightPhoto = await renderOk(input(t, { images: { hero: await makePng(800, 800, '#f5f5f5') } }));
    assert.ok(lightPhoto.flags.includes('low_contrast_adjusted:headline'));
    const darkPhoto = await renderOk(input(t, { images: { hero: await makePng(800, 800, '#101820') } }));
    assert.deepEqual(darkPhoto.flags.filter((f) => f.startsWith('low_contrast')), []);
  });

  it('adjusts a button label that cannot be read on its fill', async () => {
    const t = tpl({ layers: [fill('bg', '#ffffff'), text('headline', 'headline', [0.1, 0.2, 0.8, 0.1], { size: 0.05, color: '#000000' }), button('cta', [0.1, 0.4, 0.5, 0.12], { fill: 'primary', color: '#ffffff' })] });
    const r = await renderOk(input(t, { palette: ['#ffe600'], content: { headline: 'H', cta: 'Buy now' } }));
    assert.ok(r.flags.includes('low_contrast_adjusted:cta'), r.flags.join(','));
    const ok = await renderOk(input(t, { palette: ['#0a2a66'], content: { headline: 'H', cta: 'Buy now' } }));
    assert.deepEqual(ok.flags.filter((f) => f.startsWith('low_contrast')), []);
  });
});

describe('renderTemplate: layers, patches and determinism', () => {
  it('paints every layer type in array order', async () => {
    const t = tpl({
      layers: [
        fill('bg', grad(45, [0, 'paper'], [1, 'secondary', 0.5])),
        rect('card', [0.05, 0.05, 0.4, 0.2], { fill: 'primary', radius: 0.2, stroke: { color: 'ink', width: 0.004 }, shadow: true, rotate: 4 }),
        ellipse('oval', [0.5, 0.05, 0.3, 0.2], { fill: 'accent', stroke: { color: 'ink', width: 0.003 } }),
        circle('dot', [0.85, 0.05, 0.1, 0.1], { fill: 'secondary' }),
        line('rule', [0.05, 0.3], [0.95, 0.3], { color: 'ink', width: 0.004 }),
        poly('tri', [[0.05, 0.4], [0.2, 0.4], [0.12, 0.3]], { fill: 'accent', stroke: { color: 'ink', width: 0.002 }, opacity: 0.8 }),
        ...(['dots', 'grid', 'stripes', 'rings', 'waves', 'checks'] as const).map((k, i) => pattern(`p-${k}`, [0.05 + i * 0.15, 0.45, 0.13, 0.13], k, 'ink', 0.02)),
        img('photo', 'hero', [0.05, 0.62, 0.3, 0.2], { mask: 'rounded', radius: 0.15, fallback: 'brandPattern' }),
        text('headline', 'headline', [0.4, 0.62, 0.55, 0.12], { size: 0.06, family: 'serif' }),
        text('support', 'support', [0.4, 0.75, 0.55, 0.08], { size: 0.03, family: 'mono', italic: true, underline: true, tracking: 0.05 }),
        button('cta', [0.4, 0.86, 0.3, 0.08], { arrow: true }),
        logo('logo', [0.75, 0.86, 0.2, 0.06], { align: 'right', plate: { fill: 'ink', padding: 0.01, radius: 0.5 }, nameColor: 'onInk' }),
      ],
    });
    const r = await renderOk(input(t, { content: { headline: 'Everything', support: 'at once', cta: 'Go' } }));
    assert.deepEqual(r.layers, ['bg', 'card', 'oval', 'dot', 'rule', 'tri', 'p-dots', 'p-grid', 'p-stripes', 'p-rings', 'p-waves', 'p-checks', 'photo', 'headline', 'support', 'cta', 'logo']);
    assert.deepEqual([...r.drawn].sort(), ['cta', 'headline', 'support']);
  });

  it('supports the five font families', async () => {
    for (const family of ['sans', 'serif', 'display', 'condensed', 'mono'] as const) {
      const r = await renderOk(input(textBox({ family }), { content: { headline: 'Hamburgefonstiv 0123' } }));
      assert.ok(inkBounds(await decode(r.png), '#ffffff'), family);
    }
  });

  it('applies per-class patches and hide, and resolves them for the requested class', async () => {
    const t = tpl({
      classes: ['square', 'landscape'],
      layers: [
        fill('bg', '#ffffff'),
        rect('square-only', [0.1, 0.1, 0.2, 0.2], { fill: '#ff0000', hide: ['landscape'] }),
        text('headline', 'headline', [0.1, 0.4, 0.8, 0.2], { size: 0.08, color: '#000000', at: { landscape: patch(canvas(600, 314), { box: [330, 150, 220, 80], size: 24, align: 'right' }) } }),
      ],
    });
    const sq = await renderOk(input(t));
    assert.deepEqual(sq.layers, ['bg', 'square-only', 'headline']);
    const ls = await renderOk(input(t, { width: 600, height: 314 }));
    assert.deepEqual(ls.layers, ['bg', 'headline']);
    const b = inkBounds(await decode(ls.png), '#ffffff');
    assert.ok(b && b.l >= 330 - 4 && b.r <= 550 + 4, `patched box used (${b?.l}..${b?.r})`);
  });

  it('is deterministic: identical input gives byte-identical PNGs', async () => {
    const t = REFERENCES[0];
    const hero = await placeholderImage(540, 540, PREVIEW_PALETTE, 'det');
    const a = await renderOk(input(t, { content: t.sample as CreativeContent, images: { hero } }));
    const b = await renderOk(input(t, { content: t.sample as CreativeContent, images: { hero } }));
    assert.ok(a.png.equals(b.png));
    assert.deepEqual(a.flags, b.flags);
    const text = await renderOk(input(textBox(), { content: { headline: cases2() } }));
    const text2 = await renderOk(input(textBox(), { content: { headline: cases2() } }));
    assert.ok(text.png.equals(text2.png));
  });

  it('renders in a reasonable time', async () => {
    const t = REFERENCES[1];
    const hero = await placeholderImage(1080, 1080, PREVIEW_PALETTE, 'perf');
    await renderOk(input(t, { width: 1080, height: 1080, content: t.sample as CreativeContent, images: { hero } })); // warm fonts
    const t0 = Date.now();
    await renderOk(input(t, { width: 1080, height: 1080, content: t.sample as CreativeContent, images: { hero } }));
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  });
});

describe('defineTemplate', () => {
  it('throws on an invalid template when validation is on, and is the identity otherwise', () => {
    const bad = tpl({ layers: [fill('a', 'ink'), fill('a', 'paper')] });
    const prev = process.env.LAUNCHPILOT_VALIDATE_TEMPLATES;
    process.env.LAUNCHPILOT_VALIDATE_TEMPLATES = '1';
    try {
      assert.throws(() => defineTemplate(bad), /duplicate layer id/);
      const good = textBox();
      assert.equal(defineTemplate(good), good);
    } finally {
      if (prev === undefined) delete process.env.LAUNCHPILOT_VALIDATE_TEMPLATES;
      else process.env.LAUNCHPILOT_VALIDATE_TEMPLATES = prev;
    }
  });
});

function cases2() {
  return 'Deterministic headline text that wraps over a couple of lines';
}
