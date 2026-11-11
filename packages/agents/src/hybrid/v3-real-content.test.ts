import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { listCollections, themedTemplates } from '../collections/registry';
import { toCampaignRaster } from '../imagery/analysis';
import { F4Program } from '../runtime/programs/f4-program';
import { TEMPLATE_LIBRARY } from '../templates/library';
import { renderTemplate } from '../templates/render';
import { buildVisualDirection } from '../templates/visual-direction';
import type { TemplateDef } from '../templates/schema';
import { planHybrid } from './plan';
import type { TemplateContent } from './records';
import { availableFor, blockers, selectTemplates, type SelectorContext } from './selector';

// V3 REAL CONTENT PRODUCTION: approved pictures must actually reach the creatives. Pure and local: no model, no network, nothing billed.

const hasHero = (t: TemplateDef) => t.layers.some((l) => l.type === 'image' && l.slot !== 'secondary');
const content = (): TemplateContent => ({ headline: 'Fresh bread every morning', support: 'Baked in Novi Sad since 1998', cta: 'Visit us', eyebrow: null, variantId: 'V1' });

describe('Template Selector with approved pictures (all ten collections)', () => {
  const collections = listCollections();
  it('the ten collection ids are unchanged', () => {
    assert.deepEqual(collections.map((c) => c.id).sort(), ['bold_startup', 'clean_ecommerce', 'contemporary_geometric', 'dynamic_events', 'lifestyle_human', 'luxury_hospitality', 'minimal_tech', 'modern_corporate', 'premium_editorial', 'soft_organic']);
  });

  for (const c of collections) {
    it(`${c.id}: every creative that has a picture is drawn with a photo template whenever one fits; 20 distinct creatives; only the collection's templates`, () => {
      const library = themedTemplates(c);
      const plan = planHybrid({ concepts: Array.from({ length: 5 }, (_, i) => ({ id: `K${i + 1}`, name: `Concept ${i + 1}`, channels: ['instagram', 'facebook', 'linkedin'] as never })), originals: 0, templateCreatives: 20, channelPriority: ['instagram', 'facebook', 'linkedin'], fixedSize: null, brandImages: 4, basis: 'concepts' });
      // like the real allocation: 8 approved pictures, each concept gets its own two (a picture serves several creatives, cropped per format)
      const slots = plan.slots.map((s) => { const k = Number(s.conceptId.slice(1)) - 1; return { ...s, source: 'brand_image' as const, imageId: `img${(k * 2 + (s.index % 2)) % 8}`, secondaryImageId: null }; });
      const ctx: SelectorContext = { direction: buildVisualDirection({ projectName: 'Bakery', channels: ['instagram'], brandPalette: ['#8a4b2a'], userStyleId: c.styleId }), industryText: 'bakery food', objectiveText: 'visit the shop', palette: ['#8a4b2a', '#f4e9dc'], hasLogo: true, brandName: 'Bakery', facts: {}, library, preferred: [], overrides: {}, mode: 'automatic', basis: 'concepts', collection: c };
      const contents = new Map(slots.map((s) => [s.slotId, content()]));
      const r = selectTemplates({ slots, contents, ctx });
      assert.equal(r.plan.items.length, 20, `20 creatives placed (${r.unplaceable.map((u) => u.reason).join('; ')})`);
      const ids = new Set(library.map((t) => t.id));
      let photo = 0;
      for (const item of r.plan.items) {
        assert.ok(ids.has(item.templateId), 'the selected collection is preserved');
        const slot = slots.find((s) => s.slotId === item.slotId)!;
        const placed = { ...slot, formatId: item.format, width: item.width, height: item.height, formatClass: item.formatClass, channel: item.channel };
        const photoFits = library.some((t) => hasHero(t) && blockers(t, placed as never, availableFor(placed as never, content(), ctx)).length === 0);
        const chosen = library.find((t) => t.id === item.templateId)!;
        // typography only when no photo template fits, or every fitting one already made this exact creative (and the rationale says so)
        if (photoFits && !hasHero(chosen)) assert.match(item.rationale, /already used with this picture in this format/, `${item.slotId}: an approved picture was replaced by typography without a reason (${chosen.id})`);
        if (hasHero(chosen)) photo++;
      }
      assert.ok(photo >= 10, `${c.id}: most creatives show the approved pictures (${photo}/20)`);
      // distinct creatives: never the same template on the same picture in the same format twice
      const keys = r.plan.items.map((it) => `${it.templateId}|${slots.find((s) => s.slotId === it.slotId)!.imageId}|${it.format}`);
      assert.equal(new Set(keys).size, keys.length);
    });
  }
});

describe('Rendering with real brand content', () => {
  it('an SVG (or otherwise unreadable) logo never fails a creative: the brand name is drawn and the creative says why', async () => {
    const t = TEMPLATE_LIBRARY.find((x) => x.layers.some((l) => l.type === 'logo') && !x.requires.includes('image') && !x.requires.includes('logo'))!;
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    const res = await renderTemplate({ template: t, width: 1080, height: 1080, content: { headline: 'Fresh bread every morning' }, palette: ['#8a4b2a'], brandName: 'Bakery', images: {}, logo: svg } as never);
    assert.equal(res.ok, true, res.ok ? '' : ((res as { message?: string }).message ?? 'render failed'));
    assert.ok((res as { flags: string[] }).flags.includes('logo_unreadable'));
  });

  it('a GIF or AVIF website picture is stored as PNG at import (never dropped later); PNG/JPEG stay untouched', async () => {
    const gif = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#8a4b2a' } }).gif().toBuffer();
    const g = await toCampaignRaster(gif);
    assert.equal(g?.mimeType, 'image/png');
    assert.equal((await sharp(g!.data).metadata()).format, 'png');
    const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    const j = await toCampaignRaster(jpg);
    assert.equal(j?.mimeType, 'image/jpeg');
    assert.ok(j!.data.equals(jpg));
    assert.equal(await toCampaignRaster(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null, 'SVG is never rasterized');
  });
});

describe('Claude campaigns make no images', () => {
  it('a Claude creative run that asks for an AI image is refused before anything exists (never sent to OpenAI instead)', () => {
    assert.throws(
      () => new F4Program({ provider: 'anthropic', apiKey: 'sk-ant-api03-TESTKEY1234567890abcdef' }, { model: 'claude-opus-5-5', imageModel: 'gpt-image-1-mini', maxImages: 1 } as never, async () => {}),
      /Claude generates no images/,
    );
  });
});
