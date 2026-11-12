import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  FORMAT_CLASSES,
  LIBRARY_VERSION,
  STYLE_IDS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LIBRARY,
  isStyleId,
  listStyles,
  renderTemplatePreview,
  type FormatClass,
  type StyleId,
  type TemplateDef,
  type ChannelId,
} from '@launchpilot/agents';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** What the gallery shows about a template: its declarative definition's metadata, never executable content. */
export function templateCard(t: TemplateDef) {
  return {
    id: t.id,
    name: t.name,
    version: t.version,
    status: t.status,
    category: t.category,
    description: t.description,
    styles: t.styles,
    industries: t.industries,
    channels: t.channels,
    classes: t.classes,
    requires: t.requires,
    density: t.density,
    family: t.family,
    composition: t.composition,
    tone: t.tone,
    sample: t.sample,
    layerCount: t.layers.length,
  };
}

/** Small in-memory LRU for rendered previews (they are pure functions of their parameters). */
class Lru<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string) {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V) {
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

@Injectable()
export class HybridService {
  private readonly cache = new Lru<Buffer>(160);

  // ---- the template library and the style library (global, read-only data) --------------------------------------------------

  listTemplates(q: { category?: string; style?: string; industry?: string; channel?: string; class?: string; q?: string } = {}) {
    const text = (q.q ?? '').toLowerCase().trim();
    const industry = (q.industry ?? '').toLowerCase().trim();
    const items = TEMPLATE_LIBRARY.filter((t) => t.status !== 'draft')
      .filter((t) => !q.category || t.category === q.category)
      .filter((t) => !q.style || t.styles.includes(q.style as StyleId))
      .filter((t) => !industry || t.industries.includes('*') || t.industries.some((i) => i.includes(industry) || industry.includes(i)))
      .filter((t) => !q.channel || t.channels.length === 0 || t.channels.includes(q.channel as ChannelId))
      .filter((t) => !q.class || t.classes.includes(q.class as FormatClass))
      .filter((t) => !text || `${t.name} ${t.description} ${t.composition} ${t.industries.join(' ')}`.toLowerCase().includes(text));
    return { version: LIBRARY_VERSION, total: TEMPLATE_LIBRARY.length, categories: TEMPLATE_CATEGORIES, styles: STYLE_IDS, classes: FORMAT_CLASSES, items: items.map(templateCard) };
  }

  getTemplate(id: string) {
    const t = TEMPLATE_LIBRARY.find((x) => x.id === id);
    if (!t) throw new NotFoundException('Template not found');
    return { ...templateCard(t), layers: t.layers };
  }

  listStyles() {
    return { items: listStyles() };
  }

  /** A PNG preview rendered from the template's own definition (the same renderer as the campaign). Parameters are validated and bounded. */
  async templatePreviewPng(id: string, q: { class?: string; palette?: string; style?: string; image?: string }): Promise<Buffer> {
    const t = TEMPLATE_LIBRARY.find((x) => x.id === id && x.status !== 'draft');
    if (!t) throw new NotFoundException('Template not found');
    const cls = (q.class ?? t.classes[0]) as FormatClass;
    if (!FORMAT_CLASSES.includes(cls) || !t.classes.includes(cls)) throw new BadRequestException(`This template is not designed for ${q.class} formats (it supports ${t.classes.join(', ')}).`);
    const palette = (q.palette ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    if (palette.length > 4 || palette.some((c) => !HEX.test(c))) throw new BadRequestException('palette must be up to 4 hex colors like #3157d5, separated by commas.');
    if (q.style && !isStyleId(q.style)) throw new BadRequestException('Unknown style.');
    const withImage = q.image !== '0';
    const key = `${t.id}@${t.version}|${cls}|${palette.join(',')}|${q.style ?? ''}|${withImage ? 1 : 0}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const r = await renderTemplatePreview({ template: t, class: cls, palette: palette.length ? palette : undefined, styleId: q.style as StyleId | undefined, withImage });
    if (!r.ok) throw new BadRequestException(r.message);
    this.cache.set(key, r.png);
    return r.png;
  }
}
