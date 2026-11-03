import { designAnchors, type CampaignDesign } from '../collections/design';
import { COLLECTION_ROLES, ROLE_LABELS, type TemplateCollection } from '../collections/schema';
import { CREATIVE_FORMATS } from '../creative/formats';
import { formatClassOf, type Requirement, type TemplateDef, type VisualDirectionBrief } from '../templates/schema';
import { getStyle } from '../templates/styles';
import type { ChannelId } from '../strategy/channels';
import { HYBRID_FORMATS, type TemplateSlot } from './plan';
import type { TemplateContent, TemplateSelectionItem, TemplateSelectionPlan } from './records';
import type { HybridFacts } from './settings';

/**
 * THE TEMPLATE SELECTOR (deterministic core). It never invents a template: every candidate comes from the library, must be active,
 * must be designed for the slot's format class and must have all the content it requires (an offer card needs an offer the USER gave;
 * a template with a hero picture needs a picture). Among eligible templates it scores style, industry, channel, density, objective,
 * brand tone and the user's favourites, and it penalizes repetition so a campaign does not show the same layout twice.
 * A model may re-rank a SHORTLIST (assisted mode); its answer is validated against these same rules and discarded if it breaks them.
 */

export interface SelectorContext {
  direction: VisualDirectionBrief;
  /** Lower-case words describing the business (industry, offering). */
  industryText: string;
  objectiveText: string;
  palette: string[];
  hasLogo: boolean;
  /** Brand images of the project: the only source of a SECOND picture (a template with a secondary picture slot looks unfinished without one). */
  brandImageCount?: number;
  brandName: string;
  facts: HybridFacts;
  library: readonly TemplateDef[];
  preferred: string[];
  overrides: Record<string, string>;
  mode: 'automatic' | 'assisted' | 'manual';
  basis: 'forecast' | 'concepts';
  /**
   * The approved campaign design. When present `library` is already the collection's templates (drawn with its tokens), so the selector can
   * only choose inside the collection; these two add the collection's roles and the design's background to the scoring.
   */
  design?: CampaignDesign | null;
  collection?: TemplateCollection | null;
}

export interface Candidate {
  template: TemplateDef;
  score: number;
  reasons: string[];
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** FNV-1a: a stable pseudo-random number from a string, so equal scores break the same way on every run (no Math.random anywhere). */
export function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function luminanceOf(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}

/** True when `kw` occurs in `text` as a whole word or phrase (an optional plural s/es is accepted). */
export function hasWord(text: string, kw: string): boolean {
  const k = kw
    .trim()
    .split('')
    .map((ch) => (/[a-z0-9\s-]/i.test(ch) ? ch : `\\${ch}`))
    .join('');
  return !!k && new RegExp(`(^|[^a-z0-9])${k}(?:e?s)?($|[^a-z0-9])`).test(text);
}

export type ObjectiveKind = 'conversion' | 'awareness' | 'consideration' | null;
export function objectiveKind(text: string): ObjectiveKind {
  const t = fold(text);
  if (/\b(sale|sales|buy|purchase|convert|conversion|signup|sign-up|sign up|lead|leads|trial|book|booking|order|register|prodaj|kupov|kupi|narud|rezerv|prijav|registr)/.test(t)) return 'conversion';
  if (/\b(awareness|brand|launch|introduc|visibility|reach|new|upozn|svest|lansir|prepozn|vidljiv|predstav)/.test(t)) return 'awareness';
  if (/\b(trust|educat|consider|compare|demo|learn|inform|credib|pover|edukac|poredi|saznaj)/.test(t)) return 'consideration';
  return null;
}

/** What content a slot can show. 'image' = a picture exists for it (an original or a brand image). Facts only when the USER gave them. */
export function availableFor(slot: TemplateSlot, content: TemplateContent, ctx: Pick<SelectorContext, 'hasLogo' | 'brandName' | 'facts'>): Set<Requirement> {
  const a = new Set<Requirement>(['headline']);
  if (content.support) a.add('support');
  if (content.cta) a.add('cta');
  if (content.eyebrow) a.add('eyebrow');
  if (ctx.brandName) a.add('brand');
  if (slot.source !== 'none') a.add('image');
  if (ctx.hasLogo) a.add('logo');
  for (const k of ['offer', 'offerDetail', 'date', 'location', 'quote', 'attribution', 'stat', 'statLabel', 'tag'] as const) if (ctx.facts[k]?.trim()) a.add(k);
  return a;
}

/** Why a template cannot be used for this slot (empty = it can). */
export function blockers(t: TemplateDef, slot: TemplateSlot, available: Set<Requirement>): string[] {
  const out: string[] = [];
  if (t.status !== 'active') out.push(`status is ${t.status}`);
  if (!t.classes.includes(slot.formatClass)) out.push(`not designed for ${slot.formatClass} formats`);
  for (const r of t.requires) if (!available.has(r)) out.push(`needs ${r}`);
  return out;
}

export function scoreTemplate(t: TemplateDef, slot: TemplateSlot, ctx: SelectorContext): Candidate {
  const reasons: string[] = [];
  let score = 0;
  const primary = ctx.direction.styleId;
  if (ctx.collection) {
    // every candidate already belongs to the user's collection: style fit is a given; the role it plays in a campaign is what tells them apart
    score += 3;
    reasons.push(`part of the ${ctx.collection.name} collection you chose`);
    const desired = COLLECTION_ROLES[(Math.max(1, slot.index) - 1) % COLLECTION_ROLES.length];
    if (ctx.collection.roles[desired]?.includes(t.id)) {
      score += 1.5;
      reasons.push(`plays the "${ROLE_LABELS[desired].toLowerCase()}" role`);
    }
    if (ctx.design) {
      const dark = designAnchors(ctx.design.palette).backgroundMode === 'dark';
      if (dark && t.tone === 'dark') score += 1;
      else if (!dark && t.tone === 'light') score += 1;
      else if (dark && t.tone === 'light') score -= 0.5;
    }
  } else if (t.styles.includes(primary)) {
    score += 4;
    reasons.push(`fits the ${getStyle(primary).name} style`);
  } else if (ctx.direction.secondaryStyleIds.some((s) => t.styles.includes(s))) {
    score += 2;
    reasons.push('fits the secondary style');
  } else score -= 0.5;

  // whole words only ("tea" must not match "teaches", nor "ai" "training"); a trailing s/es is allowed
  const ind = fold(ctx.industryText);
  const hit = t.industries.find((k) => k !== '*' && hasWord(ind, fold(k)));
  if (hit) {
    score += 3;
    reasons.push(`suits the ${hit} industry`);
  } else if (t.industries.includes('*')) score += 0.5;
  else score -= 0.5;

  const style = getStyle(primary);
  if (style.templateCategories.includes(t.category)) score += 1;

  if (t.channels.length === 0) score += 0.3;
  else if (t.channels.includes(slot.channel)) {
    score += 1.5;
    reasons.push(`made for ${slot.channel.replace('_', ' ')}`);
  } else score -= 1;

  if (t.classes[0] === slot.formatClass) score += 0.5;
  if (t.density === style.density) score += 1;
  if (slot.formatClass === 'story' && t.density === 'dense') score -= 1;
  if (slot.formatClass === 'banner' && t.density !== 'airy') score += 0.3;

  const obj = objectiveKind(ctx.objectiveText);
  const hasButton = t.layers.some((l) => l.type === 'button');
  if (obj === 'conversion') {
    if (hasButton) score += 0.7;
    if (t.requires.includes('offer')) score += 0.5;
  } else if (obj === 'awareness') {
    if (t.family === 'full-bleed' || t.family === 'poster-type') score += 0.6;
  } else if (obj === 'consideration') {
    if (t.family === 'split' || t.family === 'panel' || t.family === 'stat-focus' || t.family === 'inset-card') score += 0.6;
  }

  const dark = ctx.palette.length ? luminanceOf(ctx.palette[0]) < 0.2 : false;
  const light = ctx.palette.length ? luminanceOf(ctx.palette[0]) > 0.7 : false;
  if (dark && t.tone === 'dark') score += 0.5;
  if (light && t.tone === 'light') score += 0.5;

  if (ctx.preferred.includes(t.id)) {
    score += 1.5;
    reasons.push('one of your favourites');
  }

  const usesImage = t.layers.some((l) => l.type === 'image');
  if (slot.source !== 'none' && usesImage) {
    score += 1;
    reasons.push(slot.source === 'ai_original' ? 'shows the concept\'s original image' : 'shows a brand image');
  }
  if (slot.source !== 'none' && !usesImage) score -= 2; // would waste the picture that exists
  // a second picture exists only if the project has brand images; without one the template's second area shows a plain pattern
  const needsSecond = t.layers.some((l) => l.type === 'image' && l.slot === 'secondary');
  // NO AI HYBRID decides per slot (the allocation gave it a second picture or not); other campaigns look at whether the project has brand images at all
  const hasSecond = slot.imageId !== undefined ? !!slot.secondaryImageId : (ctx.brandImageCount ?? 0) > 0;
  if (needsSecond && !hasSecond) score -= 1.5;

  return { template: t, score: Math.round(score * 100) / 100, reasons };
}

export interface SlotChoice {
  slot: TemplateSlot;
  candidates: Candidate[];
}

export interface SelectionInput {
  slots: TemplateSlot[];
  contents: Map<string, TemplateContent>;
  ctx: SelectorContext;
}

export interface SelectionResult {
  plan: TemplateSelectionPlan;
  /** Per slot: eligible candidates by raw score (before repetition penalties), best first. The assisted mode re-ranks within this shortlist only. */
  shortlists: Map<string, Candidate[]>;
  /** Slots that could not be given any template (with the reason). */
  unplaceable: { slotId: string; reason: string }[];
}

const lengthPenalty = (t: TemplateDef, headline: string) => {
  const sample = t.sample.headline.length || 20;
  if (headline.length > sample * 2.2) return 1.5;
  if (headline.length > sample * 1.6) return 0.7;
  return 0;
};

function rationaleOf(c: Candidate, slot: TemplateSlot, extra: string[]) {
  const parts = [...c.reasons.slice(0, 3), ...extra];
  const fmt = CREATIVE_FORMATS[slot.formatId]?.label ?? slot.formatId;
  return `${c.template.name} for ${fmt}${parts.length ? ': ' + parts.join('; ') : ''}.`;
}

/** The order the slots are served in: every concept's first creative, then every concept's second... so the first concept does not take all the best layouts. */
const serveOrder = (slots: TemplateSlot[]) => slots.map((s, i) => ({ s, i })).sort((a, b) => a.s.index - b.s.index || a.i - b.i).map((x) => x.s);

export function selectTemplates(input: SelectionInput): SelectionResult {
  const { slots, contents, ctx } = input;
  const byId = new Map(ctx.library.map((t) => [t.id, t]));
  const items = new Map<string, TemplateSelectionItem>();
  const shortlists = new Map<string, Candidate[]>();
  const unplaceable: { slotId: string; reason: string }[] = [];
  const warnings: string[] = [];
  const eligibleIds = new Set<string>(); // every template that fits at least one slot
  const uses = new Map<string, number>();
  // NO AI HYBRID: the same template drawn on the same picture twice is the same creative twice; that pair is penalised hard
  const pairUses = new Map<string, number>();
  const familyUses = new Map<string, number>();
  const conceptFamilies = new Map<string, Map<string, number>>();
  const conceptCats = new Map<string, Map<string, number>>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  const place = (slot: TemplateSlot, formatId: string, channel: ChannelId): TemplateSlot => {
    const f = CREATIVE_FORMATS[formatId];
    return { ...slot, formatId, channel, width: f.width, height: f.height, formatClass: formatClassOf(f.width, f.height) };
  };

  for (const original of serveOrder(slots)) {
    const content = contents.get(original.slotId) ?? { headline: '', support: null, cta: null, eyebrow: null, variantId: null };
    let slot = original;
    let origin: TemplateSelectionItem['origin'] = 'deterministic';
    const fam = conceptFamilies.get(slot.conceptId) ?? conceptFamilies.set(slot.conceptId, new Map()).get(slot.conceptId)!;
    const cats = conceptCats.get(slot.conceptId) ?? conceptCats.set(slot.conceptId, new Map()).get(slot.conceptId)!;

    const rank = (s: TemplateSlot): Candidate[] => {
      const avail = availableFor(s, content, ctx);
      return ctx.library
        .filter((t) => blockers(t, s, avail).length === 0)
        .map((t) => {
          const c = scoreTemplate(t, s, ctx);
          return { ...c, score: Math.round((c.score - lengthPenalty(t, content.headline)) * 100) / 100 };
        })
        .sort((a, b) => b.score - a.score || stableHash(a.template.id) - stableHash(b.template.id));
    };

    // the user's override wins when it is valid; an invalid one is reported and the automatic choice is used instead
    let forced: Candidate | null = null;
    const wanted = ctx.overrides[slot.slotId];
    if (wanted) {
      const t = byId.get(wanted);
      const why = !t ? 'that template does not exist' : blockers(t, slot, availableFor(slot, content, ctx)).join(', ');
      if (t && !why) {
        forced = scoreTemplate(t, slot, ctx);
        origin = 'user_override';
      } else warnings.push(`Your template choice "${wanted}" for ${slot.slotId} was not used: ${why}. The automatic choice was used instead.`);
    }

    let ranked = rank(slot);
    const extra: string[] = [];
    if (!forced && !ranked.length) {
      // no template exists for this format with this content: try the channel's other formats, then the other channels' formats
      const tried = new Set([`${slot.channel}|${slot.formatId}`]);
      const options: { ch: ChannelId; f: string }[] = [slot.channel, ...(Object.keys(HYBRID_FORMATS) as ChannelId[]).filter((c) => c !== slot.channel)].flatMap((ch) => (HYBRID_FORMATS[ch] ?? []).map((f) => ({ ch, f })));
      for (const o of options) {
        if (tried.has(`${o.ch}|${o.f}`)) continue;
        tried.add(`${o.ch}|${o.f}`);
        const moved = place(slot, o.f, slot.channel); // the channel stays: only the shape changes
        const r = rank(moved);
        if (r.length) {
          warnings.push(`No template fits ${CREATIVE_FORMATS[slot.formatId].label} with this content for ${slot.slotId}; ${CREATIVE_FORMATS[o.f].label} was used instead.`);
          slot = moved;
          ranked = r;
          extra.push('format adapted because no template fits the planned one');
          break;
        }
      }
    }
    if (!forced && !ranked.length) {
      unplaceable.push({ slotId: slot.slotId, reason: 'No template in the library is compatible with this slot\'s content and formats.' });
      continue;
    }
    for (const c of ranked) eligibleIds.add(c.template.id);
    shortlists.set(slot.slotId, ranked.slice(0, 8));

    // repetition penalties apply to the CHOICE, not to the raw shortlist
    const adjusted = (forced ? [forced, ...ranked.filter((c) => c.template.id !== forced!.template.id)] : ranked).map((c) => {
      let s = c.score;
      s -= 5.5 * (uses.get(c.template.id) ?? 0); // a template is reused only when every other eligible one fits clearly worse
      if (slot.imageId) s -= 9 * (pairUses.get(`${c.template.id}|${slot.imageId}`) ?? 0);
      s -= 1.5 * (fam.get(c.template.family) ?? 0);
      s -= 0.5 * (familyUses.get(c.template.family) ?? 0);
      s -= 0.5 * Math.max(0, (cats.get(c.template.category) ?? 0) - 1);
      return { ...c, adj: Math.round(s * 100) / 100 };
    });
    const best = forced ? adjusted[0] : [...adjusted].sort((a, b) => b.adj - a.adj || stableHash(`${slot.slotId}|${a.template.id}`) - stableHash(`${slot.slotId}|${b.template.id}`))[0];
    const t = best.template;
    bump(uses, t.id);
    if (slot.imageId) bump(pairUses, `${t.id}|${slot.imageId}`);
    bump(familyUses, t.family);
    bump(fam, t.family);
    bump(cats, t.category);
    items.set(slot.slotId, {
      slotId: slot.slotId,
      conceptId: slot.conceptId,
      conceptName: slot.conceptName,
      index: slot.index,
      templateId: t.id,
      templateName: t.name,
      templateVersion: t.version,
      category: t.category,
      family: t.family,
      variationId: slot.variationId,
      sourceKind: slot.source,
      ...(slot.imageId !== undefined ? { imageId: slot.imageId, secondaryImageId: slot.secondaryImageId ?? null, focus: slot.focus ?? null } : {}),
      channel: slot.channel,
      format: slot.formatId,
      formatClass: slot.formatClass,
      width: slot.width,
      height: slot.height,
      content,
      rationale: origin === 'user_override' ? `Chosen by you: ${rationaleOf(best, slot, extra)}` : rationaleOf(best, slot, extra),
      score: best.adj,
      alternatives: adjusted.filter((c) => c.template.id !== t.id).slice(0, 5).map((c) => ({ templateId: c.template.id, score: c.adj })),
      origin,
    });
  }

  const ordered = slots.map((s) => items.get(s.slotId)).filter((x): x is TemplateSelectionItem => !!x);
  const byTemplate: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const it of ordered) {
    byTemplate[it.templateId] = (byTemplate[it.templateId] ?? 0) + 1;
    byCategory[it.category] = (byCategory[it.category] ?? 0) + 1;
  }
  for (const u of unplaceable) warnings.push(`${u.slotId}: ${u.reason}`);
  const repeated = Object.entries(byTemplate).filter(([, n]) => n > 1);
  if (repeated.length) warnings.push(`${repeated.length} template(s) are used more than once because no other eligible template fits those slots as well (${eligibleIds.size} eligible of ${ctx.library.length}): ${repeated.map(([id, n]) => `${id} x${n}`).join(', ')}.`);

  return {
    plan: {
      mode: ctx.mode,
      basis: ctx.basis,
      styleId: ctx.direction.styleId,
      collection: ctx.collection ? { id: ctx.collection.id, version: ctx.collection.version, name: ctx.collection.name } : null,
      libraryCount: ctx.library.length,
      eligibleCount: eligibleIds.size,
      items: ordered,
      byTemplate,
      byCategory,
      rules: [
        'Only templates from the library are used; none is invented.',
        'A template is eligible only if it is active, designed for the slot\'s format class and has all the content it requires (offers, dates and quotes only exist if you supplied them).',
        'Scores: style fit, industry, channel, density, objective, brand tone, your favourites, use of the concept\'s picture; repeating a template or layout family inside a campaign is penalized.',
        'Ties are broken by a fixed hash, so the same inputs always give the same plan.',
      ],
      warnings,
    },
    shortlists,
    unplaceable,
  };
}

/** Validates a model's re-ranking of the shortlists: every pick must come from that slot's shortlist, and no template may exceed `maxUses` uses. */
export function applyAssisted(result: SelectionResult, picks: { slotId: string; templateId: string; reason: string }[], maxUses = 2): { plan: TemplateSelectionPlan; applied: number; rejected: string[] } {
  const plan = structuredClone(result.plan);
  const rejected: string[] = [];
  const count = (id: string, except?: string) => plan.items.filter((i) => i.templateId === id && i.slotId !== except).length;
  let applied = 0;
  for (const p of picks) {
    const item = plan.items.find((i) => i.slotId === p.slotId);
    const cand = result.shortlists.get(p.slotId)?.find((c) => c.template.id === p.templateId);
    if (!item) {
      rejected.push(`${p.slotId}: unknown slot`);
      continue;
    }
    if (item.origin === 'user_override') continue; // the user's choice is never re-ranked
    if (!cand) {
      rejected.push(`${p.slotId}: ${p.templateId} is not on the shortlist`);
      continue;
    }
    if (p.templateId === item.templateId) continue;
    if (count(p.templateId, item.slotId) >= maxUses) {
      rejected.push(`${p.slotId}: ${p.templateId} would be used more than ${maxUses} times`);
      continue;
    }
    const t = cand.template;
    Object.assign(item, { templateId: t.id, templateName: t.name, templateVersion: t.version, category: t.category, family: t.family, score: cand.score, origin: 'assisted' as const, rationale: `${t.name}: ${p.reason.replace(/\s+/g, ' ').trim().slice(0, 200)} (re-ranked by the Template Selector from a validated shortlist)` });
    applied++;
  }
  plan.mode = 'assisted';
  plan.byTemplate = {};
  plan.byCategory = {};
  for (const it of plan.items) {
    plan.byTemplate[it.templateId] = (plan.byTemplate[it.templateId] ?? 0) + 1;
    plan.byCategory[it.category] = (plan.byCategory[it.category] ?? 0) + 1;
  }
  return { plan, applied, rejected };
}
