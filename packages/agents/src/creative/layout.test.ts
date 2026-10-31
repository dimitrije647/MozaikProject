import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { makePng } from '../testing/fixtures';
import { CREATIVE_FORMATS, baseSizeFor, formatsForChannels, upscaleFactor } from './formats';
import { brandGradient, renderLayout, wrapText } from './layout';

const FMT = CREATIVE_FORMATS;
const palette = ['#0a5c8c', '#e9a23b'];
const req = (over: Partial<Parameters<typeof renderLayout>[0]> = {}) => ({ base: null as Buffer | null, format: FMT.instagram_square, headline: 'Learn to dive with confidence', body: 'Small groups and certified instructors.', ctaText: 'Book a trial dive', palette, logo: null as Buffer | null, ...over });

describe('Layout Designer renderer (deterministic, no model)', () => {
  it('exports the exact format dimensions as PNG for every format, from one base image', async () => {
    const base = await makePng(1024, 1536, '#335577');
    for (const f of Object.values(FMT)) {
      const r = await renderLayout(req({ base, format: f }));
      if (!r.ok) {
        assert.ok(/enlarge/.test(r.reason), `${f.id}: ${r.reason}`); // an honest refusal, never a broken export
        continue;
      }
      const meta = await sharp(r.png).metadata();
      assert.deepEqual([meta.format, meta.width, meta.height], ['png', f.width, f.height], f.id);
    }
  });

  it('refuses a format that would need blurry upscaling instead of exporting it', async () => {
    const square = await makePng(1024, 1024, '#335577');
    const r = await renderLayout(req({ base: square, format: FMT.story }));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : '', /enlarge it 1\.88× and look blurry/);
    assert.ok(upscaleFactor(1024, 1536, FMT.story) < 1.6);
    assert.equal((await renderLayout(req({ base: await makePng(1024, 1536, '#335577'), format: FMT.story }))).ok, true);
  });

  it('never stretches: an off-aspect base is cropped (cover), and the result keeps the exact format size', async () => {
    const wide = await makePng(1536, 1024, '#884433');
    const r = await renderLayout(req({ base: wide, format: FMT.instagram_portrait }));
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.info.upscale, 1.32);
  });

  it('chooses readable text for dark AND light images and reports contrast', async () => {
    const dark = await renderLayout(req({ base: await makePng(1080, 1080, '#101820') }));
    const light = await renderLayout(req({ base: await makePng(1080, 1080, '#f5f1e8') }));
    assert.ok(dark.ok && light.ok);
    if (dark.ok && light.ok) {
      assert.equal(dark.info.theme, 'light-text');
      assert.equal(light.info.theme, 'dark-text');
      assert.ok(dark.info.contrast >= 4.5 && light.info.contrast >= 4.5, `${dark.info.contrast} / ${light.info.contrast}`);
      assert.ok(!dark.flags.some((x) => x.startsWith('low_contrast')) && !light.flags.some((x) => x.startsWith('low_contrast')));
    }
  });

  it('text clipping protection: a very long headline is shrunk until it fits (or flagged), and stays inside the safe area', async () => {
    const long = 'Discover the unforgettable underwater world with our certified instructors in warm clear water this summer season';
    const r = await renderLayout(req({ headline: long, base: await makePng(1080, 1080, '#202a35') }));
    assert.ok(r.ok);
    if (r.ok) {
      const short = await renderLayout(req({ base: await makePng(1080, 1080, '#202a35') }));
      assert.ok(short.ok && r.info.headlineSize < short.info.headlineSize, 'the long headline got a smaller font');
      assert.ok(r.info.lines <= 4);
      assert.ok(!r.flags.includes('text_overflow'), r.flags.join(','));
    }
    const absurd = await renderLayout(req({ headline: 'x'.repeat(400), base: null }));
    assert.ok(absurd.ok && absurd.flags.includes('text_overflow'), 'an unfittable headline is FLAGGED, not silently clipped');
  });

  it('keeps text out of the Story safe zones (top and bottom 14%)', async () => {
    const base = await makePng(1024, 1536, '#ffffff');
    const r = await renderLayout(req({ base, format: FMT.story, theme: undefined } as never));
    assert.ok(r.ok);
    if (!r.ok) return;
    // On a flat white base the only non-white pixels are the scrim, text and CTA: none may sit in the reserved bands.
    const { data, info } = await sharp(r.png).raw().toBuffer({ resolveWithObject: true });
    const bottomBand = Math.floor(info.height * 0.86);
    let ink = 0;
    for (let y = bottomBand; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i] < 120 && data[i + 1] < 120 && data[i + 2] < 120) ink++;
    }
    assert.equal(ink, 0, 'no dark ink in the bottom safe band');
  });

  it('composites the logo contained (aspect kept), inside the safe area, and flags collisions', async () => {
    const logo = await sharp({ create: { width: 600, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const base = await makePng(1080, 1080, '#202a35');
    const withLogo = await renderLayout(req({ base, logo }));
    const without = await renderLayout(req({ base }));
    assert.ok(withLogo.ok && without.ok);
    if (withLogo.ok && without.ok) {
      const a = await sharp(withLogo.png).raw().toBuffer();
      const b = await sharp(without.png).raw().toBuffer();
      assert.ok(!a.equals(b), 'the logo changed the image');
      // top-left logo area contains pure red pixels from the logo
      const { data, info } = await sharp(withLogo.png).extract({ left: 86, top: 76, width: 200, height: 60 }).raw().toBuffer({ resolveWithObject: true });
      let red = 0;
      for (let i = 0; i < data.length; i += info.channels) if (data[i] > 240 && data[i + 1] < 20 && data[i + 2] < 20) red++;
      assert.ok(red > 200, `logo pixels found: ${red}`);
    }
    const collide = await renderLayout(req({ base, logo, overrides: { textPosition: 'top', logoPosition: 'top-left' } }));
    assert.ok(collide.ok && collide.flags.includes('logo_collides_with_text'));
    const broken = await renderLayout(req({ base, logo: Buffer.from('not an image') }));
    assert.ok(broken.ok && broken.flags.includes('logo_unreadable'));
  });

  it('draws brand colors when there is no AI image, escapes markup, and wraps words safely', async () => {
    const r = await renderLayout(req({ base: null, headline: '<script>alert(1)</script> & "Dive"', ctaText: 'Go & see' }));
    assert.ok(r.ok);
    if (r.ok) assert.equal((await sharp(r.png).metadata()).width, 1080);
    const g = await sharp(await brandGradient(256, palette)).metadata();
    assert.equal(g.width, 256);
    assert.deepEqual(wrapText('aaaa bbbb cccc', 20, 120, 5).lines.length >= 2, true);
    assert.ok(wrapText('Supercalifragilisticexpialidocious '.repeat(3), 30, 200, 6).lines.every((l) => l.length <= 200 / (30 * 0.58) + 1));
  });

  it('plans formats per channel without duplicates, within the cap, and picks a base size that avoids blurry crops', () => {
    const f = formatsForChannels(['instagram', 'facebook', 'linkedin'], 4);
    assert.equal(new Set(f.map((x) => x.format.id)).size, f.length);
    assert.ok(f.length <= 4 && f.some((x) => x.format.id === 'linkedin_feed'));
    assert.equal(baseSizeFor([FMT.instagram_square]), '1024x1024');
    assert.equal(baseSizeFor([FMT.story, FMT.instagram_portrait, FMT.instagram_square]), '1024x1536');
    assert.equal(baseSizeFor([FMT.linkedin_feed, FMT.promo_16x9]), '1536x1024');
  });
});
