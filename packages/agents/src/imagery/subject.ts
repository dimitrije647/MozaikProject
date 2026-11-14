import sharp from 'sharp';

/**
 * WHERE THE SUBJECT OF A PICTURE IS (deterministic, local, no model and no network). Used by the renderer to crop without cutting people, the
 * logo or the product, and by the design preflight to check that nothing important ends up under a panel, a band or a text block.
 *
 *   faces    skin regions shaped like a face, with darker inner features (eyes, mouth): a LOCAL HEURISTIC, not a neural detector. Skin is
 *            classified in normalised (r, g) chromaticity, where skin tones differ mostly in brightness rather than colour, with a low
 *            brightness floor so dark skin is not excluded, and once more after a partial gray-world white balance so coloured light
 *            (tungsten, blue shade) is tolerated. A face candidate must hold darker features; flat skin-coloured surfaces (a beige wall,
 *            wood) usually do not. It still misses faces in profile, very small, in silhouette or in very strong coloured light, and can be
 *            fooled by skin-coloured textured surfaces. It returns boxes only: it never identifies anyone.
 *   people   for every face, the whole head with padding and the shoulders below it (what a crop must not cut in half)
 *   subject  the box that should stay visible: the union of the people, else where the detail (edge energy) of the picture is concentrated
 *   graphic  the picture is a flat graphic (a logo banner, an illustration, text on a colour field) rather than a photograph: it must never be
 *            cover-cropped, because cropping cuts its letters
 *   busy     a coarse grid of how busy each part of the picture is (0 calm .. 1 very busy): where text can sit without a backing
 *
 * All boxes are [x, y, w, h] as fractions (0..1) of the picture.
 */

export type Box01 = [number, number, number, number];

export interface SubjectMap {
  version: 2;
  faces: Box01[];
  people: Box01[];
  subject: Box01;
  graphic: boolean;
  /** busy[row * cols + col], 0..1, over the whole picture */
  busy: { cols: number; rows: number; cells: number[] };
}

/** Mean busyness of a picture region (fractions of the picture); 0.5 when unknown. */
export function busyIn(map: Pick<SubjectMap, 'busy'>, b: Box01): number {
  const { cols, rows, cells } = map.busy;
  if (!cells.length) return 0.5;
  const c0 = Math.max(0, Math.floor(b[0] * cols));
  const c1 = Math.min(cols - 1, Math.ceil((b[0] + b[2]) * cols) - 1);
  const r0 = Math.max(0, Math.floor(b[1] * rows));
  const r1 = Math.min(rows - 1, Math.ceil((b[1] + b[3]) * rows) - 1);
  if (c1 < c0 || r1 < r0) return 0.5;
  let s = 0;
  let n = 0;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++, n++) s += cells[r * cols + c];
  return n ? s / n : 0.5;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const SHARP_IN = { limitInputPixels: 80_000_000, failOn: 'none' as const };
const GRID_W = 240;
const BUSY_COLS = 24;
const MAX_FACES = 16;

const cache = new WeakMap<Buffer, Promise<SubjectMap | null>>();

/** The subject map of one picture (cached per buffer: a picture used by many creatives is analysed once). Null when it cannot be decoded. */
export function analyzeSubject(buf: Buffer): Promise<SubjectMap | null> {
  let hit = cache.get(buf);
  if (!hit) {
    hit = compute(buf).catch(() => null);
    cache.set(buf, hit);
  }
  return hit;
}

/** Union of boxes (null when empty). */
export function unionBox(boxes: Box01[]): Box01 | null {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * Skin in normalised chromaticity (r = R/sum, g = G/sum): light and dark skin share roughly the same chromaticity and differ in brightness,
 * so the brightness floor is low (22 of 255). Greys, blues, greens, beige walls and sand fall outside; wood and leather can fall inside
 * (the feature test of a face candidate removes most of those).
 */
const isSkin = (r: number, g: number, b: number): boolean => {
  const sum = r + g + b;
  if (sum < 60) return false;
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (y < 22 || y > 250) return false;
  if (Math.max(r, g, b) - Math.min(r, g, b) < 12) return false;
  const rn = r / sum;
  const gn = g / sum;
  if (!(rn > 0.36 && rn < 0.6 && gn > 0.26 && gn < 0.37 && rn - gn > 0.028 && r > b)) return false;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return cr >= 132 && cr <= 184 && cb >= 68 && cb <= 136;
};

async function compute(buf: Buffer): Promise<SubjectMap | null> {
  const { data, info } = await sharp(buf, SHARP_IN).rotate().flatten({ background: '#ffffff' }).resize(GRID_W, GRID_W, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  if (W < 8 || H < 8) return null;
  const n = W * H;

  // ---- graphic or photograph -------------------------------------------------------------------------------------------------------------
  // A flat graphic is made of few colours with large identical areas and hard edges; a photograph (even a studio photo on a plain backdrop)
  // has sensor noise and gradients everywhere.
  const counts = new Map<number, number>();
  let flatNeighbours = 0;
  let neighbourPairs = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if ((i + 1) % W !== 0) {
      neighbourPairs++;
      if (Math.abs(r - data[(i + 1) * 3]) <= 1 && Math.abs(g - data[(i + 1) * 3 + 1]) <= 1 && Math.abs(b - data[(i + 1) * 3 + 2]) <= 1) flatNeighbours++;
    }
  }
  const top = [...counts.values()].sort((a, b) => b - a);
  const topShare = top.slice(0, 8).reduce((s, v) => s + v, 0) / n;
  const flatShare = neighbourPairs ? flatNeighbours / neighbourPairs : 0;
  // a flat LOOK alone is not enough: a person in front of a smooth studio backdrop also has few colours; faces decide below
  const flatLook = topShare >= 0.72 && flatShare >= 0.55;

  // ---- faces: connected skin components ---------------------------------------------------------------------------------------------------
  // the light cast is estimated from the BRIGHTEST pixels (white-patch: highlights and white clothing take the colour of the light), not
  // from the mean, which a coloured backdrop (a navy studio wall) would dominate; the correction is partial and bounded. A pixel is skin when it
  // reads as skin before OR after the correction.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => data[b * 3] + data[b * 3 + 1] + data[b * 3 + 2] - (data[a * 3] + data[a * 3 + 1] + data[a * 3 + 2]));
  let mr = 0;
  let mg = 0;
  let mb = 0;
  const brightest = Math.max(1, Math.floor(n * 0.03));
  for (let k = 0; k < brightest; k++) {
    const i = order[k];
    mr += data[i * 3];
    mg += data[i * 3 + 1];
    mb += data[i * 3 + 2];
  }
  const grey = (mr + mg + mb) / 3;
  const gain = (m: number) => clamp(1 + (grey / Math.max(1, m) - 1) * 0.7, 0.75, 1.3);
  const kr = gain(mr);
  const kg = gain(mg);
  const kb = gain(mb);
  const skin = new Uint8Array(n);
  const lum = new Float32Array(n);
  const chroma = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    lum[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    chroma[i] = r / Math.max(1, r + g + b);
    skin[i] = isSkin(r, g, b) || isSkin(Math.min(255, r * kr), Math.min(255, g * kg), Math.min(255, b * kb)) ? 1 : 0;
  }
  const label = new Int32Array(n).fill(-1);
  const comps: { id: number; x0: number; y0: number; x1: number; y1: number; area: number; chroma: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!skin[start] || label[start] >= 0) continue;
    const c = { id: comps.length, x0: W, y0: H, x1: -1, y1: -1, area: 0, chroma: 0 };
    label[start] = comps.length;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p - x) / W;
      c.area++;
      c.chroma += chroma[p];
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      const next = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      // region growing with CONTINUITY: a neighbour joins only when brightness and chromaticity continue smoothly, so a face's shading
      // stays one region while the edge to a skin-coloured object behind it (a book, a wooden shelf) separates them
      for (const q of next) {
        if (q >= 0 && skin[q] && label[q] < 0 && Math.abs(lum[q] - lum[p]) < 0.07 && Math.abs(chroma[q] - chroma[p]) < 0.035) {
          label[q] = comps.length;
          stack.push(q);
        }
      }
    }
    comps.push(c);
  }
  // the shading of a face (a lit forehead, a cheek in shadow) can split it into fragments: touching fragments of the same skin chromaticity
  // are joined again (a book or a shelf behind the person has another chromaticity and stays apart)
  for (const c of comps) c.chroma /= Math.max(1, c.area);
  const parent = comps.map((c) => c.id);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const near = (a: (typeof comps)[number], b: (typeof comps)[number]) => a.x0 <= b.x1 + 2 && b.x0 <= a.x1 + 2 && a.y0 <= b.y1 + 2 && b.y0 <= a.y1 + 2;
  // only face-sized fragments are joined: a wall or a backdrop that happens to be skin-coloured under warm light never absorbs a face
  const sizable = comps.filter((c) => c.area >= 4 && c.area <= n * 0.06);
  for (let i = 0; i < sizable.length; i++) {
    for (let j = i + 1; j < sizable.length; j++) {
      const a = sizable[i];
      const b = sizable[j];
      if (!near(a, b) || Math.abs(a.chroma - b.chroma) >= 0.045) continue;
      const ra = find(a.id);
      const rb = find(b.id);
      if (ra === rb) continue;
      // the joined box must still be shaped like a head (not a row of book spines)
      const x0 = Math.min(a.x0, b.x0);
      const x1 = Math.max(a.x1, b.x1);
      const y0 = Math.min(a.y0, b.y0);
      const y1 = Math.max(a.y1, b.y1);
      const aspect = (y1 - y0 + 1) / (x1 - x0 + 1);
      if (aspect >= 0.6 && aspect <= 2.6 && (x1 - x0 + 1) * (y1 - y0 + 1) <= n * 0.25) parent[ra] = rb;
    }
  }
  const merged = new Map<number, (typeof comps)[number] & { members: number[] }>();
  for (const c of comps) {
    const r = find(c.id);
    const m = merged.get(r);
    if (!m) merged.set(r, { ...c, id: r, members: [c.id] });
    else {
      m.x0 = Math.min(m.x0, c.x0);
      m.y0 = Math.min(m.y0, c.y0);
      m.x1 = Math.max(m.x1, c.x1);
      m.y1 = Math.max(m.y1, c.y1);
      m.chroma = (m.chroma * m.area + c.chroma * c.area) / (m.area + c.area);
      m.area += c.area;
      m.members.push(c.id);
    }
  }
  const regions = [...merged.values()];
  // features are looked for at twice the resolution: at 240 px an eye or a mouth of a group member is smaller than a pixel
  const hi = await sharp(buf, SHARP_IN).rotate().flatten({ background: '#ffffff' }).resize(W * 2, H * 2, { fit: 'fill' }).grayscale().raw().toBuffer();
  /** A face holds darker features (eyes, brows, mouth, nostrils) inside its skin region; a flat skin-coloured surface does not. */
  const hasFeatures = (c: (typeof regions)[number]) => {
    if (c.area < 30) return true; // too small to resolve features: kept on shape alone
    const ids = new Set(c.members);
    let skinL = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (ids.has(label[y * W + x])) skinL += lum[y * W + x];
    const mean = skinL / c.area;
    // the inner part of the box (not its outline, where hair and background begin), at double resolution
    const ix0 = 2 * (c.x0 + Math.floor((c.x1 - c.x0) * 0.15));
    const ix1 = 2 * (c.x1 - Math.floor((c.x1 - c.x0) * 0.15));
    const iy0 = 2 * (c.y0 + Math.floor((c.y1 - c.y0) * 0.15));
    const iy1 = 2 * (c.y1 - Math.floor((c.y1 - c.y0) * 0.15));
    let dark = 0;
    let inner = 0;
    for (let y = iy0; y <= iy1; y++) for (let x = ix0; x <= ix1; x++, inner++) if (hi[y * W * 2 + x] / 255 < mean * 0.78) dark++;
    return inner > 0 && dark / inner >= 0.012;
  };
  const candidates = regions
    .filter((c) => {
      const w = c.x1 - c.x0 + 1;
      const h = c.y1 - c.y0 + 1;
      const share = c.area / n;
      const fillRatio = c.area / (w * h);
      const aspect = h / w;
      // up to a quarter of the picture: a close portrait; larger skin areas are surfaces, not faces (the feature test guards the rest)
      // an ellipse fills about 79% of its box (less with the eyes and mouth cut out); a nearly solid rectangle is an object (a book spine, a tile)
      return c.area >= 6 && share >= 0.0003 && share <= 0.25 && fillRatio >= 0.35 && fillRatio <= 0.9 && aspect >= 0.6 && aspect <= 2.6 && hasFeatures(c);
    })
    .sort((a, b) => b.area - a.area);
  // hands and small skin patches are much smaller than the faces of the same photograph: they are not treated as faces. The reference is
  // the median of the largest candidates, so one oversized region (a face merged with skin-coloured clothing) does not hide the others.
  const top5 = candidates.slice(0, 5).map((c) => c.area);
  const reference = top5.length ? top5[Math.floor((top5.length - 1) / 2)] : 0;
  // one box per head: a fragment (a lit forehead, a cheek) that lies inside the head area of a larger face is part of that face
  const kept: typeof candidates = [];
  for (const c of candidates.filter((x) => x.area >= reference * 0.3)) {
    const inside = kept.some((k) => {
      const w = k.x1 - k.x0 + 1;
      const h = k.y1 - k.y0 + 1;
      const hx0 = k.x0 - w * 0.15;
      const hx1 = k.x1 + w * 0.15;
      const hy0 = k.y0 - h * 0.45;
      const hy1 = k.y1 + h * 0.1;
      const ov = Math.max(0, Math.min(c.x1, hx1) - Math.max(c.x0, hx0) + 1) * Math.max(0, Math.min(c.y1, hy1) - Math.max(c.y0, hy0) + 1);
      // only a clearly smaller piece counts as a fragment: a second person in the row behind is about as large and stays a face
      return c.area < k.area * 0.6 && ov >= 0.6 * (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1);
    });
    if (!inside) kept.push(c);
  }
  const faces: Box01[] = kept
    .slice(0, MAX_FACES)
    .map((c) => {
      // a face that merged with its neck is taller than a face: the box keeps the head (a face is about 1.4 times as tall as wide)
      const w = c.x1 - c.x0 + 1;
      const h = Math.min(c.y1 - c.y0 + 1, Math.round(w * 1.45));
      return [c.x0 / W, c.y0 / H, w / W, h / H] as Box01;
    });

  // a flat-looking picture WITH faces is a photograph of people (a smooth backdrop), not a graphic
  const graphic = flatLook && faces.length === 0;

  // the whole head (hair above, padding around) and the shoulders under every face: what a crop must keep together
  const people: Box01[] = faces.map(([x, y, w, h]) => {
    const x0 = clamp(x - w * 1.1);
    const x1 = clamp(x + w * 2.1);
    const y0 = clamp(y - h * 0.55);
    const y1 = clamp(y + h * 3.2);
    return [x0, y0, x1 - x0, y1 - y0];
  });

  // ---- how busy each part of the picture is (where text can sit) --------------------------------------------------------------------------
  const rowsB = Math.max(4, Math.round((BUSY_COLS * H) / W));
  const cellE = new Float64Array(BUSY_COLS * rowsB);
  const cellN = new Float64Array(BUSY_COLS * rowsB);
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      const e = (Math.abs(lum[i] - lum[i + 1]) + Math.abs(lum[i] - lum[i + W])) * 255;
      const k = Math.min(rowsB - 1, Math.floor((y / H) * rowsB)) * BUSY_COLS + Math.min(BUSY_COLS - 1, Math.floor((x / W) * BUSY_COLS));
      cellE[k] += e;
      cellN[k]++;
    }
  }
  const busy = { cols: BUSY_COLS, rows: rowsB, cells: Array.from(cellE, (e, k) => Math.round(clamp((cellN[k] ? e / cellN[k] : 0) / 22) * 100) / 100) };

  // ---- the subject: the people, else where the detail is -------------------------------------------------------------------------------------
  let subject = unionBox(people);
  if (!subject) {
    const colE = new Float64Array(W);
    const rowE = new Float64Array(H);
    let total = 0;
    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W - 1; x++) {
        const i = (y * W + x) * 3;
        const l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        const lr = data[i + 3] * 0.299 + data[i + 4] * 0.587 + data[i + 5] * 0.114;
        const ld = data[i + W * 3] * 0.299 + data[i + W * 3 + 1] * 0.587 + data[i + W * 3 + 2] * 0.114;
        const e = Math.abs(l - lr) + Math.abs(l - ld);
        colE[x] += e;
        rowE[y] += e;
        total += e;
      }
    }
    const span = (arr: Float64Array, len: number): [number, number] => {
      if (total <= 0) return [0.2, 0.8];
      let acc = 0;
      let lo = 0;
      let hi = len - 1;
      for (let i = 0; i < len; i++) {
        acc += arr[i];
        if (acc >= total * 0.15) {
          lo = i;
          break;
        }
      }
      acc = 0;
      for (let i = len - 1; i >= 0; i--) {
        acc += arr[i];
        if (acc >= total * 0.15) {
          hi = i;
          break;
        }
      }
      return [lo / len, Math.max(lo + 1, hi + 1) / len];
    };
    const [sx0, sx1] = graphic ? [0, 1] : span(colE, W);
    const [sy0, sy1] = graphic ? [0, 1] : span(rowE, H);
    subject = [sx0, sy0, sx1 - sx0, sy1 - sy0];
  }
  const r = (v: number) => Math.round(v * 10000) / 10000;
  const rb = (b: Box01): Box01 => [r(b[0]), r(b[1]), r(b[2]), r(b[3])];
  return { version: 2, faces: faces.map(rb), people: people.map(rb), subject: rb(subject), graphic, busy };
}
