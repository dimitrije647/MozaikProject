import { formatClassOf, type FormatClass, type PxRect, type RenderReport } from './schema';

/**
 * CONTENT-AWARE SPACING (deterministic, geometric, no model, no pixels).
 *
 * Negative space should be intentional, not a side effect of missing content. A template is drawn for a typical amount of copy; when the copy
 * is short (one sentence in a body area made for seven lines, an optional field left out), the area the missing words would have filled stays
 * behind as a hole between elements that belong together (the explanation and its button), or as the empty lower half of a card.
 *
 * What is ACCIDENTAL (reported and corrected):
 *   - a gap between related elements of one column (same container) that is far larger than the composition's own rhythm (the median of its
 *     other gaps) AND is mostly made of designed-but-unfilled text area: the unused lower part of a body/support box or the area of an optional
 *     text slot that was left empty. A headline's own box never counts: a short headline in a large poster area is a design decision.
 *   - the space after (or before) a panel up to the first content of the next section, when it is mostly unfilled text area;
 *   - the empty end of a card whose content takes only its first part.
 * What is INTENTIONAL (never reported): billboard space, even airy rhythms (a pull quote with evenly spaced blocks), minimal posters (a
 * headline and a button far apart), any gap that a picture, a placeholder or a drawn card fills, text set on the photograph (the adaptive
 * variants place it), and gaps between different containers (a headline on a colour panel and the explanation below it).
 *
 * The correction only moves things VERTICALLY (alignment axes and the left/centre/right composition stay exactly as designed):
 *   panel_grow   the coloured panel right above the text group grows into the free space, the group moves down to its button, and the
 *                content of the panel is re-centred in it (a typical split: green headline panel + white explanation)
 *   center       the group above the gap moves down and the group below moves up by half each: one group, centred in its column
 *   card_shrink  a card shrinks to its content (its far edge moves in)
 */

type R = { x: number; y: number; w: number; h: number };

export interface SpacingItem {
  id: string;
  kind: 'text' | 'button' | 'logo';
  slot?: string;
  /** what is drawn (fractions of the canvas) */
  ink: R;
  /** the designed area (fractions) */
  box: R;
  valign?: 'top' | 'middle' | 'bottom';
  /** set at an angle (a tilted card): its column is left as designed (a vertical move would leave the tilt's axis) */
  rotated?: boolean;
}
export interface SpacingDecor {
  id: string;
  type: string;
  r: R;
  opacity: number;
  gradient: boolean;
}
export interface SpacingScene {
  width: number;
  height: number;
  items: SpacingItem[];
  decor: SpacingDecor[];
  /** the picture area (or a placeholder picture area): content, never a gap */
  picture: R | null;
  /** designed areas of optional text slots that stayed empty */
  empty: R[];
  /** safe area (fractions) */
  safe: { t: number; b: number };
}
export interface SpacingOptions {
  kind?: string | null;
  fastScroll?: boolean;
  /** the template's declared density: an airy template earns more room before space counts as accidental */
  density?: 'airy' | 'balanced' | 'dense' | null;
}
/** A geometric change of one layer: relative (dy/dh) or the new absolute top/height of its box (y/h), as fractions. */
export interface SpacingMove {
  dy?: number;
  dh?: number;
  y?: number;
  h?: number;
  /** a small accent that belonged to a text left out (the bar above a missing explanation) is left out with it */
  hide?: boolean;
}
export interface SpacingIssue {
  type: 'gap' | 'panel_gap' | 'card_gap';
  /** the empty distance, as a share of the canvas height */
  gap: number;
  /** the composition's own rhythm (median of the other gaps of the column) */
  typical: number;
  /** share of the gap that is designed-but-unfilled text area */
  unfilled: number;
  above: string[];
  below: string[];
  container: string | null;
  /** the panel whose edge bounds the gap (panel_gap, card_gap) */
  panel: string | null;
  fix: { strategy: 'panel_grow' | 'center' | 'card_shrink'; moves: Record<string, SpacingMove> } | null;
}

const area = (r: R) => Math.max(0, r.w) * Math.max(0, r.h);
const ov = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const inter = (a: R, b: R) => ov(a.x, a.x + a.w, b.x, b.x + b.w) * ov(a.y, a.y + a.h, b.y, b.y + b.h);
const bottom = (r: R) => r.y + r.h;
const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r3 = (v: number) => Math.round(v * 10000) / 10000;
/**
 * Text slots whose designed area holds RUNNING copy: when they are short, the rest of their box is missing content. Display slots (the headline,
 * a big number, an offer, a quote) are sized by design: their empty box is a typographic decision, never counted.
 */
const BODY_SLOTS = new Set(['support', 'offerDetail', 'statLabel', 'attribution', 'date', 'location', 'eyebrow', 'tag']);

/** Cards of a structured layout (3+ same-size rects in a row or a column: steps, tiles): they are content, never a panel that grows or shrinks. */
function cardIds(decor: SpacingDecor[]): Set<string> {
  const rects = decor.filter((d) => d.type === 'rect' && d.opacity > 0 && area(d.r) >= 0.003 && area(d.r) <= 0.3);
  const out = new Set<string>();
  for (const c of rects) {
    const same = rects.filter((o) => Math.abs(o.r.w - c.r.w) / c.r.w < 0.15 && Math.abs(o.r.h - c.r.h) / c.r.h < 0.15 && (Math.abs(o.r.x - c.r.x) < 0.02 || Math.abs(o.r.y - c.r.y) < 0.02));
    if (same.length >= 3) same.forEach((o) => out.add(o.id));
  }
  return out;
}

/** How much empty room counts as accidental, by medium and format; null = never (a billboard may stay sparse). */
export function spacingLimits(o: SpacingOptions, cls: FormatClass): { abs: number; ratio: number } | null {
  if (o.kind === 'billboard') return null;
  const social = (o.kind ?? 'social_post') === 'social_post';
  const mobile = !!o.fastScroll || (social && (cls === 'story' || cls === 'portrait'));
  let abs = cls === 'banner' ? 0.3 : mobile ? 0.11 : o.kind === 'flyer' ? 0.12 : o.kind === 'web_ad' || o.kind === 'display_ad' ? 0.15 : 0.13;
  let ratio = 2.2;
  if (o.density === 'airy') {
    abs *= 1.6;
    ratio = 3.4;
  }
  return { abs, ratio };
}

/** The scene of a rendered creative (what the renderer really drew). */
export function sceneFromReport(r: RenderReport): SpacingScene {
  const W = r.width;
  const H = r.height;
  const f = (p: PxRect): R => ({ x: p.x / W, y: p.y / H, w: p.w / W, h: p.h / H });
  const items: SpacingItem[] = [
    ...r.texts
      .filter((t) => t.slot !== 'brand' && !t.layerId.includes(':') && !/^point\d$/.test(t.slot))
      .map((t) => ({ id: t.layerId, kind: 'text' as const, slot: t.slot, ink: f(t.rect), box: f(t.box ?? t.rect), valign: t.valign, rotated: !!t.rotated })),
    ...r.buttons.map((b) => ({ id: b.layerId, kind: 'button' as const, ink: f(b.rect), box: f(b.rect), rotated: !!b.rotated })),
    ...(r.logo ? [{ id: r.logo.layerId, kind: 'logo' as const, ink: f(r.logo.rect), box: f(r.logo.rect) }] : []),
  ];
  const placeholder = r.decor.find((d) => d.type === 'placeholder');
  return {
    width: W,
    height: H,
    items,
    decor: r.decor.filter((d) => d.type !== 'placeholder').map((d) => ({ id: d.layerId, type: d.type, r: f(d.rect), opacity: d.opacity, gradient: !!d.gradient })),
    picture: r.hero ? f(r.hero.rect) : placeholder ? f(placeholder.rect) : null,
    empty: (r.emptySlots ?? []).filter((e) => e.slot !== 'headline').map((e) => f(e.rect)),
    safe: { t: r.safe.t / H, b: r.safe.b / H },
  };
}

type Row = { items: SpacingItem[]; y0: number; y1: number; container: string | null; logoOnly: boolean };
type Entry = { kind: 'row'; row: Row; y0: number; y1: number } | { kind: 'edge'; panel: SpacingDecor; side: 'top' | 'bottom'; y0: number; y1: number };

/**
 * The accidental gaps of a composition, each with the correction that closes it (null when nothing can be moved safely), largest first.
 * At most one issue per column is returned with a fix (the next round of the repair loop measures again).
 */
export function spacingIssues(scene: SpacingScene, opts: SpacingOptions = {}): SpacingIssue[] {
  const lim = spacingLimits(opts, formatClassOf(scene.width, scene.height));
  if (!lim) return [];
  const cards = cardIds(scene.decor);
  const panels = scene.decor.filter((d) => ['rect', 'ellipse', 'polygon'].includes(d.type) && d.opacity >= 0.5 && !d.gradient && !cards.has(d.id) && area(clip(d.r)) >= 0.01 && area(clip(d.r)) <= 0.85);
  const containerOf = (it: SpacingItem): string | null => {
    let best: SpacingDecor | null = null;
    for (const p of panels) if (inter(p.r, it.ink) >= area(it.ink) * 0.6 && (!best || area(p.r) < area(best.r))) best = p;
    return best?.id ?? null;
  };
  // ---- columns: elements whose designed areas share their horizontal range
  const items = scene.items.filter((it) => area(it.ink) > 0);
  const xr = (it: SpacingItem) => (it.kind === 'text' ? it.box : it.ink);
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = xr(items[i]);
      const b = xr(items[j]);
      if (ov(a.x, a.x + a.w, b.x, b.x + b.w) >= 0.5 * Math.min(a.w, b.w)) parent[find(i)] = find(j);
    }
  const columns = new Map<number, SpacingItem[]>();
  items.forEach((it, i) => columns.set(find(i), [...(columns.get(find(i)) ?? []), it]));

  const out: SpacingIssue[] = [];
  for (const col of columns.values()) {
    if (col.length < 2 || col.some((it) => it.rotated)) continue;
    // text set on the picture is placed by the adaptive variants (negative space of the photograph): not this mechanism's business
    if (scene.picture && col.some((it) => it.kind !== 'logo' && inter(it.ink, scene.picture!) > area(it.ink) * 0.2)) continue;
    const cx0 = Math.min(...col.map((it) => xr(it).x));
    const cx1 = Math.max(...col.map((it) => xr(it).x + xr(it).w));
    // rows: elements sharing a vertical band (a button and the logo in a footer row)
    const rows: Row[] = [];
    for (const it of [...col].sort((a, b) => a.ink.y - b.ink.y)) {
      const row = rows.find((r) => ov(r.y0, r.y1, it.ink.y, bottom(it.ink)) > 0.4 * Math.min(r.y1 - r.y0, it.ink.h));
      if (row) {
        row.items.push(it);
        row.y0 = Math.min(row.y0, it.ink.y);
        row.y1 = Math.max(row.y1, bottom(it.ink));
      } else rows.push({ items: [it], y0: it.ink.y, y1: bottom(it.ink), container: null, logoOnly: false });
    }
    for (const r of rows) {
      const main = r.items.filter((x) => x.kind !== 'logo').sort((a, b) => area(b.ink) - area(a.ink))[0];
      r.logoOnly = !main;
      r.container = main ? containerOf(main) : null;
    }
    // panel edges that cross the whole column (a split's seam, a card's top and bottom)
    const edges: Entry[] = [];
    for (const p of panels) {
      if (p.type !== 'rect' || area(clip(p.r)) < 0.04 || ov(p.r.x, p.r.x + p.r.w, cx0, cx1) < 0.8 * (cx1 - cx0)) continue;
      const inRow = (y: number) => rows.some((r) => y > r.y0 + 0.002 && y < r.y1 - 0.002);
      if (p.r.y > 0.005 && !inRow(p.r.y)) edges.push({ kind: 'edge', panel: p, side: 'top', y0: p.r.y, y1: p.r.y });
      if (bottom(p.r) < 0.995 && !inRow(bottom(p.r))) edges.push({ kind: 'edge', panel: p, side: 'bottom', y0: bottom(p.r), y1: bottom(p.r) });
    }
    const seq: Entry[] = [...rows.map((row) => ({ kind: 'row' as const, row, y0: row.y0, y1: row.y1 })), ...edges].sort((a, b) => a.y0 - b.y0 || (a.kind === 'edge' ? -1 : 1));
    const gaps = seq.slice(1).map((b, i) => ({ a: seq[i], b, gap: b.y0 - seq[i].y1 }));
    // the composition's rhythm: the gaps between its rows of content (the distance to a panel edge is a different, designed measure)
    const rhythm = gaps.filter((g) => g.gap > 0.004 && g.a.kind === 'row' && g.b.kind === 'row');
    const cands: SpacingIssue[] = [];
    for (const g of gaps) {
      const { a, b, gap } = g;
      if (gap <= 0.02) continue;
      let type: SpacingIssue['type'] | null = null;
      let container: string | null = null;
      if (a.kind === 'row' && b.kind === 'row') {
        if (a.row.logoOnly || b.row.logoOnly || a.row.container !== b.row.container) continue;
        type = 'gap';
        container = a.row.container;
      } else if (a.kind === 'edge' && b.kind === 'row') {
        if (b.row.logoOnly) continue;
        if (a.side === 'bottom' && b.row.container !== a.panel.id) type = 'panel_gap';
        else if (a.side === 'top' && b.row.container === a.panel.id) type = 'card_gap';
        container = b.row.container;
      } else if (a.kind === 'row' && b.kind === 'edge') {
        if (a.row.logoOnly) continue;
        if (b.side === 'top' && a.row.container !== b.panel.id) type = 'panel_gap';
        else if (b.side === 'bottom' && a.row.container === b.panel.id) type = 'card_gap';
        container = a.row.container;
      }
      if (!type) continue;
      // the composition's own rhythm: the other gaps of the column (for a card: the margin on its other side)
      let typical = Math.max(0.02, median(rhythm.filter((x) => x !== g).map((x) => x.gap)));
      if (type === 'card_gap') {
        const panel = (a.kind === 'edge' ? a.panel : (b as Extract<Entry, { kind: 'edge' }>).panel).r;
        const inside = rows.filter((r) => r.container === (a.kind === 'edge' ? a.panel.id : (b as Extract<Entry, { kind: 'edge' }>).panel.id));
        const other = a.kind === 'edge' ? bottom(panel) - Math.max(...inside.map((r) => r.y1)) : Math.min(...inside.map((r) => r.y0)) - panel.y;
        typical = Math.max(0.02, other);
      }
      if (gap <= lim.abs || gap <= lim.ratio * typical) continue;
      if (type === 'card_gap') {
        const pe = a.kind === 'edge' ? a : (b as Extract<Entry, { kind: 'edge' }>);
        const edgeY = pe.y0;
        // a tile of a grid: another panel ends (or starts) on the same line - shrinking this one would break the grid
        if (scene.decor.some((d) => d.id !== pe.panel.id && d.opacity >= 0.3 && area(d.r) >= 0.005 && d.type !== 'line' && (Math.abs(bottom(d.r) - edgeY) < 0.015 || Math.abs(d.r.y - edgeY) < 0.015) && area(d.r) < 0.85)) continue;
      }
      const band: R = { x: cx0, y: a.y1, w: cx1 - cx0, h: gap };
      const bandA = area(band);
      // something designed fills the gap: a picture, other elements, a card or a shape (a hairline or a faint shape does not)
      if (scene.picture && inter(scene.picture, band) > bandA * 0.1) continue;
      if (scene.items.some((it) => !col.includes(it) && inter(it.ink, band) > bandA * 0.05)) continue;
      if (scene.decor.some((d) => d.opacity >= 0.35 && d.type !== 'line' && d.type !== 'fill' && inter(d.r, band) >= bandA * 0.12 && inter(d.r, band) < bandA * 0.9)) continue;
      // how much of the gap is designed-but-unfilled text area (never the headline's own box)
      const spans: [number, number][] = [];
      const unfilledOf = (it: SpacingItem) => {
        if (it.kind !== 'text' || !BODY_SLOTS.has(it.slot ?? '')) return;
        if (bottom(it.box) > bottom(it.ink)) spans.push([bottom(it.ink), bottom(it.box)]);
        if (it.box.y < it.ink.y) spans.push([it.box.y, it.ink.y]);
      };
      if (a.kind === 'row') a.row.items.forEach(unfilledOf);
      if (b.kind === 'row') b.row.items.forEach(unfilledOf);
      for (const e of scene.empty) if (ov(e.x, e.x + e.w, cx0, cx1) > 0.3 * Math.min(e.w, cx1 - cx0)) spans.push([e.y, bottom(e)]);
      const unfilled = coverage(spans, a.y1, b.y0) / gap;
      if (unfilled < 0.35) continue;
      const target = type === 'card_gap' ? Math.max(typical, 0.03) : Math.min(0.06, Math.max(0.03, typical * 1.5));
      const fix = gap - target > 0.01 ? planFix(scene, { type, a, b, gap, target, rows, seq, cx0, cx1, typical, panels, containerOf }) : null;
      cands.push({
        type,
        gap: r3(gap),
        typical: r3(typical),
        unfilled: Math.round(unfilled * 100) / 100,
        above: a.kind === 'row' ? a.row.items.map((x) => x.id) : [a.panel.id],
        below: b.kind === 'row' ? b.row.items.map((x) => x.id) : [b.panel.id],
        container,
        panel: a.kind === 'edge' ? a.panel.id : b.kind === 'edge' ? b.panel.id : null,
        fix,
      });
    }
    cands.sort((x, y) => y.gap - x.gap);
    out.push(...cands.map((c, i) => (i === 0 ? c : { ...c, fix: null })));
  }
  return out.sort((x, y) => y.gap - x.gap);
}

const clip = (r: R): R => {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  return { x: x0, y: y0, w: Math.max(0, Math.min(1, r.x + r.w) - x0), h: Math.max(0, Math.min(1, r.y + r.h) - y0) };
};

/** Length of the union of intervals inside [lo, hi]. */
function coverage(spans: [number, number][], lo: number, hi: number): number {
  const c = spans.map(([a, b]) => [Math.max(lo, a), Math.min(hi, b)] as [number, number]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const s of c) {
    if (!cur || s[0] > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [...s];
    } else cur[1] = Math.max(cur[1], s[1]);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

interface FixInput {
  type: SpacingIssue['type'];
  a: Entry;
  b: Entry;
  gap: number;
  /** the spacing the related elements should keep */
  target: number;
  rows: Row[];
  seq: Entry[];
  cx0: number;
  cx1: number;
  typical: number;
  panels: SpacingDecor[];
  containerOf: (it: SpacingItem) => string | null;
}

/** The correction of one accidental gap, or null when it cannot be made without touching the picture or leaving the safe area. */
function planFix(scene: SpacingScene, f: FixInput): SpacingIssue['fix'] {
  const { a, b, seq } = f;
  const moves: Record<string, SpacingMove> = {};
  const idxA = seq.indexOf(a);
  const idxB = seq.indexOf(b);
  const runGap = Math.max(0.06, f.typical * 2);
  // the group above the gap (rows of the same container, up to an edge, a logo-only row or a large gap) and the group below it
  const runOf = (from: number, dir: -1 | 1) => {
    const run: Row[] = [];
    let i = from;
    let stop: Entry | null = null;
    while (i >= 0 && i < seq.length) {
      const e = seq[i];
      if (e.kind !== 'row' || e.row.logoOnly) {
        stop = e;
        break;
      }
      if (run.length) {
        const prev = run[run.length - 1];
        const d = dir < 0 ? prev.y0 - e.y1 : e.y0 - prev.y1;
        if (e.row.container !== prev.container || d > runGap) {
          stop = e;
          break;
        }
      }
      run.push(e.row);
      i += dir;
    }
    return { run, stop };
  };
  const up = a.kind === 'row' ? runOf(idxA, -1) : { run: [] as Row[], stop: a as Entry | null };
  const down = b.kind === 'row' ? runOf(idxB, 1) : { run: [] as Row[], stop: b as Entry | null };
  const uTop = up.run.length ? Math.min(...up.run.map((r) => r.y0)) : a.y1;
  const dBottom = down.run.length ? Math.max(...down.run.map((r) => r.y1)) : b.y0;
  const upStopY = up.stop ? up.stop.y1 : scene.safe.t;
  const downStopY = down.stop ? down.stop.y0 : scene.safe.b;
  // small shapes of the column that belong to a group (an accent bar, a hairline, a seam strip): by where their centre lies
  const colDecor = scene.decor.filter((d) => {
    if (f.panels.some((p) => p.id === d.id && p.type === 'rect' && area(clip(p.r)) >= 0.04)) return false;
    if (d.type === 'fill' || d.r.h > 0.15 || (area(d.r) > 0.04 && d.r.h > 0.02)) return false;
    return ov(d.r.x, d.r.x + d.r.w, f.cx0, f.cx1) >= 0.5 * Math.max(0.001, d.r.w);
  });
  const mid = (d: SpacingDecor) => d.r.y + d.r.h / 2;
  const gapMid = (a.y1 + b.y0) / 2;
  const decorUp = colDecor.filter((d) => mid(d) >= upStopY - 0.002 && mid(d) <= a.y1);
  const decorDown = colDecor.filter((d) => mid(d) >= b.y0 && mid(d) <= downStopY + 0.002);
  // shapes INSIDE the gap (the hairline over the button): they keep their side and stay inside the new, smaller gap
  const inGap = colDecor.filter((d) => mid(d) > a.y1 && mid(d) < b.y0);
  // a hairline in the gap needs room on both sides
  const s = f.gap - (f.type === 'gap' && inGap.length ? Math.max(f.target, 0.05) : f.target);
  if (s <= 0.01) return null;
  const placeInGap = (dU: number, dD: number) => {
    const newA = a.y1 + dU;
    const newB = b.y0 + dD;
    const half = (newB - newA) / 2;
    for (const d of inGap) {
      if (moves[d.id]) continue;
      const m = mid(d);
      const nm = m - a.y1 < b.y0 - m ? newA + Math.min(m - a.y1, half) : newB - Math.min(b.y0 - m, half);
      moves[d.id] = { dy: r3(nm - m) };
    }
  };
  const moveText = (it: SpacingItem, dy: number, lo: number, hi: number) => {
    if (it.kind !== 'text') return void (moves[it.id] = { dy: r3(dy) });
    const by = it.box.y + dy;
    if (by >= lo - 0.0005 && by + it.box.h <= hi + 0.0005) return void (moves[it.id] = { dy: r3(dy) });
    // the designed box would reach past its neighbours or the safe area: it shrinks to the text it carries (the text keeps its place in it)
    const inkY = it.ink.y + dy;
    const pad = it.ink.h * 0.25;
    const va = it.valign ?? (it.ink.y - it.box.y <= bottom(it.box) - bottom(it.ink) ? 'top' : 'bottom');
    let y: number;
    let h: number;
    if (va === 'top') {
      y = Math.max(lo, by);
      h = Math.min(hi, Math.max(inkY + it.ink.h + pad, Math.min(hi, by + it.box.h))) - y;
      h = Math.max(h, inkY + it.ink.h + pad * 0.5 - y);
    } else if (va === 'bottom') {
      const b1 = Math.min(hi, bottom(it.box) + dy);
      y = Math.max(lo, Math.min(inkY - pad, by));
      h = Math.max(b1, inkY + it.ink.h) - y;
    } else {
      y = inkY - pad;
      h = it.ink.h + pad * 2;
    }
    moves[it.id] = { y: r3(y), h: r3(h) };
  };
  const shiftRows = (rows: Row[], dy: number, lo: number, hi: number) => {
    for (const r of rows) for (const it of r.items) moveText(it, dy, lo, hi);
  };
  const shiftDecor = (ds: SpacingDecor[], dy: number) => {
    for (const d of ds) if (!moves[d.id]) moves[d.id] = { dy: r3(dy) };
  };
  const touchesPicture = (r: R) => !!scene.picture && inter(scene.picture, r) > area(r) * 0.05;
  // the content of a panel that grows is re-centred in it (the logo keeps its corner)
  const recentre = (panelId: string, dy: number) => {
    for (const it of scene.items) if (it.kind !== 'logo' && !moves[it.id] && f.containerOf(it) === panelId) moves[it.id] = { dy: r3(dy) };
  };
  // a panel that grows must still look carried (the empty-panel check wants 20% of it covered): how far it may grow
  const maxGrow = (p: SpacingDecor) => {
    const content = scene.items.reduce((sum, it) => sum + (it.kind === 'logo' ? 0.5 : 1) * inter(it.ink, p.r), 0);
    return Math.max(0, content / 0.22 / Math.max(0.001, p.r.w) - p.r.h);
  };
  const edgeAbove = up.stop && up.stop.kind === 'edge' && up.stop.side === 'bottom' ? up.stop : null;
  const edgeBelow = down.stop && down.stop.kind === 'edge' && down.stop.side === 'top' ? down.stop : null;

  if (f.type === 'card_gap') {
    const panel = (a.kind === 'edge' ? a.panel : (b as Extract<Entry, { kind: 'edge' }>).panel);
    if (a.kind === 'row') {
      // the empty END of a card: its bottom edge moves up (with the shapes that sit on that edge)
      moves[panel.id] = { dh: r3(-s) };
      shiftDecor(colDecor.filter((d) => mid(d) > a.y1 && mid(d) <= bottom(panel.r) + 0.01 && d.id !== panel.id), -s);
    } else {
      moves[panel.id] = { dy: r3(s), dh: r3(-s) };
      shiftDecor(colDecor.filter((d) => mid(d) >= panel.r.y - 0.01 && mid(d) < b.y0 && d.id !== panel.id), s);
    }
    return { strategy: 'card_shrink', moves };
  }

  const aboveEdge = f.type === 'panel_gap' && a.kind === 'edge' ? a : edgeAbove && uTop - edgeAbove.y1 <= 0.12 ? edgeAbove : null;
  const belowEdge = f.type === 'panel_gap' && b.kind === 'edge' ? b : edgeBelow && edgeBelow.y0 - dBottom <= 0.12 ? edgeBelow : null;
  if (aboveEdge && aboveEdge.kind === 'edge') {
    // the panel above grows down into the free space; the group under it follows; the panel's content is re-centred
    const p = aboveEdge.panel;
    // the panel grows as far as it stays carried; the rest of the gap is closed by the group below moving up (the button comes to its text)
    const g = Math.min(s, maxGrow(p));
    const rest = s - g;
    const grown: R = { ...p.r, y: bottom(p.r), h: g };
    if (g >= s * 0.4 && !touchesPicture(grown) && (rest < 0.005 || down.run.length > 0)) {
      const s = g;
      moves[p.id] = { dh: r3(s) };
      if (rest >= 0.005) {
        shiftRows(down.run, -rest, b.y0 - rest - 0.004, Math.min(scene.safe.b, downStopY));
        shiftDecor(decorDown, -rest);
      }
      const newTop = b.y0 - rest - (f.type === 'panel_gap' ? 0 : 0.004);
      shiftRows(up.run, s, bottom(p.r) + s, b.kind === 'row' ? newTop : scene.safe.b);
      if (f.type === 'panel_gap') {
        // nothing between the panel and the next content: shapes on the panel's edge (a seam) follow it; an accent further down belonged to the
        // text that was left out (the bar above a missing explanation) and is left out with it
        // (shapes closer to the next content - the hairline over the button - belong to it and stay)
        for (const d of colDecor.filter((x) => mid(x) >= bottom(p.r) - 0.01 && mid(x) < gapMid)) moves[d.id] = d.r.y <= bottom(p.r) + 0.02 ? { dy: r3(s) } : { hide: true };
        if (rest >= 0.005) for (const d of colDecor.filter((x) => mid(x) >= gapMid && mid(x) < b.y0 && !moves[x.id])) moves[d.id] = { dy: r3(-rest) };
      } else {
        shiftDecor(colDecor.filter((d) => mid(d) >= bottom(p.r) - 0.01 && mid(d) <= a.y1), s);
        placeInGap(s, -rest);
      }
      recentre(p.id, s / 2);
      return { strategy: 'panel_grow', moves };
    }
  }
  if (belowEdge && belowEdge.kind === 'edge') {
    const p = belowEdge.panel;
    const grown: R = { ...p.r, y: p.r.y - s, h: s };
    if (maxGrow(p) >= s && !touchesPicture(grown)) {
      moves[p.id] = { dy: r3(-s), dh: r3(s) };
      shiftRows(down.run, -s, a.kind === 'row' ? a.y1 + 0.004 : scene.safe.t, p.r.y - s);
      if (f.type === 'panel_gap') {
        for (const d of colDecor.filter((x) => mid(x) > gapMid && mid(x) <= p.r.y + 0.01)) moves[d.id] = bottom(d.r) >= p.r.y - 0.02 ? { dy: r3(-s) } : { hide: true };
      } else {
        shiftDecor(colDecor.filter((d) => mid(d) >= b.y0 && mid(d) <= p.r.y + 0.01), -s);
        placeInGap(0, -s);
      }
      recentre(p.id, -s / 2);
      return { strategy: 'panel_grow', moves };
    }
  }
  if (f.type !== 'gap' || !up.run.length || !down.run.length) return null;
  // one group, centred where the two halves were: the upper half moves down, the lower half up
  const h = s / 2;
  const newUBottom = a.y1 + h;
  const newDTop = b.y0 - h;
  shiftRows(up.run, h, Math.max(scene.safe.t, upStopY), newDTop - 0.004);
  shiftRows(down.run, -h, newUBottom + 0.004, Math.min(scene.safe.b, downStopY));
  shiftDecor(decorUp, h);
  shiftDecor(decorDown, -h);
  placeInGap(h, -h);
  return { strategy: 'center', moves };
}

/** Moves of the next repair merged into those already applied (relative moves add up; an absolute box replaces). */
export function mergeMoves(prev: Record<string, SpacingMove> | undefined, next: Record<string, SpacingMove>): Record<string, SpacingMove> {
  const out: Record<string, SpacingMove> = { ...(prev ?? {}) };
  for (const [id, m] of Object.entries(next)) {
    const o = out[id] ?? {};
    if (m.hide) out[id] = { hide: true };
    else if (o.hide) continue;
    else if (m.y !== undefined || m.h !== undefined) out[id] = { y: m.y, h: m.h };
    else if (o.y !== undefined || o.h !== undefined) out[id] = { y: o.y !== undefined ? r3(o.y + (m.dy ?? 0)) : undefined, h: o.h !== undefined ? r3(o.h + (m.dh ?? 0)) : undefined };
    else out[id] = { dy: r3((o.dy ?? 0) + (m.dy ?? 0)), dh: r3((o.dh ?? 0) + (m.dh ?? 0)) };
  }
  return out;
}
