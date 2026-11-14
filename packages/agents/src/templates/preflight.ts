import { formatClassOf, type PxRect, type RenderReport, type RenderTune, type TextSlot, type UnitBox } from './schema';

/**
 * THE DESIGN PREFLIGHT (deterministic, no model). Every rendered creative is checked BEFORE it is accepted; a creative that fails is repaired
 * and rendered again inside the same run (the Creative Designer drives the loop: see runtime/programs/f4/designer.ts).
 *
 *   subject_visibility   the subject of the picture (the people, the product) is inside the frame and not hidden under panels or bands
 *   face_occlusion       no key face is covered by a panel, a band, a scrim or a text block
 *   face_crop            no key face is cut by the edge of the frame (a person left out entirely is acceptable; one cut in half is not)
 *   subject_size         the people are big enough to be seen (a group photo is not shrunk into a thumbnail tile)
 *   graphic_crop         a flat graphic (logo banner, text on colour) is never cropped (its letters would be cut)
 *   overlay_dominance    dark panels, scrims and bands leave enough of the picture visible
 *   logo_visibility      the logo is whole, inside the safe area, big enough and readable against what is behind it
 *   text_safe_area       all text and buttons are inside the safe margins
 *   text_fit             no text is cut ("Explore the…" is a failure, never accepted silently)
 *   headline_readability the headline and the call to action have enough contrast; a headline over a busy picture has a backing
 *   text_collision       text blocks, the button and the logo do not overlap each other
 *   final_asset_purity   no editor or preview element (slider arrows, carousel dots, selection handles, window chrome) is in the export
 *   template_fit         the template suits the picture it was given (a picture template without its picture is a mismatch)
 *   empty_panel          no large coloured panel carries nothing (a yellow block with only a small brand name in it wastes the canvas)
 *   photo_use            an approved photograph is shown, and shown large on a fast-scroll format (TikTok); a typography-only design
 *                        while a photograph exists fails there and is reported elsewhere
 *   text_density         the visual carries no more text than its platform allows (words and text blocks; type filling a fast-scroll frame)
 *   text_space           text set on a large panel uses it (a few small lines alone on a big card leave meaningless empty space)
 *   logo_treatment       the logo sits directly on the creative or recoloured; a box behind it (only when nothing else made it read) is reported
 *   empty_structure      the cards, rows or steps of a structured layout carry their content (TikTok/story/portrait posts must look finished;
 *                        a billboard may stay sparse)
 *   placeholder_picture  no picture area shows only its placeholder pattern because there is no picture (mobile: a failure)
 *   unused_space         a mobile visual uses its canvas (text, picture and filled cards cover a reasonable share of it)
 *
 * Categories (what the Quality Reviewer reports): text, image, crop, occlusion, logo, safe_area, template_mismatch, ui_contamination, duplicate_layout.
 */

export const CHECK_CATEGORIES = ['text', 'image', 'crop', 'occlusion', 'logo', 'safe_area', 'template_mismatch', 'ui_contamination', 'duplicate_layout', 'alignment', 'media', 'composition'] as const;
export type CheckCategory = (typeof CHECK_CATEGORIES)[number];

export interface DesignCheck {
  id: string;
  category: CheckCategory;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail: string;
  /** layers involved (for the repair) */
  layers?: string[];
}

export interface PreflightResult {
  passed: boolean;
  checks: DesignCheck[];
  failures: DesignCheck[];
}

export interface RepairAction {
  kind: 'crop' | 'opacity' | 'position' | 'size' | 'hide' | 'backing' | 'template' | 'copy';
  target: string;
  detail: string;
}

/**
 * Layer ids that are editor or preview furniture, never part of a finished advertisement: slider/carousel arrows and dots, selection handles,
 * window chrome, scroll bars, cursors, play buttons, progress knobs, grey skeleton bars that imitate text.
 */
export const UI_LAYER_PATTERN = /^(handle-\d+|nav(-|$)|arrow-(left|right|prev|next)|slider(-|$)|pager(-|$)|page-dot|carousel(-|$)|swipe(-|$)|scrollbar|cursor(-|$)|play-button|progress(-|$)|knob|window-dot|traffic-|compare-(handle|chevron|knob)|skeleton|step-\d+-bar\d|chip-bar\d)/;

export const THRESHOLDS = {
  faceVisibility: 0.68,
  subjectVisibility: 0.55,
  subjectInFrame: 0.6,
  pictureVisibility: 0.38,
  faceCutLow: 0.15,
  faceCutHigh: 0.85,
  /** visible subject area as a share of the canvas, below which a photograph of people reads as a thumbnail */
  subjectShare: 0.1,
  /** the largest face's height as a share of the canvas height (a portrait passes on this alone) */
  faceHeight: 0.06,
  /** a face below this visibility is hidden entirely (behind an opaque card): left out, not "covered" */
  faceHidden: 0.15,
  logoVisual: 0.07,
  logoMinSide: 0.018,
  logoContrast: 2.2,
  textContrast: 0.85,
  busy: 0.16,
  overlap: 0.08,
  edgeTolerance: 1.5,
} as const;

const area = (r: PxRect) => Math.max(0, r.w) * Math.max(0, r.h);
const inter = (a: PxRect, b: PxRect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const pct = (v: number) => `${Math.round(v * 100)}%`;

export interface PreflightInput {
  report: RenderReport;
  flags: string[];
  /** painted layer ids */
  layers: string[];
  /** a real logo file was supplied */
  hasLogo: boolean;
  /** a picture was assigned to this creative */
  hasPicture: boolean;
  /** the template draws a picture */
  templateHasImage: boolean;
  /**
   * The medium of the creative. Print is not a screen: a billboard or a flyer carries no clickable button, and a billboard must say WHO is
   * advertising in full (a symbol alone does not); `logoSpellsName` = the approved logo file is a wide wordmark that already spells the name.
   */
  media?: {
    kind: string | null;
    logoSpellsName: boolean;
    /** a fast-scroll format (a TikTok cover): picture first, little text */
    fastScroll?: boolean;
    /** the platform's text budget for the visual (social posts) */
    textBudget?: { maxWords: number; maxBlocks: number } | null;
    /** an approved PHOTOGRAPH was assigned to this creative (drawn or not) */
    pictureIsPhoto?: boolean;
  } | null;
}

/** Thresholds of the composition checks (MVP heuristics). */
export const COMPOSITION = {
  /** an opaque panel of at least this share of the canvas whose content covers less than `panelFilled` of it is empty */
  emptyPanel: 0.08,
  panelMin: 0.06,
  panelFilled: 0.2,
  /** a fast-scroll photograph should cover at least this share of the canvas (visible part) */
  fastScrollPhoto: 0.35,
  /** a fast-scroll headline should not cover more than this share of the canvas */
  fastScrollHeadline: 0.3,
  /** text on a panel of at least `textPanel` of the canvas should fill at least `textFill` of it */
  textPanel: 0.2,
  textFill: 0.1,
  /** a placeholder picture area of at least this share of the canvas is reported */
  placeholder: 0.12,
  /** a mobile visual whose text, picture and filled cards cover less than this share of the canvas has much unused space */
  mobileCoverage: 0.12,
} as const;

/** The faces that matter: whole-or-nearly in the frame candidates of a reasonable size (at least 30% of the largest face). */
function keyFaces(r: RenderReport) {
  const faces = r.hero?.faces ?? [];
  const max = Math.max(0, ...faces.map((f) => f.area));
  return faces.filter((f) => f.area >= max * 0.3);
}

export function preflight(input: PreflightInput): PreflightResult {
  const { report: r, flags } = input;
  const unit = Math.min(r.width, r.height);
  const checks: DesignCheck[] = [];
  const add = (c: DesignCheck) => checks.push(c);
  const hero = r.hero;
  const texts = [...r.texts.map((t) => ({ id: t.layerId, rect: t.rect, kind: 'text' as const })), ...r.buttons.map((b) => ({ id: b.layerId, rect: b.rect, kind: 'button' as const }))];
  // what must never sit on a face: the text, the button and the logo
  const onFace = [...texts, ...(r.logo ? [{ id: r.logo.layerId, rect: r.logo.rect, kind: 'logo' as const }] : [])];

  // ---- the picture -----------------------------------------------------------------------------------------------------------------------------
  if (!hero) {
    const missing = input.templateHasImage && input.hasPicture;
    add({ id: 'subject_visibility', category: 'occlusion', status: 'skip', detail: 'No picture in this creative.' });
    add({ id: 'face_occlusion', category: 'occlusion', status: 'skip', detail: 'No picture in this creative.' });
    add({ id: 'face_crop', category: 'crop', status: 'skip', detail: 'No picture in this creative.' });
    add({ id: 'template_fit', category: 'template_mismatch', status: missing ? 'fail' : 'pass', detail: missing ? 'The template has a picture area but the picture was not drawn.' : 'The template suits the content it was given.' });
  } else {
    const faces = keyFaces(r);
    const occluders = (rect: PxRect) => [
      ...r.decor.filter((d) => d.afterHero && d.opacity > 0.15 && inter(d.rect, rect) > area(rect) * 0.05).map((d) => d.layerId),
      ...onFace.filter((t) => inter(t.rect, rect) > area(rect) * 0.12).map((t) => t.id),
    ];
    // subject
    if (hero.subjectVisibility === null && !faces.length) add({ id: 'subject_visibility', category: 'occlusion', status: 'skip', detail: 'The subject could not be measured (rotated picture or no subject information).' });
    else {
      const sv = hero.subjectVisibility ?? 1;
      const ok = sv >= THRESHOLDS.subjectVisibility && hero.subjectInFrame >= THRESHOLDS.subjectInFrame;
      add({ id: 'subject_visibility', category: hero.subjectInFrame < THRESHOLDS.subjectInFrame ? 'crop' : 'occlusion', status: ok ? 'pass' : 'fail', detail: `${pct(hero.subjectInFrame)} of the subject is in the frame and ${pct(sv)} of it stays visible (needs ${pct(THRESHOLDS.subjectInFrame)} and ${pct(THRESHOLDS.subjectVisibility)}).`, layers: ok ? undefined : [...new Set(r.decor.filter((d) => d.afterHero && d.opacity > 0.15 && inter(d.rect, hero.rect) > 0).map((d) => d.layerId))] });
    }
    // faces
    if (!faces.length) {
      add({ id: 'face_occlusion', category: 'occlusion', status: 'skip', detail: 'No faces were found in the picture.' });
      add({ id: 'face_crop', category: 'crop', status: 'skip', detail: 'No faces were found in the picture.' });
    } else {
      const largestFace = faces.reduce((a, b) => (b.area > a.area ? b : a));
      // a face hidden ENTIRELY behind an opaque card is left out of the picture like one outside the frame (acceptable, except the most
      // prominent face); a face PARTLY covered by a panel, a band, a scrim or a text block is the failure
      const hidden = (f: (typeof faces)[number]) => (f.visibility ?? 1) <= THRESHOLDS.faceHidden && f !== largestFace;
      const shown = faces.filter((f) => f.inFrame >= 0.5 && !hidden(f));
      const covered = shown.filter((f) => (f.visibility ?? 1) < THRESHOLDS.faceVisibility || onFace.some((t) => inter(t.rect, f.rect) > area(f.rect) * 0.12));
      add({ id: 'face_occlusion', category: 'occlusion', status: covered.length ? 'fail' : 'pass', detail: covered.length ? `${covered.length} of ${shown.length} visible face(s) are covered by ${[...new Set(covered.flatMap((f) => occluders(f.rect)))].join(', ') || 'an overlay'} (each needs ${pct(THRESHOLDS.faceVisibility)} visibility).` : `All ${shown.length} visible face(s) are clear.`, layers: [...new Set(covered.flatMap((f) => occluders(f.rect)))] });
      const cut = faces.filter((f) => f.inFrame > THRESHOLDS.faceCutLow && f.inFrame < THRESHOLDS.faceCutHigh);
      // the most prominent people (faces about as large as the largest): at least one of them must be fully in the frame
      const maxArea = Math.max(...faces.map((f) => f.area));
      const prominentIn = faces.some((f) => f.area >= maxArea * 0.85 && f.inFrame >= THRESHOLDS.faceCutHigh);
      const ok = !cut.length && prominentIn;
      add({ id: 'face_crop', category: 'crop', status: ok ? 'pass' : 'fail', detail: ok ? `No face is cut by the frame (${faces.filter((f) => f.inFrame >= THRESHOLDS.faceCutHigh).length} of ${faces.length} key face(s) fully in).` : `${cut.length} face(s) are cut by the frame${prominentIn ? '' : ' and none of the most prominent people is fully in it'}.` });
      const tallest = Math.max(...faces.map((f) => f.rect.h)) / r.height;
      const big = hero.subjectShare >= THRESHOLDS.subjectShare || tallest >= THRESHOLDS.faceHeight;
      add({ id: 'subject_size', category: 'image', status: big ? 'pass' : 'fail', detail: `The people take ${pct(hero.subjectShare)} of the creative; the largest face is ${pct(tallest)} of its height${big ? '' : ' (shrunk into a thumbnail)'}.` });
    }
    if (hero.graphic) add({ id: 'graphic_crop', category: 'crop', status: hero.fit === 'contain' || hero.cropLoss <= 0.04 ? 'pass' : 'fail', detail: hero.fit === 'contain' ? 'The graphic is shown whole (fitted, not cropped).' : `The graphic is cropped by ${pct(hero.cropLoss)}: its letters may be cut.` });
    if (hero.pictureVisibility !== null) {
      const ok = hero.pictureVisibility >= THRESHOLDS.pictureVisibility;
      const heavy = r.decor.filter((d) => d.afterHero && d.opacity >= 0.35 && inter(d.rect, hero.rect) > area(hero.rect) * 0.1).map((d) => d.layerId);
      add({ id: 'overlay_dominance', category: 'occlusion', status: ok ? 'pass' : 'fail', detail: `${pct(hero.pictureVisibility)} of the picture stays visible under the overlays (needs ${pct(THRESHOLDS.pictureVisibility)}).`, layers: ok ? undefined : heavy });
    }
    // a layout made for TWO pictures that got one shows an empty placeholder panel where the second should be: that is a preview, not an ad
    const emptySecond = flags.includes('secondary_missing_fallback') && input.hasPicture;
    add({ id: 'template_fit', category: 'template_mismatch', status: emptySecond ? 'fail' : flags.includes('image_low_resolution:hero') ? 'warn' : 'pass', detail: emptySecond ? 'The layout has a second picture area that stays an empty placeholder (only one picture is available).' : flags.includes('image_low_resolution:hero') ? 'The picture is enlarged more than it should be for this format.' : 'The template suits the picture.' });
  }

  // ---- the logo --------------------------------------------------------------------------------------------------------------------------------
  const lg = r.logo;
  if (!lg) add({ id: 'logo_visibility', category: 'logo', status: 'skip', detail: 'This template has no logo area.' });
  else {
    const problems: string[] = [];
    const inside = lg.rect.x >= -0.5 && lg.rect.y >= -0.5 && lg.rect.x + lg.rect.w <= r.width + 0.5 && lg.rect.y + lg.rect.h <= r.height + 0.5;
    const tol = THRESHOLDS.edgeTolerance;
    const safe = lg.rect.x >= r.safe.l - tol && lg.rect.y >= r.safe.t - tol && lg.rect.x + lg.rect.w <= r.safe.r + tol && lg.rect.y + lg.rect.h <= r.safe.b + tol;
    if (!inside) problems.push('it is cut by the edge of the creative');
    else if (!safe) problems.push('it is too close to the edge');
    if (lg.mode === 'logo') {
      const visual = Math.sqrt(area(lg.rect));
      if (visual < THRESHOLDS.logoVisual * unit || Math.min(lg.rect.w, lg.rect.h) < Math.max(12, THRESHOLDS.logoMinSide * unit)) problems.push(`it is too small (${Math.round(lg.rect.w)}x${Math.round(lg.rect.h)} px)`);
      if (lg.contrast < THRESHOLDS.logoContrast) problems.push(`it does not stand out from what is behind it (contrast ${lg.contrast})`);
    } else if (input.hasLogo) problems.push('the logo file could not be drawn, so the business name stands in for it');
    add({ id: 'logo_visibility', category: 'logo', status: problems.length ? 'fail' : 'pass', detail: problems.length ? `Logo: ${problems.join('; ')}.` : `The ${lg.mode === 'logo' ? 'logo' : 'business name'} is whole, inside the safe area and readable.`, layers: [lg.layerId] });
  }

  // ---- text --------------------------------------------------------------------------------------------------------------------------------
  const tol = THRESHOLDS.edgeTolerance;
  const outside = texts.filter((t) => t.rect.x < r.safe.l - tol - t.rect.h * 0.15 || t.rect.y < r.safe.t - tol - t.rect.h * 0.15 || t.rect.x + t.rect.w > r.safe.r + tol + t.rect.h * 0.15 || t.rect.y + t.rect.h > r.safe.b + tol + t.rect.h * 0.15);
  add({ id: 'text_safe_area', category: 'safe_area', status: outside.length ? 'fail' : 'pass', detail: outside.length ? `Outside the safe margins: ${outside.map((t) => t.id).join(', ')}.` : 'All text and buttons are inside the safe margins.', layers: outside.map((t) => t.id) });
  const cut = [...r.texts.filter((t) => t.trimmed).map((t) => `${t.slot} (${t.layerId})`), ...r.buttons.filter((b) => b.trimmed).map((b) => `call to action (${b.layerId})`)];
  add({ id: 'text_fit', category: 'text', status: cut.length ? 'fail' : 'pass', detail: cut.length ? `Text was cut to fit: ${cut.join(', ')}.` : 'All text fits without being cut.', layers: [...r.texts.filter((t) => t.trimmed).map((t) => t.layerId), ...r.buttons.filter((b) => b.trimmed).map((b) => b.layerId)] });
  const MAIN: TextSlot[] = ['headline', 'offer', 'stat'];
  const weak = r.texts.filter((t) => MAIN.includes(t.slot) && (t.contrast < THRESHOLDS.textContrast || (t.busy > THRESHOLDS.busy && t.contrast < 0.95 && !t.backed)));
  add({ id: 'headline_readability', category: 'text', status: weak.length ? 'fail' : 'pass', detail: weak.length ? `Not readable enough: ${weak.map((t) => `${t.slot} (${pct(t.contrast)} of it reaches the contrast target${t.busy > THRESHOLDS.busy ? ', over a busy picture' : ''})`).join(', ')}.` : 'The headline reads clearly against what is behind it.', layers: weak.map((t) => t.layerId) });
  const boxes = [...texts, ...(lg ? [{ id: lg.layerId, rect: lg.rect, kind: 'logo' as const }] : [])];
  const clashes: string[] = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i];
    const b = boxes[j];
    if (inter(a.rect, b.rect) > Math.min(area(a.rect), area(b.rect)) * THRESHOLDS.overlap) clashes.push(`${a.id}/${b.id}`);
  }
  add({ id: 'text_collision', category: 'text', status: clashes.length ? 'fail' : 'pass', detail: clashes.length ? `Overlapping: ${clashes.join(', ')}.` : 'Text, button and logo do not overlap.', layers: [...new Set(clashes.flatMap((c) => c.split('/')))] });

  // ---- alignment: elements of one group follow its axis (a centred layout keeps its button centred); intentional asymmetry is not judged -----
  const misaligned: { id: string; mode: 'center' | 'left' | 'right'; x: number; off: number }[] = [];
  // (the labels inside cards/rows/steps, point1..3, are aligned within their cards, not with the text column)
  const group = r.texts.filter((t) => t.align && t.slot !== 'brand' && !/^point\d$/.test(t.slot) && t.layerId.indexOf(':') < 0);
  for (const mode of ['center', 'left', 'right'] as const) {
    const g = group.filter((t) => t.align === mode);
    if (!g.length || (mode === 'center' && g.length < 1)) continue;
    const axisOf = (q: PxRect) => (mode === 'center' ? q.x + q.w / 2 : mode === 'left' ? q.x : q.x + q.w);
    // the group's axis: centred texts share a centre, left texts a left edge (median, so one odd line does not move it)
    const xs = g.map((t) => axisOf(t.rect)).sort((a, b) => a - b);
    const axis = xs[Math.floor(xs.length / 2)];
    const col = { x0: Math.min(...g.map((t) => t.rect.x)), x1: Math.max(...g.map((t) => t.rect.x + t.rect.w)), y0: Math.min(...g.map((t) => t.rect.y)), y1: Math.max(...g.map((t) => t.rect.y + t.rect.h)) };
    // a centred group must really sit on one axis (texts within 3% of each other) before a button is held to it
    if (mode === 'center' && xs[xs.length - 1] - xs[0] > r.width * 0.03) continue;
    for (const b of r.buttons) {
      const inCol = Math.min(col.x1, b.rect.x + b.rect.w) - Math.max(col.x0, b.rect.x) > b.rect.w * 0.5;
      const near = b.rect.y >= col.y0 - r.height * 0.05 && b.rect.y <= col.y1 + r.height * 0.18;
      if (!inCol || !near) continue;
      const off = Math.abs(axisOf(b.rect) - axis);
      if (off > r.width * 0.025) misaligned.push({ id: b.layerId, mode, x: Math.round((mode === 'center' ? axis : axis) / r.width * 1000) / 1000, off: Math.round(off) });
    }
  }
  add({ id: 'alignment', category: 'alignment', status: misaligned.length ? 'fail' : 'pass', detail: misaligned.length ? `Off the axis of its group: ${misaligned.map((m) => `${m.id} (${m.off}px from the ${m.mode} axis)`).join(', ')}.` : 'Grouped elements follow their alignment.', layers: misaligned.map((m) => `${m.id}@${m.mode}@${m.x}`) });

  // ---- media: print is not a screen ------------------------------------------------------------------------------------------------------------
  const kind = input.media?.kind ?? null;
  if (kind === 'billboard' || kind === 'flyer') {
    add({ id: 'media_button', category: 'media', status: r.buttons.length ? 'fail' : 'pass', detail: r.buttons.length ? `A ${kind} cannot be clicked, but it shows a button (${r.buttons.map((b) => b.layerId).join(', ')}).` : `No web-style button on the ${kind}.`, layers: r.buttons.map((b) => b.layerId) });
    const named = !!r.logo && (r.logo.mode === 'name' || r.logo.name === true || !!input.media?.logoSpellsName);
    add({ id: 'brand_identity', category: 'media', status: named ? 'pass' : kind === 'billboard' ? 'fail' : 'warn', detail: named ? 'The business is named in full.' : `The ${kind} does not show the business name in full (${r.logo ? 'only the logo mark' : 'no logo and no name'}): someone who does not know the company cannot tell who is advertising.`, layers: r.logo ? [r.logo.layerId] : [] });
    if (kind === 'billboard') {
      const head = r.texts.find((t) => t.slot === 'headline');
      const words = head?.text ? head.text.split(/\s+/).length : 0;
      const blocks = r.texts.filter((t) => t.slot !== 'brand').length;
      const small = head ? head.size < Math.min(r.width, r.height) * 0.05 : true;
      const issues = [words > 8 ? `the headline has ${words} words (a passer-by reads about seven)` : '', blocks > 3 ? `${blocks} text blocks compete` : '', small ? 'the headline is small for a distance' : ''].filter(Boolean);
      add({ id: 'billboard_comprehension', category: 'media', status: issues.length ? 'warn' : 'pass', detail: issues.length ? `Hard to grasp in a few seconds: ${issues.join('; ')}.` : 'One short message in large type, the business named: readable in a few seconds.' });
    } else {
      const next = r.texts.some((t) => t.slot === 'cta');
      add({ id: 'flyer_next_step', category: 'media', status: next ? 'pass' : 'warn', detail: next ? 'The flyer says what to do next.' : 'The flyer shows no next step (no call to action or contact).' });
    }
  }

  // ---- final asset purity ----------------------------------------------------------------------------------------------------------------------
  const ui = input.layers.filter((id) => UI_LAYER_PATTERN.test(id));
  add({ id: 'final_asset_purity', category: 'ui_contamination', status: ui.length ? 'fail' : 'pass', detail: ui.length ? `Editor/preview elements in the export: ${ui.join(', ')}.` : 'No editor or preview elements (slider arrows, carousel dots, selection handles).', layers: ui });

  compositionChecks(input, add);
  const failures = checks.filter((c) => c.status === 'fail');
  return { passed: failures.length === 0, checks, failures };
}

/**
 * COMPOSITION (MVP heuristics, measured on what was really drawn): empty colour panels, how the approved photograph is used, how much text the
 * visual carries for its platform, text lost on a large panel, and the logo treatment.
 */
function compositionChecks(input: PreflightInput, add: (c: DesignCheck) => void) {
  const r = input.report;
  const canvas = r.width * r.height;
  const order = (id: string) => input.layers.indexOf(id);
  const textRects = [...r.texts.map((t) => t.rect), ...r.buttons.map((b) => b.rect)];
  const clip = (x: PxRect): PxRect => {
    const x0 = Math.max(0, x.x);
    const y0 = Math.max(0, x.y);
    return { x: x0, y: y0, w: Math.max(0, Math.min(r.width, x.x + x.w) - x0), h: Math.max(0, Math.min(r.height, x.y + x.h) - y0) };
  };
  const panels = r.decor.filter((d) => ['rect', 'polygon', 'ellipse'].includes(d.type) && d.opacity >= 0.5 && !d.gradient).map((d) => ({ ...d, rect: clip(d.rect) })).filter((d) => area(d.rect) >= canvas * COMPOSITION.panelMin && area(d.rect) <= canvas * 0.85);
  // ---- empty panels
  const empty: { id: string; share: number }[] = [];
  for (const d of panels) {
    const A = area(d.rect);
    const at = order(d.layerId);
    const cards = r.decor.filter((x) => x.layerId !== d.layerId && x.opacity >= 0.5 && order(x.layerId) > at && area(clip(x.rect)) >= canvas * 0.01 && area(clip(x.rect)) < A * 0.95).map((x) => clip(x.rect));
    const pictures = r.hero && order(r.hero.layerId) > at ? [clip(r.hero.rect)] : [];
    const content = [...textRects, ...pictures, ...cards].reduce((s, x) => s + inter(d.rect, x), 0) + (r.logo ? inter(d.rect, r.logo.rect) * 0.5 : 0);
    const filled = Math.min(1, content / A);
    if (filled < COMPOSITION.panelFilled) empty.push({ id: d.layerId, share: (A * (1 - filled)) / canvas });
  }
  const big = empty.filter((e) => e.share >= COMPOSITION.emptyPanel);
  add({ id: 'empty_panel', category: 'composition', status: big.length ? 'fail' : 'pass', detail: big.length ? `A coloured panel carries nothing (${big.map((e) => `${e.id}: ${pct(e.share)} of the creative`).join(', ')}): shrink it, fill it with the picture or use another layout.` : 'No large coloured panel stays empty.', layers: big.map((e) => e.id) });
  // ---- the approved photograph
  const media = input.media ?? null;
  if (media?.pictureIsPhoto) {
    if (!r.hero) add({ id: 'photo_use', category: 'composition', status: media.fastScroll ? 'fail' : 'warn', detail: `An approved photograph exists, but this design is typography-only${media.fastScroll ? ' on a fast-scroll format, where the picture has to stop the scroll' : ''}.` });
    else {
      const shown = area(clip(r.hero.rect)) / canvas;
      const visible = shown * (r.hero.pictureVisibility ?? 1);
      const small = media.fastScroll && visible < COMPOSITION.fastScrollPhoto;
      add({ id: 'photo_use', category: 'composition', status: small ? 'warn' : 'pass', detail: small ? `The photograph shows on only ${pct(visible)} of a fast-scroll creative (aim for ${pct(COMPOSITION.fastScrollPhoto)} or more).` : `The photograph covers ${pct(shown)} of the creative.` });
    }
  }
  // ---- text density for the platform
  const budget = media?.textBudget ?? null;
  // the short labels of cards/rows/steps (point1..3) fill a structure; they are not text blocks of the message
  const SKIP = new Set(['cta', 'brand', 'point1', 'point2', 'point3']);
  const blocks = r.texts.filter((t) => !SKIP.has(t.slot) && (t.text ?? '').trim());
  const words = blocks.reduce((s, t) => s + (t.text ?? '').trim().split(/\s+/).filter(Boolean).length, 0) + r.buttons.reduce((s, b) => s + (b.text ?? '').trim().split(/\s+/).filter(Boolean).length, 0);
  const head = r.texts.find((t) => t.slot === 'headline');
  const headShare = head ? area(clip(head.rect)) / canvas : 0;
  if (budget) {
    const issues: string[] = [];
    if (words > budget.maxWords) issues.push(`${words} words (at most ${budget.maxWords})`);
    if (blocks.length > budget.maxBlocks) issues.push(`${blocks.length} text blocks besides the button (at most ${budget.maxBlocks})`);
    if (media?.fastScroll && headShare > COMPOSITION.fastScrollHeadline) issues.push(`the headline covers ${pct(headShare)} of the frame`);
    const severe = words > budget.maxWords * 1.3 || blocks.length > budget.maxBlocks + 1;
    add({ id: 'text_density', category: 'composition', status: !issues.length ? 'pass' : severe && media?.fastScroll ? 'fail' : 'warn', detail: issues.length ? `Too much text for this platform: ${issues.join('; ')}.` : `${words} words in ${blocks.length} block(s): within the platform's budget.` });
  }
  // ---- text lost on a big panel (much empty space around little text)
  const loose = panels.filter((d) => area(d.rect) >= canvas * COMPOSITION.textPanel && !(r.hero && inter(d.rect, r.hero.rect) > area(d.rect) * 0.2)).map((d) => {
    const inside = textRects.filter((t) => inter(d.rect, t) >= area(t) * 0.6);
    return { d, inside, fill: inside.reduce((s, t) => s + area(t), 0) / area(d.rect) };
  }).filter((x) => x.inside.length && x.fill < COMPOSITION.textFill);
  add({ id: 'text_space', category: 'composition', status: loose.length ? 'warn' : 'pass', detail: loose.length ? `The text uses only ${pct(loose[0].fill)} of its panel (${loose[0].d.layerId}): much empty space around little text.` : 'The text uses its panel.' });
  // ---- CONTENT DENSITY by medium: mobile social visuals must look finished, feed posts are the middle ground, a billboard may stay sparse
  const cls = formatClassOf(r.width, r.height);
  const kind = media?.kind ?? null;
  const social = kind === 'social_post';
  const mobile = !!media?.fastScroll || (social && (cls === 'story' || cls === 'portrait'));
  const sparseOk = kind === 'billboard';
  const level = (bad: boolean): DesignCheck['status'] => (!bad ? 'pass' : sparseOk ? 'pass' : mobile ? 'fail' : 'warn');
  // structured zones: 3+ same-size cards in a row or a column; a card is filled by a text, the button, the picture, the logo or an icon
  const cards = r.decor.filter((d) => d.type === 'rect' && d.area >= 0.004 && d.area <= 0.15).map((d) => ({ id: d.layerId, rect: clip(d.rect) }));
  const groups: (typeof cards)[] = [];
  for (const c of cards) {
    const g = groups.find((gr) => {
      const f = gr[0].rect;
      return Math.abs(f.w - c.rect.w) / f.w < 0.15 && Math.abs(f.h - c.rect.h) / f.h < 0.15 && (Math.abs(f.x - c.rect.x) < r.width * 0.02 || Math.abs(f.y - c.rect.y) < r.height * 0.02);
    });
    if (g) g.push(c);
    else groups.push([c]);
  }
  const fillers = [...textRects, ...(r.logo ? [r.logo.rect] : []), ...(r.hero ? [clip(r.hero.rect)] : [])];
  const emptyCards: string[] = [];
  let filledArea = 0;
  for (const g of groups.filter((x) => x.length >= 3)) {
    const empty = g.filter((c) => {
      if (fillers.some((f) => area(f) > 0 && inter(c.rect, f) >= area(f) * 0.6)) return false;
      const icon = r.decor.filter((x) => x.layerId !== c.id && area(x.rect) > 0 && area(x.rect) < area(c.rect) * 0.5 && inter(c.rect, x.rect) >= area(x.rect) * 0.8).length;
      return icon < 2;
    });
    if (empty.length >= 2) emptyCards.push(...empty.map((c) => c.id));
    filledArea += g.filter((c) => !empty.includes(c)).reduce((sum, c) => sum + area(c.rect), 0);
  }
  add({ id: 'empty_structure', category: 'composition', status: level(emptyCards.length > 0), detail: emptyCards.length ? (sparseOk ? `${emptyCards.length} card(s) carry no text: acceptable on a billboard, which is read in seconds.` : `${emptyCards.length} card(s)/row(s) of the layout carry nothing (${emptyCards.join(', ')}): they look like unfinished placeholders${mobile ? ' on a mobile visual' : ''}. Fill them with short labels from the copy, or use another layout.`) : 'Every card, row or step of the layout carries its content.', layers: emptyCards });
  // a picture area that shows only its placeholder pattern
  const holder = r.decor.filter((d) => d.type === 'placeholder' && d.area >= COMPOSITION.placeholder && d.area < 0.9);
  add({ id: 'placeholder_picture', category: 'composition', status: level(holder.length > 0), detail: holder.length ? `A picture area of ${pct(holder[0].area)} shows only a placeholder pattern: there is no picture for it.` : 'No picture area shows a placeholder.' });
  // much unused space on a mobile visual
  if (mobile) {
    const covered = (textRects.reduce((sum, t) => sum + area(clip(t)), 0) + (r.logo ? area(clip(r.logo.rect)) : 0) + (r.hero ? area(clip(r.hero.rect)) : 0) + filledArea) / canvas;
    add({ id: 'unused_space', category: 'composition', status: covered < COMPOSITION.mobileCoverage ? 'warn' : 'pass', detail: covered < COMPOSITION.mobileCoverage ? `Text, picture and cards cover only ${pct(covered)} of this mobile visual: much of the canvas is unused.` : `Text, picture and cards cover ${pct(covered)} of the visual.` });
  }
  // ---- the logo treatment
  const lg = r.logo;
  if (lg && lg.mode === 'logo' && lg.treatment) {
    const boxed = lg.treatment === 'plate_added' || lg.treatment === 'plate_recoloured';
    add({ id: 'logo_treatment', category: 'logo', status: boxed ? 'warn' : 'pass', detail: boxed ? `A plate had to be drawn behind the logo (${lg.treatment === 'plate_added' ? 'added' : 'recoloured'}): neither the logo as it is nor a recoloured version read on this background.` : lg.treatment === 'recoloured' ? 'The single-colour logo was recoloured to read directly on the creative (no box behind it).' : lg.treatment === 'template_plate' ? "The logo sits on the template's own plate." : 'The logo sits directly on the creative.' });
  }
}

/** How bad a set of failures is, for choosing the best of several attempts (people, logo and readable text matter most). */
export function severityOf(p: PreflightResult): number {
  const W: Record<CheckCategory, number> = { occlusion: 4, crop: 4, logo: 3, text: 3, image: 2, safe_area: 2, ui_contamination: 3, template_mismatch: 2, duplicate_layout: 1, alignment: 1, media: 3, composition: 1 };
  return p.failures.reduce((s, f) => s + W[f.category], 0);
}

/** Tie-breaker between attempts with the same failures: how visible the people and the picture stayed (higher is better). */
export function visibilityScore(r: RenderReport): number {
  if (!r.hero) return 0;
  const faces = keyFaces(r).filter((f) => f.inFrame >= 0.5);
  const fv = faces.length ? faces.reduce((s, f) => s + (f.visibility ?? 1), 0) / faces.length : 1;
  return fv * 2 + (r.hero.subjectVisibility ?? 1) + (r.hero.pictureVisibility ?? 1);
}

const toUnit = (r: PxRect, W: number, H: number): UnitBox => [r.x / W, r.y / H, r.w / W, r.h / H];

/**
 * The NEXT repair for a failed preflight, in a fixed order: crop -> logo -> opacity of panels/scrims/bands -> smaller or hidden decoration ->
 * text backing -> (nothing left: another template). Each call adds to the tune of the previous attempt; null means the template itself has to
 * change. Text never gets transparency; only decoration does.
 */
export function nextRepair(p: PreflightResult, r: RenderReport, tune: RenderTune): { tune: RenderTune; actions: RepairAction[] } | null {
  const next: RenderTune = { ...tune, layerOpacity: { ...(tune.layerOpacity ?? {}) }, hide: [...(tune.hide ?? [])], textBacking: [...(tune.textBacking ?? [])], shrinkDecor: { ...(tune.shrinkDecor ?? {}) }, avoid: [...(tune.avoid ?? [])] };
  const actions: RepairAction[] = [];
  const failed = (id: string) => p.failures.find((f) => f.id === id);
  const decorById = new Map(r.decor.map((d) => [d.layerId, d]));

  // an element off the axis of its group is put back on it (a centred layout keeps its button centred)
  const al = failed('alignment');
  if (al) {
    const alignX = { ...(next.alignX ?? {}) };
    for (const spec of al.layers ?? []) {
      const [id, mode, x] = spec.split('@');
      if (!id || alignX[id]) continue;
      alignX[id] = { mode: mode as 'center' | 'left' | 'right', x: Number(x) };
      actions.push({ kind: 'position', target: id, detail: `Put back on the ${mode} axis of its group.` });
    }
    next.alignX = alignX;
  }
  // a print creative names the business in full
  if (failed('brand_identity') && !next.brandName) {
    next.brandName = true;
    actions.push({ kind: 'copy', target: 'logo', detail: 'Wrote the business name next to the logo mark.' });
  }

  // editor furniture is simply left out
  const ui = failed('final_asset_purity');
  if (ui) for (const id of ui.layers ?? []) if (!next.hide!.includes(id) && decorById.has(id)) {
    next.hide!.push(id);
    actions.push({ kind: 'hide', target: id, detail: 'Removed an editor/preview element from the final asset.' });
  }

  // people and subject: first move the crop away from what covers them, then make the covering decoration lighter, then smaller/hidden
  const occl = [failed('face_occlusion'), failed('subject_visibility'), failed('overlay_dominance')].filter((x): x is DesignCheck => !!x);
  if (occl.length && r.hero) {
    const layers = [...new Set(occl.flatMap((c) => c.layers ?? []))];
    const covers = layers.map((id) => decorById.get(id)).filter((d): d is NonNullable<typeof d> => !!d);
    const textCovers = [...r.texts, ...r.buttons].filter((t) => layers.includes(t.layerId));
    if (!tune.avoid?.length && (covers.length || textCovers.length)) {
      const regions = [...covers.filter((d) => d.opacity >= 0.3 && d.type !== 'scrim' && d.type !== 'tint').map((d) => d.rect), ...textCovers.map((t) => t.rect)];
      if (regions.length) {
        next.avoid = regions.map((x) => toUnit(x, r.width, r.height));
        actions.push({ kind: 'crop', target: r.hero.layerId, detail: `Re-cropped the picture to keep the people out from under ${layers.join(', ')}.` });
      }
    }
    for (const d of covers) {
      const cur = next.layerOpacity![d.layerId] ?? 1;
      // a veil over the whole picture works like a scrim: it is lightened as one (the text on it is re-checked for readability next round)
      if (d.type === 'scrim' || d.type === 'tint' || d.area >= 0.8) {
        if (cur > 0.3) {
          next.layerOpacity![d.layerId] = Math.round(cur * 0.55 * 100) / 100;
          actions.push({ kind: 'opacity', target: d.layerId, detail: `Lightened the ${d.type} over the picture to ${Math.round(cur * 55)}% of its strength.` });
        }
        continue;
      }
      // a panel or band that CARRIES text: only a dark one behind light text is made lighter, and only moderately (the text stays full and
      // readable on it); a light card behind dark text is never made see-through (it would turn grey and muddy) - the crop or the template changes
      const carried = r.texts.filter((t) => inter(t.rect, d.rect) > area(t.rect) * 0.6);
      if (carried.length) {
        const darkBehindLight = d.lum !== null && carried.every((t) => t.lum > d.lum! + 0.25);
        if (darkBehindLight && cur > 0.76) {
          next.layerOpacity![d.layerId] = 0.75;
          actions.push({ kind: 'opacity', target: d.layerId, detail: `Lowered the dark panel/band "${d.layerId}" behind the text to 75% so the people show through; the text stays fully opaque.` });
        }
        continue;
      }
      if (cur > 0.42) {
        next.layerOpacity![d.layerId] = Math.round(Math.max(0.35, cur * 0.6) * 100) / 100;
        actions.push({ kind: 'opacity', target: d.layerId, detail: `Lowered the opacity of ${d.type} "${d.layerId}" so the picture shows through.` });
      } else if (d.area < 0.06 && !next.hide!.includes(d.layerId)) {
        next.hide!.push(d.layerId);
        actions.push({ kind: 'hide', target: d.layerId, detail: `Left out the small decoration "${d.layerId}" that covered the people.` });
      } else if (!d.gradient && (next.shrinkDecor![d.layerId] ?? 1) > 0.75 && d.area < 0.3) {
        // (a gradient scrim is never shrunk: a smaller scrim is a hard-edged box over the picture; it is lightened or left out)
        next.shrinkDecor![d.layerId] = 0.7;
        actions.push({ kind: 'size', target: d.layerId, detail: `Drew "${d.layerId}" smaller so it covers less of the picture.` });
      } else if (!next.hide!.includes(d.layerId)) {
        // the last resort for pure decoration (it carries no text): it is left out rather than hiding the people
        next.hide!.push(d.layerId);
        actions.push({ kind: 'hide', target: d.layerId, detail: `Left out the decoration "${d.layerId}": even lighter and smaller it still covered the people.` });
      }
    }
  }

  // the logo: bigger, and a quiet plate when it does not read
  const logo = failed('logo_visibility');
  if (logo && r.logo) {
    if (/too small/.test(logo.detail) && (tune.logoScale ?? 1) < 2.6) {
      const unit = Math.min(r.width, r.height);
      const visual = Math.sqrt(area(r.logo.rect));
      const need = Math.max((THRESHOLDS.logoVisual * unit) / Math.max(1, visual), (Math.max(12, THRESHOLDS.logoMinSide * unit)) / Math.max(1, Math.min(r.logo.rect.w, r.logo.rect.h)));
      next.logoScale = Math.min(2.6, Math.round((tune.logoScale ?? 1) * Math.max(1.25, need * 1.12) * 100) / 100);
      actions.push({ kind: 'size', target: r.logo.layerId, detail: `Enlarged the logo ${next.logoScale}x so it can be read.` });
    }
    if (/does not stand out/.test(logo.detail) && !tune.logoPlate) {
      next.logoPlate = true;
      actions.push({ kind: 'backing', target: r.logo.layerId, detail: 'Added a quiet plate behind the logo so it reads.' });
    }
  }
  // a logo that collides with text (or sits on a face) moves to another corner of its template; an enlarged one that still collides steps back
  const clash = failed('text_collision');
  const logoOnFace = failed('face_occlusion')?.layers?.includes(r.logo?.layerId ?? '\u0000');
  if (r.logo && ((clash && (clash.layers ?? []).includes(r.logo.layerId)) || logoOnFace)) {
    const others = [...r.texts.map((t) => t.rect), ...r.buttons.map((b) => b.rect), ...(r.hero?.faces ?? []).filter((f) => f.inFrame >= 0.5).map((f) => f.rect)].filter((x) => inter(x, r.logo!.rect) > 0);
    if (others.length && !(tune.logoAvoid?.length)) {
      next.logoAvoid = others.map((x) => toUnit(x, r.width, r.height));
      actions.push({ kind: 'position', target: r.logo.layerId, detail: 'Moved the logo to another corner of the template, away from the text/face it touched.' });
    } else if ((tune.logoScale ?? 1) > 1.05 && !logo) {
      next.logoScale = Math.max(1, Math.round((tune.logoScale ?? 1) * 0.85 * 100) / 100);
      actions.push({ kind: 'size', target: r.logo.layerId, detail: 'Reduced the enlarged logo so it no longer touches the text.' });
    }
  }

  // a headline over a busy picture gets a tight solid backing (the text itself stays fully opaque)
  const read = failed('headline_readability');
  if (read) for (const id of read.layers ?? []) if (!next.textBacking!.includes(id)) {
    next.textBacking!.push(id);
    actions.push({ kind: 'backing', target: id, detail: 'Added a tight solid backing behind the headline; the text stays fully opaque.' });
  }

  return actions.length ? { tune: next, actions } : null;
}

/**
 * THE QUALITY GATE of one creative. A PNG existing is not enough:
 *   passed      every deterministic layout check passed
 *   warnings    only non-critical problems remain (overlay strength, subject size, a repeated layout, a low-resolution picture)
 *   unresolved  a critical problem remains: a face cut or covered, a cropped brand graphic, cut text, an unreadable headline, a missing or
 *               unreadable logo, text outside the safe area or editor furniture. Such a creative is delivered for review, never as approved.
 */
export const CRITICAL_CHECKS = new Set(['face_occlusion', 'face_crop', 'graphic_crop', 'text_fit', 'headline_readability', 'logo_visibility', 'text_safe_area', 'final_asset_purity', 'media_button', 'brand_identity']);
export type DesignStatus = 'passed' | 'warnings' | 'unresolved';
export function designStatus(p: Pick<PreflightResult, 'failures' | 'checks'>): DesignStatus {
  if (p.failures.some((f) => CRITICAL_CHECKS.has(f.id))) return 'unresolved';
  return p.failures.length || p.checks.some((c) => c.status === 'warn') ? 'warnings' : 'passed';
}

/** Failures no tune can fix: only another template (or another crop geometry) can. */
export function needsAnotherTemplate(p: PreflightResult): boolean {
  return p.failures.some((f) => ['face_crop', 'subject_size', 'graphic_crop', 'text_fit', 'text_safe_area', 'template_fit'].includes(f.id) || (f.id === 'text_collision' && !/logo/.test(f.layers?.join(' ') ?? '')));
}
