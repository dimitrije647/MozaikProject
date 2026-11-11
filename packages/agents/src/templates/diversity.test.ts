import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { makePng } from '../testing/fixtures';
import { TEMPLATE_LIBRARY, validateLibrary } from './library';
import { PREVIEW_PALETTE, placeholderImage } from './preview';
import { renderTemplate } from './render';
import { FORMAT_CLASSES, layerFor, type CreativeContent, type FormatClass, type Layer, type TemplateDef } from './schema';

/**
 * "30 recolors of one layout" must not pass. For every format class, every template that supports it is rendered with the SAME neutral
 * palette, the SAME placeholder picture and the SAME neutral copy (so only the template can make two results differ), and:
 *   1. the 64-bit difference hash (dHash, 9x8 grayscale: overall light/dark structure) of every pair must differ by at least MIN_DHASH_DISTANCE bits,
 *   2. the 64-bit EDGE hash (Laplacian edge density on an 8x8 grid: where the shapes and text are, independent of colors) must differ by at least
 *      MIN_EDGE_DISTANCE bits: this is what catches recolors of one layout, which dHash alone can miss when roles are swapped,
 *   3. the geometry signatures (layer types + boxes quantized to 5%) must differ pairwise, and share less than MAX_SHARED_LAYERS of their layers,
 *   4. template ids are unique and the library validates.
 * It is generic over TEMPLATE_LIBRARY: the number of templates is not asserted here.
 */

/** Hamming distance (of 64) below which two renders count as "the same picture". Measured: unrelated reference layouts 13-35 apart; the SAME template under another palette 1-10. */
const MIN_DHASH_DISTANCE = 8;
/** Same idea for the edge hash. Distinct layouts measured 18-25 bits apart; role-swapped recolors of one layout 0-16 (mostly <= 9). */
const MIN_EDGE_DISTANCE = 8;
/** Two templates may not share more than this fraction of their (non-background) layer boxes. */
const MAX_SHARED_LAYERS = 0.85;

const SIZES: Record<FormatClass, [number, number]> = { square: [540, 540], portrait: [540, 675], story: [540, 960], landscape: [600, 314], banner: [600, 150] };

const NEUTRAL_CONTENT: CreativeContent = {
  headline: 'A clear headline for the layout test',
  support: 'One short supporting sentence that explains the idea.',
  cta: 'Learn more',
  eyebrow: 'Eyebrow label',
  brand: 'Brandname',
  quote: 'A short customer quote that fits on a few lines.',
  attribution: 'Customer Name',
  stat: '98%',
  statLabel: 'of customers recommend us',
  date: '12 May',
  location: 'Belgrade',
  offer: '-20%',
  offerDetail: 'This week only',
  tag: 'New',
};

async function dHash(png: Buffer): Promise<bigint> {
  const { data } = await sharp(png).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (data[y * 9 + x] > data[y * 9 + x + 1] ? 1n : 0n);
  return bits;
}

/** Where the ink is, not what color it is: Laplacian edge magnitude averaged on an 8x8 grid, each cell above/below the median. */
async function edgeHash(png: Buffer): Promise<bigint> {
  const { data } = await sharp(png)
    .grayscale()
    .resize(128, 128, { fit: 'fill' })
    .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1], scale: 1, offset: 128 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cells: number[] = [];
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      let sum = 0;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) sum += Math.abs(data[(cy * 16 + y) * 128 + cx * 16 + x] - 128);
      cells.push(sum);
    }
  }
  const median = [...cells].sort((a, b) => a - b)[32];
  let bits = 0n;
  for (const c of cells) bits = (bits << 1n) | (c > median ? 1n : 0n);
  return bits;
}

function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

const q = (v: number) => Math.round(v / 0.05);

/** One token per layer: its type and its geometry quantized to 5% of the canvas. Backgrounds (full-canvas fills) are not part of the layout. */
function layerTokens(t: TemplateDef, cls: FormatClass): string[] {
  const out: string[] = [];
  for (const raw of t.layers) {
    const l = layerFor(raw, cls) as Layer | null;
    if (!l || l.type === 'fill') continue;
    if (l.type === 'line') out.push(`line@${[...l.from, ...l.to].map(q).join(',')}`);
    else if (l.type === 'polygon') out.push(`polygon@${l.points.map((p) => p.map(q).join(',')).join(';')}`);
    else out.push(`${l.type}${l.type === 'pattern' ? `:${l.kind}` : ''}@${l.box.map(q).join(',')}`);
  }
  return out;
}

const signature = (t: TemplateDef, cls: FormatClass) => layerTokens(t, cls).join('|');

function sharedFraction(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  const common = [...sa].filter((x) => sb.has(x)).length;
  return common / Math.max(1, Math.min(sa.size, sb.size));
}

interface Rendered {
  t: TemplateDef;
  hash: bigint;
  edge: bigint;
}
const results = new Map<FormatClass, Rendered[]>();

describe('template library diversity', () => {
  it('has unique ids and validates', () => {
    const ids = TEMPLATE_LIBRARY.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);
    assert.deepEqual(validateLibrary(), []);
  });

  for (const cls of FORMAT_CLASSES) {
    const supporting = TEMPLATE_LIBRARY.filter((t) => t.classes.includes(cls));

    it(`renders every ${cls} template with the same palette, picture and copy`, async (tc) => {
      const [w, h] = SIZES[cls];
      const hero = await placeholderImage(w, h, PREVIEW_PALETTE, 'diversity');
      const secondary = await placeholderImage(w, h, PREVIEW_PALETTE, 'diversity-2');
      const logo = await makePng(320, 120, '#444444');
      const rendered: Rendered[] = [];
      for (const t of supporting) {
        const r = await renderTemplate({ template: t, width: w, height: h, content: NEUTRAL_CONTENT, palette: PREVIEW_PALETTE, brandName: 'Brandname', images: { hero, secondary }, logo });
        assert.ok(r.ok, `${t.id} ${cls}: ${r.ok ? '' : `${r.reason} ${r.message}`}`);
        if (r.ok) rendered.push({ t, hash: await dHash(r.png), edge: await edgeHash(r.png) });
      }
      results.set(cls, rendered);
      tc.diagnostic(`${cls}: ${rendered.length} template(s) rendered`);
    });

    it(`${cls}: no two templates look alike (dHash >= ${MIN_DHASH_DISTANCE}, edge hash >= ${MIN_EDGE_DISTANCE} of 64 bits) or share their geometry`, (tc) => {
      const rendered = results.get(cls) ?? [];
      assert.equal(rendered.length, supporting.length);
      let min = { d: 65, a: '', b: '' };
      let minEdge = { d: 65, a: '', b: '' };
      let maxShared = { s: 0, a: '', b: '' };
      for (let i = 0; i < rendered.length; i++) {
        for (let j = i + 1; j < rendered.length; j++) {
          const a = rendered[i];
          const b = rendered[j];
          const d = hamming(a.hash, b.hash);
          if (d < min.d) min = { d, a: a.t.id, b: b.t.id };
          assert.ok(d >= MIN_DHASH_DISTANCE, `${a.t.id} and ${b.t.id} look alike in ${cls} (dHash distance ${d} < ${MIN_DHASH_DISTANCE})`);
          const e = hamming(a.edge, b.edge);
          if (e < minEdge.d) minEdge = { d: e, a: a.t.id, b: b.t.id };
          assert.ok(e >= MIN_EDGE_DISTANCE, `${a.t.id} and ${b.t.id} have the same structure in ${cls} (edge hash distance ${e} < ${MIN_EDGE_DISTANCE})`);
          assert.notEqual(signature(a.t, cls), signature(b.t, cls), `${a.t.id} and ${b.t.id} have the same geometry in ${cls}`);
          const shared = sharedFraction(layerTokens(a.t, cls), layerTokens(b.t, cls));
          if (shared > maxShared.s) maxShared = { s: shared, a: a.t.id, b: b.t.id };
          assert.ok(shared < MAX_SHARED_LAYERS, `${a.t.id} and ${b.t.id} share ${(shared * 100).toFixed(0)}% of their layer boxes in ${cls}`);
        }
      }
      if (rendered.length > 1) {
        const line = `${cls}: min dHash distance ${min.d} (${min.a} vs ${min.b}); min edge distance ${minEdge.d} (${minEdge.a} vs ${minEdge.b}); max shared layer boxes ${(maxShared.s * 100).toFixed(0)}% (${maxShared.a} vs ${maxShared.b})`;
        tc.diagnostic(line);
        console.log(`  [diversity] ${line}`);
      }
    });
  }

  it('the detector itself catches a recolor of one layout (same geometry, different roles)', async () => {
    const base = TEMPLATE_LIBRARY[0];
    if (!base) return;
    const cls = base.classes[0];
    const swap: Record<string, string> = { ink: 'primary', paper: 'secondary', primary: 'accent', accent: 'ink', onInk: 'onPrimary', onPaper: 'onAccent' };
    const recolored = JSON.parse(JSON.stringify(base), (_k, v) => (typeof v === 'string' && v in swap ? swap[v] : v)) as TemplateDef;
    recolored.id = `${base.id}_recolor`;
    assert.equal(signature(base, cls), signature(recolored, cls), 'a recolor keeps the geometry signature, which the diversity test rejects');
    assert.ok(sharedFraction(layerTokens(base, cls), layerTokens(recolored, cls)) >= MAX_SHARED_LAYERS);
    assert.equal(sharedFraction([], []), 0);
  });
});
