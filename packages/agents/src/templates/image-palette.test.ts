import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { extractPalette, isImageBuffer } from './image-palette';

const solid = (w: number, h: number, hex: string) => sharp({ create: { width: w, height: h, channels: 3, background: hex } });
const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const dist = (a: string, b: string) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]!));

/** `w x h` image: left part `ratio` of the width in color a, the rest in color b. */
async function twoColors(a: string, b: string, ratio: number, format: 'png' | 'jpeg' | 'webp' = 'png'): Promise<Buffer> {
  const w = 200;
  const h = 120;
  const left = Math.round(w * ratio);
  const img = solid(w, h, b).composite([{ input: await solid(left, h, a).png().toBuffer(), left: 0, top: 0 }]);
  return format === 'png' ? img.png().toBuffer() : format === 'jpeg' ? img.jpeg({ quality: 92 }).toBuffer() : img.webp({ lossless: true }).toBuffer();
}

describe('isImageBuffer', () => {
  it('accepts real raster formats', async () => {
    assert.equal(isImageBuffer(await solid(10, 10, '#ff0000').png().toBuffer()), true);
    assert.equal(isImageBuffer(await solid(10, 10, '#ff0000').jpeg().toBuffer()), true);
    assert.equal(isImageBuffer(await solid(10, 10, '#ff0000').webp().toBuffer()), true);
    assert.equal(isImageBuffer(await solid(10, 10, '#ff0000').gif().toBuffer()), true);
  });
  it('refuses svg, text, pdf, empty and non-buffers', () => {
    assert.equal(isImageBuffer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>')), false);
    assert.equal(isImageBuffer(Buffer.from('<?xml version="1.0"?><svg/>')), false);
    assert.equal(isImageBuffer(Buffer.from('%PDF-1.7 something something')), false);
    assert.equal(isImageBuffer(Buffer.from('hello world, definitely not a picture')), false);
    assert.equal(isImageBuffer(Buffer.alloc(0)), false);
    assert.equal(isImageBuffer(null), false);
    assert.equal(isImageBuffer('png'), false);
    assert.equal(isImageBuffer({} as never), false);
  });
});

describe('extractPalette', () => {
  it('returns both colors of a two-color image, dominant first', async () => {
    const p = await extractPalette(await twoColors('#d62828', '#1d4ed8', 0.7));
    assert.deepEqual(p, ['#D62828', '#1D4ED8']);
    const q = await extractPalette(await twoColors('#d62828', '#1d4ed8', 0.25));
    assert.deepEqual(q, ['#1D4ED8', '#D62828']);
  });

  it('a flat color gives exactly that color', async () => {
    assert.deepEqual(await extractPalette(await solid(64, 64, '#0f766e').png().toBuffer()), ['#0F766E']);
  });

  it('is deterministic', async () => {
    const buf = await twoColors('#f59e0b', '#111827', 0.6);
    assert.deepEqual(await extractPalette(buf), await extractPalette(buf));
  });

  it('respects n, and n larger than the number of colors just returns fewer', async () => {
    const buf = await twoColors('#f59e0b', '#111827', 0.6);
    assert.equal((await extractPalette(buf, 1)).length, 1);
    assert.deepEqual(await extractPalette(buf, 1), ['#F59E0B']);
    assert.equal((await extractPalette(buf, 10)).length, 2);
    assert.deepEqual(await extractPalette(buf, 0), ['#F59E0B']);
    assert.deepEqual(await extractPalette(buf, Number.NaN), ['#F59E0B', '#111827']);
  });

  it('three blocks come back in order of area', async () => {
    const w = 300;
    const h = 100;
    const buf = await solid(w, h, '#22c55e')
      .composite([
        { input: await solid(150, h, '#7c3aed').png().toBuffer(), left: 0, top: 0 },
        { input: await solid(50, h, '#ef4444').png().toBuffer(), left: 250, top: 0 },
      ])
      .png()
      .toBuffer();
    // 150 violet, 100 green, 50 red
    assert.deepEqual(await extractPalette(buf), ['#7C3AED', '#22C55E', '#EF4444']);
  });

  it('merges near-duplicate shades into one color', async () => {
    const buf = await solid(200, 100, '#2563eb')
      .composite([{ input: await solid(100, 100, '#2764ea').png().toBuffer(), left: 100, top: 0 }])
      .png()
      .toBuffer();
    const p = await extractPalette(buf);
    assert.equal(p.length, 1);
    assert.ok(dist(p[0]!, '#2563eb') < 8);
  });

  it('ignores transparent pixels', async () => {
    const transparent = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await solid(40, 40, '#16a34a').png().toBuffer(), left: 30, top: 30 }])
      .png()
      .toBuffer();
    // the transparent surround (hidden color black) must NOT show up
    assert.deepEqual(await extractPalette(transparent), ['#16A34A']);
  });

  it('a fully transparent image has no palette', async () => {
    const empty = await sharp({ create: { width: 50, height: 50, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    assert.deepEqual(await extractPalette(empty), []);
  });

  it('ignores near-transparent pixels but keeps clearly visible ones', async () => {
    const ghost = await sharp({ create: { width: 60, height: 60, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.05 } } })
      .composite([{ input: await sharp({ create: { width: 30, height: 60, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).png().toBuffer(), left: 0, top: 0 }])
      .png()
      .toBuffer();
    assert.deepEqual(await extractPalette(ghost), ['#0000FF']);
  });

  it('reads jpeg and webp', async () => {
    for (const fmt of ['jpeg', 'webp'] as const) {
      const p = await extractPalette(await twoColors('#e11d48', '#0ea5e9', 0.65, fmt));
      assert.equal(p.length >= 2, true, fmt);
      assert.ok(dist(p[0]!, '#e11d48') < 40, `${fmt} dominant ${p[0]}`);
      assert.ok(p.some((c) => dist(c, '#0ea5e9') < 40), `${fmt} second`);
    }
  });

  it('handles a large image without trouble', async () => {
    const p = await extractPalette(await twoColors('#fbbf24', '#1e293b', 0.5).then((b) => sharp(b).resize(2400, 1600, { kernel: 'nearest' }).png().toBuffer()));
    assert.equal(p.length, 2);
  });

  it('refuses svg and garbage with [] and never throws', async () => {
    assert.deepEqual(await extractPalette(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#ff0000"/></svg>')), []);
    assert.deepEqual(await extractPalette(Buffer.from('not an image at all, just some words')), []);
    assert.deepEqual(await extractPalette(Buffer.alloc(0)), []);
    assert.deepEqual(await extractPalette(Buffer.alloc(2048, 7)), []);
    assert.deepEqual(await extractPalette(undefined as never), []);
    assert.deepEqual(await extractPalette(null as never), []);
    assert.deepEqual(await extractPalette('png' as never), []);
    // a truncated png: valid header, broken body
    const png = await solid(40, 40, '#ff00ff').png().toBuffer();
    const truncated = png.subarray(0, 40);
    const r = await extractPalette(truncated);
    assert.ok(Array.isArray(r));
    // PNG magic followed by junk
    assert.deepEqual(await extractPalette(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])), []);
  });

  it('only ever returns #RRGGBB values', async () => {
    const noisy = await sharp(Buffer.from(Array.from({ length: 64 * 64 * 3 }, (_, i) => (i * 37 + (i >> 3) * 11) % 256)), { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
    const p = await extractPalette(noisy, 6);
    assert.ok(p.length >= 1 && p.length <= 6);
    for (const c of p) assert.match(c, /^#[0-9A-F]{6}$/);
    assert.equal(new Set(p).size, p.length);
  });
});
