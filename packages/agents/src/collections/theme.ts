import { FONT_FAMILIES, type Layer, type TemplateDef, type TextSlot } from '../templates/schema';
import type { CollectionTokens, TemplateCollection, TypeToken } from './schema';

/**
 * APPLYING A COLLECTION TO A TEMPLATE. Pure, deterministic, data -> data: the result is another valid TemplateDef (same id, same version,
 * same layers in the same order and boxes), so the one renderer, the validators and the previews keep working unchanged. What changes are
 * the DESIGN TOKENS of the collection: the type of every text layer by role, the call-to-action, corner radii, hairlines, the mask,
 * saturation and scrim of pictures that sit inside the layout, and the decorative patterns. Geometry (where things are) belongs to the
 * template; the way things look belongs to the collection.
 *
 * Class patches (`at`) are themed too: a layer that a patch changes is themed from the layer as that class sees it.
 */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Number(v.toFixed(5));

const HEADLINE_SLOTS: readonly TextSlot[] = ['headline', 'stat', 'offer', 'quote'];
const BODY_SLOTS: readonly TextSlot[] = ['support', 'offerDetail', 'statLabel', 'attribution'];

type Obj = Record<string, unknown>;

function typeStyle(t: TypeToken, previous: { tracking?: number; lineHeight?: number } | undefined, overrides: Partial<TypeToken> = {}) {
  const m = { ...t, ...overrides };
  const style: Obj = { family: m.family, weight: m.weight };
  if (m.italic) style.italic = true;
  if (m.case === 'upper') style.case = 'upper';
  const tracking = m.tracking ?? previous?.tracking;
  if (tracking !== undefined) style.tracking = tracking;
  const lineHeight = m.lineHeight ?? previous?.lineHeight;
  if (lineHeight !== undefined) style.lineHeight = lineHeight;
  return style;
}

/** A box that touches at least three canvas edges, or covers most of the canvas, is a background picture, not an inset one. */
function isBleed(box: readonly number[]): boolean {
  const [x, y, w, h] = box;
  const touches = [x <= 0.01, y <= 0.01, x + w >= 0.99, y + h >= 0.99].filter(Boolean).length;
  return touches >= 3 || w * h >= 0.8;
}

/** An inset card or panel: fully inside the canvas and big enough to read as a card. */
function isInsetCard(box: readonly number[]): boolean {
  const [x, y, w, h] = box;
  return x >= 0.01 && y >= 0.01 && x + w <= 0.99 && y + h <= 0.99 && Math.min(w, h) >= 0.06;
}

function scaleStroke<T extends { width: number } | undefined>(stroke: T, k: number): T {
  if (!stroke) return stroke;
  return { ...stroke, width: round(clamp(stroke.width * k, 0, 0.05)) } as T;
}

type Treatment = NonNullable<Extract<Layer, { type: 'image' }>['treatment']>;

/** Themes ONE layer (null = the layer is removed by the collection). A function of the layer alone, so a class patch can be themed the same way. */
export function themeLayer(layer: Layer, tk: CollectionTokens): Layer | null {
  const l = structuredClone(layer) as Layer & Obj;
  switch (l.type) {
    case 'text': {
      const slot = l.slot;
      const prev = l.style;
      if (slot === 'brand') l.style = typeStyle(tk.typography.brand, prev) as typeof l.style;
      else if (slot === 'quote') l.style = typeStyle(tk.typography.headline, prev, { case: 'none', weight: Math.min(tk.typography.headline.weight, 600) }) as typeof l.style;
      else if ((HEADLINE_SLOTS as readonly string[]).includes(slot)) l.style = typeStyle(tk.typography.headline, prev) as typeof l.style;
      else if ((BODY_SLOTS as readonly string[]).includes(slot)) l.style = typeStyle(tk.typography.body, prev) as typeof l.style;
      else l.style = typeStyle(tk.typography.label, prev) as typeof l.style;
      if ((HEADLINE_SLOTS as readonly string[]).includes(slot) && tk.typography.headlineScale !== 1) {
        const k = tk.typography.headlineScale;
        l.size = { max: round(clamp(l.size.max * k, 0.01, 0.3)), min: round(clamp(l.size.min * k, 0.01, 0.3)) };
      }
      return l;
    }
    case 'button':
      l.radius = tk.shape.buttonRadius;
      l.style = typeStyle(tk.typography.button, l.style) as typeof l.style;
      l.arrow = tk.shape.buttonArrow;
      l.stroke = scaleStroke(l.stroke, tk.shape.lineWeight);
      if (!tk.shape.buttonArrow) delete l.arrow;
      return l;
    case 'logo':
      l.nameStyle = typeStyle(tk.typography.brand, l.nameStyle) as typeof l.nameStyle;
      if (l.plate) l.plate = { ...l.plate, radius: tk.shape.logoPlateRadius };
      return l;
    case 'rect': {
      l.stroke = scaleStroke(l.stroke, tk.shape.lineWeight);
      if (isInsetCard(l.box)) {
        l.radius = tk.shape.cardRadius;
        if (tk.shape.cardShadow) l.shadow = true;
        else delete l.shadow;
      } else if (l.radius !== undefined && l.radius >= 0.3 && Math.min(l.box[2], l.box[3]) < 0.06) {
        // a small chip or tag follows the button language of the collection
        l.radius = tk.shape.buttonRadius;
      }
      return l;
    }
    case 'ellipse':
    case 'polygon':
      l.stroke = scaleStroke(l.stroke, tk.shape.lineWeight);
      return l;
    case 'line':
      l.stroke = scaleStroke(l.stroke, tk.shape.lineWeight);
      return l;
    case 'pattern': {
      const p = tk.decor.patterns;
      if (p === 'hide') return null;
      if (p === 'keep') return l;
      l.kind = p.kind;
      l.opacity = round(clamp((l.opacity ?? 1) * p.opacity, 0.05, 1));
      return l;
    }
    case 'image': {
      const treatment: Treatment = { ...(l.treatment ?? {}) };
      if (!treatment.duotone) treatment.saturation = tk.image.saturation;
      if (tk.image.tint && !treatment.tint && !treatment.duotone) treatment.tint = { color: tk.image.tint.color, opacity: tk.image.tint.opacity };
      if (treatment.scrim) {
        const s = treatment.scrim;
        treatment.scrim = { ...s, fromOpacity: round(clamp(s.fromOpacity * tk.image.scrim, 0, 1)), toOpacity: round(clamp(s.toOpacity * tk.image.scrim, 0, 1)) };
      }
      l.treatment = treatment;
      if (!isBleed(l.box)) {
        const [, , w, h] = l.box;
        const mask = l.mask ?? 'none';
        if ((mask === 'none' || mask === 'rounded') && Math.min(w, h) >= 0.12) {
          const want = tk.image.mask;
          // an arch needs a box that is not wider than tall; a diagonal cut needs room for the cut
          const m = want === 'arch' && w > h * 1.05 ? 'rounded' : want;
          l.mask = m;
          if (m === 'rounded') l.radius = tk.image.radius;
          else if (m === 'cut-left' || m === 'cut-right') l.radius = Math.max(l.radius ?? 0, 0.06);
          else delete l.radius;
        }
        if (tk.image.border && !l.border) l.border = { color: tk.image.border.color, width: round(tk.image.border.width * tk.shape.lineWeight) };
        if (tk.image.shadow) l.shadow = true;
      }
      return l;
    }
    default:
      return l;
  }
}

/** The keys of a layer that theming may change; a class patch carries them when the class sees a different value. */
const THEMED_KEYS = ['style', 'size', 'radius', 'arrow', 'stroke', 'shadow', 'mask', 'treatment', 'border', 'kind', 'opacity', 'nameStyle', 'plate'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Returns the template as the collection draws it. The input is never changed; the result has the same id and version. */
export function applyCollection(template: TemplateDef, collection: Pick<TemplateCollection, 'tokens'>): TemplateDef {
  const layers: Layer[] = [];
  for (const layer of template.layers) {
    const base = themeLayer(layer, collection.tokens);
    if (!base) continue;
    if (!layer.at) {
      layers.push(base);
      continue;
    }
    const at: Record<string, Obj> = {};
    for (const [cls, patch] of Object.entries(layer.at)) {
      const { type: _t, id: _i, at: _a, hide: _h, ...rest } = patch as Obj;
      void _t;
      void _i;
      void _a;
      void _h;
      const themed = themeLayer({ ...layer, ...rest } as Layer, collection.tokens);
      const np: Obj = { ...(patch as Obj) };
      if (themed) {
        for (const k of THEMED_KEYS) {
          const tv = (themed as Obj)[k];
          if (k in (patch as Obj) || !same(tv, (base as Obj)[k])) {
            if (tv === undefined) delete np[k];
            else np[k] = tv;
          }
        }
      }
      at[cls] = np;
    }
    layers.push({ ...base, at } as Layer);
  }
  return { ...structuredClone({ ...template, layers: [] }), layers };
}

/** The font families a collection uses (for the card and the tests). */
export function fontsOf(tk: CollectionTokens): string[] {
  const t = tk.typography;
  return [...new Set([t.headline.family, t.body.family, t.label.family, t.button.family, t.brand.family])].filter((f) => (FONT_FAMILIES as readonly string[]).includes(f));
}
