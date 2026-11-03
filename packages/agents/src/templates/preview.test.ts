import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { makePng } from '../testing/fixtures';
import { EDITORIAL_BRAND } from './library/editorial-brand';
import { HOSPITALITY } from './library/hospitality';
import { TECH_SAAS } from './library/tech-saas';
import { PREVIEW_PALETTE, placeholderImage, previewSizeFor, renderTemplatePreview } from './preview';
import { FORMAT_CLASSES } from './schema';

const [TECH] = TECH_SAAS;
const [HOSP] = HOSPITALITY;
const [EDITORIAL] = EDITORIAL_BRAND;

async function meanColor(png: Buffer) {
  const s = await sharp(png).stats();
  return s.channels.slice(0, 3).map((c) => c.mean);
}

describe('previewSizeFor', () => {
  it('has one size per class with the right aspect ratio', () => {
    assert.deepEqual(previewSizeFor('square'), { width: 1080, height: 1080 });
    assert.deepEqual(previewSizeFor('portrait'), { width: 1080, height: 1350 });
    assert.deepEqual(previewSizeFor('story'), { width: 1080, height: 1920 });
    assert.deepEqual(previewSizeFor('landscape'), { width: 1200, height: 628 });
    assert.deepEqual(previewSizeFor('banner'), { width: 1200, height: 300 });
    for (const c of FORMAT_CLASSES) assert.ok(previewSizeFor(c).width > 0);
  });
  it('returns a copy', () => {
    const s = previewSizeFor('square');
    s.width = 1;
    assert.equal(previewSizeFor('square').width, 1080);
  });
});

describe('placeholderImage', () => {
  it('makes a PNG of the exact size, deterministically', async () => {
    const a = await placeholderImage(640, 360, PREVIEW_PALETTE, 7);
    const b = await placeholderImage(640, 360, PREVIEW_PALETTE, 7);
    assert.ok(a.equals(b));
    const meta = await sharp(a).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', 640, 360]);
  });

  it('differs with the seed and follows the palette hue', async () => {
    const a = await placeholderImage(320, 320, PREVIEW_PALETTE, 'one');
    const b = await placeholderImage(320, 320, PREVIEW_PALETTE, 'two');
    assert.ok(!a.equals(b));
    const [rBlue, , bBlue] = await meanColor(await placeholderImage(320, 320, ['#1d4ed8'], 1));
    const [rRed, , bRed] = await meanColor(await placeholderImage(320, 320, ['#dc2626'], 1));
    assert.ok(bBlue - rBlue > bRed - rRed, 'a blue brand gives a bluer placeholder than a red one');
  });

  it('is a neutral stand-in: low saturation, mid tones', async () => {
    const [r, g, b] = await meanColor(await placeholderImage(400, 400, ['#ff0000'], 3));
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 70, 'never a vivid image');
    assert.ok((r + g + b) / 3 > 50 && (r + g + b) / 3 < 200);
  });

  it('copes with junk palettes and tiny sizes', async () => {
    for (const p of [[], ['nope'], [null as never], undefined as never]) {
      const png = await placeholderImage(64, 48, p, 1);
      assert.equal((await sharp(png).metadata()).width, 64);
    }
    assert.equal((await sharp(await placeholderImage(1, 1, [], 1)).metadata()).width, 16);
  });
});

describe('renderTemplatePreview', () => {
  it('renders each reference template at its first class size with sample copy and flags the placeholder picture', async () => {
    for (const t of [TECH, HOSP, EDITORIAL]) {
      const r = await renderTemplatePreview({ template: t });
      assert.ok(r.ok, r.ok ? '' : r.message);
      if (!r.ok) continue;
      const size = previewSizeFor(t.classes[0]);
      assert.deepEqual([r.width, r.height], [size.width, size.height]);
      assert.ok(r.drawn.includes('headline'));
      assert.equal(r.flags.includes('placeholder_image'), true, `${t.id} marks the synthetic picture`);
    }
  });

  it('renders every declared class at the standard preview size', async () => {
    for (const t of [TECH, HOSP, EDITORIAL]) {
      for (const cls of t.classes) {
        const r = await renderTemplatePreview({ template: t, class: cls });
        assert.ok(r.ok, `${t.id} ${cls}`);
        if (r.ok) assert.deepEqual([r.width, r.height], [previewSizeFor(cls).width, previewSizeFor(cls).height]);
      }
    }
  });

  it('honours explicit sizes, palette, content overrides and style', async () => {
    const r = await renderTemplatePreview({ template: EDITORIAL, width: 540, height: 540, palette: ['#c2410c', '#fde68a'], content: { headline: 'Override headline', tag: undefined }, styleId: 'premium_editorial' });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual([r.width, r.height], [540, 540]);
    assert.ok(!r.drawn.includes('tag'), 'an explicit undefined removes the sample copy');
    assert.ok(r.drawn.includes('headline') && r.drawn.includes('support'));
  });

  it('refuses classes the template does not support and picture templates without a picture', async () => {
    const banner = await renderTemplatePreview({ template: TECH, class: 'banner' });
    assert.equal(banner.ok, false);
    if (!banner.ok) assert.equal(banner.reason, 'unsupported_format');
    const noPic = await renderTemplatePreview({ template: TECH, withImage: false });
    assert.equal(noPic.ok, false);
    if (!noPic.ok) assert.equal(noPic.reason, 'missing_required');
    const typeOnly = await renderTemplatePreview({ template: EDITORIAL, withImage: false });
    assert.ok(typeOnly.ok);
    if (typeOnly.ok) assert.ok(!typeOnly.flags.includes('placeholder_image'));
  });

  it('does not flag a placeholder when a real picture is supplied', async () => {
    const r = await renderTemplatePreview({ template: TECH, class: 'square', hero: await makePng(1200, 1200, '#224466') });
    assert.ok(r.ok);
    if (r.ok) assert.ok(!r.flags.includes('placeholder_image'));
  });

  it('is deterministic', async () => {
    const a = await renderTemplatePreview({ template: HOSP, class: 'story' });
    const b = await renderTemplatePreview({ template: HOSP, class: 'story' });
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.ok(a.png.equals(b.png));
  });
});
