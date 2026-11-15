import { MAX_UPSCALE } from '../creative/formats';
import type { PxRect, RenderReport, RenderSubject, UnitBox } from './schema';

/**
 * WHERE A PICTURE IS FRAMED INSIDE ITS BOX (pure: no pixels, no I/O). Used by the renderer to draw, and by the composition scorer to predict
 * the framing of a layout BEFORE anything is rendered, so both always agree.
 *
 *   cover    the picture fills the box; the crop window slides along its free axis (and, for photographs of people, may zoom in a little)
 *            to keep whole HEADS in the frame (a person left out entirely beats one cut in half), keep them out of `avoid` regions (panels,
 *            bands, text), keep the subject, and stay close to the focus point
 *   contain  a flat graphic whose letters a crop would cut is shown whole (letterboxed with its own border colour)
 */

export interface CropPlan {
  fit: 'cover' | 'contain';
  /** the picture scaled to sw x sh; cover: the box shows [left, left+bw) x [top, top+bh) of it; contain: it sits at (left, top) inside the box */
  sw: number;
  sh: number;
  left: number;
  top: number;
  /** share of the picture's area the crop leaves out */
  cropLoss: number;
  /** 1 = the smallest scale that covers the box; > 1 zoomed in on the people */
  zoom: number;
  subjectAware: boolean;
}

export interface CropInput {
  /** picture pixels (after EXIF rotation) */
  imgW: number;
  imgH: number;
  /** box pixels */
  bw: number;
  bh: number;
  focus: [number, number];
  /** where the box sits on the canvas (to place faces against `avoid`) */
  layerRect: PxRect;
  canvasW: number;
  canvasH: number;
  subject?: RenderSubject;
  /** canvas regions (fractions) the faces should stay out of */
  avoid?: UnitBox[];
  /** 'contain' shows the whole picture (the layout asked for it); default: cover */
  fit?: 'cover' | 'contain';
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const overlap1 = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** The head around a face box: hair above, a little room on the sides and under the chin (fractions of the picture). */
export const headOf = (f: UnitBox): UnitBox => [f[0] - f[2] * 0.25, f[1] - f[3] * 0.55, f[2] * 1.5, f[3] * 1.75];

const ZOOMS = [1, 1.15, 1.3, 1.5];

export function planCrop(c: CropInput): CropPlan {
  const { imgW, imgH, bw, bh, subject } = c;
  const base = Math.max(bw / imgW, bh / imgH);
  const coverLoss = 1 - (bw * bh) / (Math.max(bw, Math.ceil(imgW * base)) * Math.max(bh, Math.ceil(imgH * base)));
  if ((subject?.graphic && coverLoss > 0.04) || c.fit === 'contain') {
    const k = Math.min(bw / imgW, bh / imgH);
    const cw = Math.max(1, Math.round(imgW * k));
    const ch = Math.max(1, Math.round(imgH * k));
    return { fit: 'contain', sw: cw, sh: ch, left: Math.floor((bw - cw) / 2), top: Math.floor((bh - ch) / 2), cropLoss: 0, zoom: 1, subjectAware: true };
  }
  const plain = (z: number): CropPlan => {
    const sw = Math.max(bw, Math.ceil(imgW * base * z));
    const sh = Math.max(bh, Math.ceil(imgH * base * z));
    return { fit: 'cover', sw, sh, left: clamp(Math.round(c.focus[0] * sw - bw / 2), 0, sw - bw), top: clamp(Math.round(c.focus[1] * sh - bh / 2), 0, sh - bh), cropLoss: 1 - (bw * bh) / (sw * sh), zoom: z, subjectAware: false };
  };
  if (!subject) return plain(1);
  // a head box is clipped to the picture: hair cut off by the PHOTOGRAPHER is not something the crop can keep
  const heads = subject.faces.map(headOf).map(([x, y, w, h]): UnitBox => {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    return [x0, y0, Math.min(1, x + w) - x0, Math.min(1, y + h) - y0];
  });
  const avoid = (c.avoid ?? []).map((a) => ({ x0: a[0] * c.canvasW, y0: a[1] * c.canvasH, x1: (a[0] + a[2]) * c.canvasW, y1: (a[1] + a[3]) * c.canvasH }));
  // zooming in is only for photographs of people (a detail-based subject box is too rough to zoom on) and never beyond the upscale limit
  // and only for DISTANT people: when they take less than 15% of the frame at the base scale (a group that already fills it is never zoomed)
  const baseW = Math.max(bw, imgW * base);
  const baseH = Math.max(bh, imgH * base);
  const subjectShare = (subject.subject[2] * baseW * subject.subject[3] * baseH) / (bw * bh);
  const zooms = heads.length && subjectShare < 0.15 ? ZOOMS.filter((z) => base * z <= Math.max(MAX_UPSCALE, base)) : [1];
  let best: (CropPlan & { s: number }) | null = null;
  for (const z of zooms) {
    const p = plain(z);
    const { sw, sh } = p;
    const hb = heads.map((f) => ({ x0: f[0] * sw, y0: f[1] * sh, x1: (f[0] + f[2]) * sw, y1: (f[1] + f[3]) * sh }));
    const maxArea = Math.max(1, ...hb.map((f) => (f.x1 - f.x0) * (f.y1 - f.y0)));
    const sb = { x0: subject.subject[0] * sw, y0: subject.subject[1] * sh, x1: (subject.subject[0] + subject.subject[2]) * sw, y1: (subject.subject[1] + subject.subject[3]) * sh };
    const sArea = Math.max(1, (sb.x1 - sb.x0) * (sb.y1 - sb.y0));
    const score = (left: number, top: number) => {
      let s = 0;
      let whole = 0;
      for (const f of hb) {
        const area = Math.max(1, (f.x1 - f.x0) * (f.y1 - f.y0));
        const w = area / maxArea;
        const inside = (overlap1(f.x0, f.x1, left, left + bw) * overlap1(f.y0, f.y1, top, top + bh)) / area;
        if (inside >= 0.95) {
          s += w;
          whole++;
        } else if (inside <= 0.03) s -= 0.15 * w;
        else s -= 1.2 * w;
        if (inside > 0.03 && avoid.length) {
          const cx0 = c.layerRect.x + f.x0 - left;
          const cy0 = c.layerRect.y + f.y0 - top;
          const under = Math.max(...avoid.map((a) => (overlap1(cx0, cx0 + f.x1 - f.x0, a.x0, a.x1) * overlap1(cy0, cy0 + f.y1 - f.y0, a.y0, a.y1)) / area));
          s -= 1.5 * w * under;
        }
      }
      // a zoom must not cost a single person: it only wins when every head that fits at the base scale still fits
      s += 0.6 * ((overlap1(sb.x0, sb.x1, left, left + bw) * overlap1(sb.y0, sb.y1, top, top + bh)) / sArea);
      if (z > 1) s += 0.25 * Math.min(1, ((sb.x1 - sb.x0) * (sb.y1 - sb.y0)) / (bw * bh) / 0.45) - 0.08 * (z - 1);
      s -= 0.1 * (Math.abs(left - p.left) / Math.max(1, sw - bw) + Math.abs(top - p.top) / Math.max(1, sh - bh));
      return { s, whole };
    };
    const STEPS = 40;
    let local = { left: p.left, top: p.top, ...score(p.left, p.top) };
    for (let i = 0; i <= STEPS; i++) {
      for (let j = 0; j <= (sh - bh >= 2 && sw - bw >= 2 ? STEPS : 0); j++) {
        const left = sw - bw >= 2 ? Math.round(((sw - bw) * i) / STEPS) : p.left;
        const top = sh - bh >= 2 ? Math.round(((sh - bh) * (sw - bw >= 2 ? j : i)) / STEPS) : p.top;
        const r = score(left, top);
        if (r.s > local.s + 1e-9) local = { left, top, ...r };
      }
    }
    if (z > 1 && best && local.whole < (best as unknown as { whole: number }).whole) continue;
    const cand = { ...p, left: local.left, top: local.top, subjectAware: true, s: local.s, whole: local.whole } as CropPlan & { s: number; whole: number };
    if (!best || cand.s > best.s + 1e-9) best = cand;
  }
  const { s: _s, ...plan } = best as CropPlan & { s: number; whole?: number };
  void _s;
  delete (plan as { whole?: number }).whole;
  return plan;
}

/** A picture-fraction box -> pixels of the layer bitmap for a crop plan. */
export const mapToLayer = (p: CropPlan, b: UnitBox): PxRect => ({ x: b[0] * p.sw + (p.fit === 'contain' ? p.left : -p.left), y: b[1] * p.sh + (p.fit === 'contain' ? p.top : -p.top), w: b[2] * p.sw, h: b[3] * p.sh });

/**
 * WHAT A (SMALL) PICTURE FRAME SHOWS, from the crop geometry alone: for every detected face the share of its HEAD (hair and chin included)
 * inside the frame and whether the frame edge cuts it, the share of the subject (the people) inside it and of its width, how much of the box the
 * picture would fill shown whole. A small portrait frame cut out of a wide group photograph shows a slice of one person: judgeFrame says so.
 */
export function frameReport(rect: PxRect, plan: CropPlan, imgW: number, imgH: number, subject: RenderSubject | undefined, sameAsHero: boolean): Omit<NonNullable<RenderReport['secondary']>, 'layerId'> {
  const { w: bw, h: bh } = rect;
  const inside = (b: PxRect) => (overlap1(b.x, b.x + b.w, 0, bw) * overlap1(b.y, b.y + b.h, 0, bh)) / Math.max(1, b.w * b.h);
  const k = Math.min(bw / imgW, bh / imgH);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const faces = (subject?.faces ?? []).map((f) => {
    const share = inside(mapToLayer(plan, headOf(f)));
    const fb = mapToLayer(plan, f);
    return { inFrame: r3(share), area: r3((fb.w * fb.h) / (bw * bh)), edge: share > 0.02 && share < 0.98 };
  });
  let subjectInFrame: number | null = null;
  let subjectWidthShown: number | null = null;
  if (subject) {
    const sb = mapToLayer(plan, subject.subject);
    subjectInFrame = r3(inside(sb));
    subjectWidthShown = r3(Math.min(1, overlap1(sb.x, sb.x + sb.w, 0, bw) / Math.max(1, sb.w)));
  }
  return { rect, fit: plan.fit, cropLoss: r3(plan.cropLoss), faces, subjectInFrame, subjectWidthShown, sameAsHero, containFill: r3((imgW * k * imgH * k) / (bw * bh)) };
}

/** Thresholds of the frame judgement (MVP heuristics on a heuristic face detector: a fragment is a failure only with face evidence). */
export const FRAME = {
  /** a head inside the frame by more than this and less than `whole` is cut by the frame edge */
  cutLow: 0.15,
  whole: 0.85,
  /** faces smaller than this share of the largest one are background people (not judged) */
  keyFace: 0.3,
  /** without a whole face, less than this share of the people in the frame is a fragment */
  fragment: 0.5,
  /** without detected faces: a frame showing less than this share of the subject's width of a heavily cropped picture is reported */
  widthShown: 0.45,
  cropLoss: 0.5,
  /** showing the whole picture (contain) is acceptable only when it fills at least this share of the frame */
  containFill: 0.55,
} as const;

/**
 * Is the frame a MEANINGFUL, self-contained picture? fail = the evidence is reliable (the same photograph twice, a detected face cut by the edge,
 * people shown without any whole face); warn = only the rough subject box says the frame is a narrow slice of a wide picture (no face found, so
 * the detector may simply have missed it).
 */
export function judgeFrame(f: Pick<NonNullable<RenderReport['secondary']>, 'faces' | 'subjectInFrame' | 'subjectWidthShown' | 'sameAsHero' | 'cropLoss' | 'fit'>): { status: 'pass' | 'warn' | 'fail'; problems: string[] } {
  const problems: string[] = [];
  let status: 'pass' | 'warn' | 'fail' = 'pass';
  if (f.sameAsHero) {
    problems.push('the same photograph appears twice in one creative');
    status = 'fail';
  }
  const max = Math.max(0, ...f.faces.map((x) => x.area));
  const key = f.faces.filter((x) => x.area >= max * FRAME.keyFace && x.inFrame > 0.02);
  const cut = key.filter((x) => x.inFrame > FRAME.cutLow && x.inFrame < FRAME.whole);
  const whole = key.filter((x) => x.inFrame >= FRAME.whole);
  if (cut.length) {
    problems.push(`${cut.length === 1 ? 'a face is' : `${cut.length} faces are`} cut by the edge of the frame${whole.length ? '' : ' and no face is whole'}`);
    status = 'fail';
  } else if (f.faces.length && !whole.length && (f.subjectInFrame ?? 1) < FRAME.fragment) {
    problems.push(`only a fragment of the people is in the frame (${Math.round((f.subjectInFrame ?? 0) * 100)}% of them, no whole face)`);
    status = 'fail';
  } else if (!f.faces.length && f.fit === 'cover' && f.subjectWidthShown !== null && f.subjectWidthShown < FRAME.widthShown && f.cropLoss > FRAME.cropLoss) {
    problems.push(`the frame shows only ${Math.round(f.subjectWidthShown * 100)}% of the width of what the picture shows (a narrow slice of a wide picture)`);
    if (status === 'pass') status = 'warn';
  }
  return { status, problems };
}

export interface FrameCandidate {
  id: string;
  w: number;
  h: number;
  subject?: RenderSubject;
  /** how many creatives of the campaign already use it (fewer first) */
  uses: number;
}

/**
 * THE SECOND PICTURE FOR A SMALL FRAME: the assigned one when its frame is a meaningful picture; otherwise the approved photograph whose frame is
 * (a clean one first, then one with only a rough warning), never the main photograph again. Pure: predicted with the same crop planner the
 * renderer uses. `id: assigned` with a failing judgement means nothing better exists (the preflight and the layout choice take it from there).
 */
export function chooseSecondary(o: { rect: PxRect; canvasW: number; canvasH: number; heroId: string | null; assigned: FrameCandidate | null; others: FrameCandidate[] }): { id: string | null; replaced: boolean; problem: string | null } {
  const judge = (c: FrameCandidate) => {
    const plan = planCrop({ imgW: c.w, imgH: c.h, bw: Math.max(2, Math.round(o.rect.w)), bh: Math.max(2, Math.round(o.rect.h)), focus: [0.5, 0.5], layerRect: o.rect, canvasW: o.canvasW, canvasH: o.canvasH, subject: c.subject });
    return judgeFrame(frameReport({ ...o.rect, w: Math.max(2, Math.round(o.rect.w)), h: Math.max(2, Math.round(o.rect.h)) }, plan, c.w, c.h, c.subject, c.id === o.heroId));
  };
  const first = o.assigned ? judge(o.assigned) : null;
  if (o.assigned && first?.status === 'pass') return { id: o.assigned.id, replaced: false, problem: null };
  const others = o.others.filter((c) => c.id !== o.heroId && c.id !== o.assigned?.id).sort((a, b) => a.uses - b.uses || (a.id < b.id ? -1 : 1)).slice(0, 8);
  let warn: string | null = null;
  for (const c of others) {
    const j = judge(c);
    if (j.status === 'pass') return { id: c.id, replaced: !!o.assigned, problem: first?.problems[0] ?? null };
    if (j.status === 'warn' && !warn) warn = c.id;
  }
  if (o.assigned && first?.status === 'fail' && warn) return { id: warn, replaced: true, problem: first.problems[0] ?? null };
  // the very same photograph twice is never kept: without another picture the frame keeps the layout's own placeholder (the preflight reports it)
  if (o.assigned && o.assigned.id === o.heroId) return { id: warn, replaced: true, problem: first?.problems[0] ?? null };
  return { id: o.assigned?.id ?? null, replaced: false, problem: first && first.status !== 'pass' ? (first.problems[0] ?? null) : null };
}
