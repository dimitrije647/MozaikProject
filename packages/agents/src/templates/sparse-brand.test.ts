import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { TEMPLATE_LIBRARY } from './library';
import { placeholderImage, previewSizeFor } from './preview';
import { renderTemplate } from './render';
import { STYLE_FALLBACK_COLORS } from './styles';
import type { CreativeContent, TemplateDef } from './schema';

// A brand that supplies NOTHING: no logo and no colors. Every template must still render (the brand NAME stands in for the logo, the visual
// style's own palette stands in for the brand colors), say so honestly in its flags, and never invent a fact.

const active = TEMPLATE_LIBRARY.filter((t) => t.status === 'active');
const FACT_SLOTS = ['offer', 'offerDetail', 'date', 'location', 'quote', 'attribution', 'stat', 'statLabel', 'tag'] as const;

/** Only what a project with just a name and a description can honestly supply: the copy, never a fact. */
const copyOnly = (t: TemplateDef): CreativeContent => ({ headline: t.sample.headline, support: t.sample.support, cta: t.sample.cta, eyebrow: t.sample.eyebrow });

async function render(t: TemplateDef, cls: TemplateDef['classes'][number], withPicture: boolean) {
  const { width, height } = previewSizeFor(cls);
  const hero = withPicture ? await placeholderImage(width, height, ['#335577', '#99bbdd'], t.id) : undefined;
  return renderTemplate({ template: t, width, height, content: copyOnly(t), palette: [], styleId: t.styles[0], brandName: 'JigJoy', images: { hero, secondary: hero }, logo: null });
}

describe('templates for a brand with no logo and no colors', () => {
  it('every template that needs no user-supplied fact renders in every class it supports, with the brand name in the logo box', async () => {
    let rendered = 0;
    for (const t of active) {
      if (t.requires.some((r) => (FACT_SLOTS as readonly string[]).includes(r))) continue; // fact-gated templates are not chosen without the fact (see below)
      for (const cls of t.classes) {
        const r = await render(t, cls, true);
        assert.equal(r.ok, true, `${t.id}/${cls}: ${r.ok ? '' : r.message}`);
        if (!r.ok) continue;
        assert.ok(r.flags.includes('logo_missing_name_used'), `${t.id}/${cls}: the missing logo is reported (${r.flags.join(',')})`);
        const meta = await sharp(r.png).metadata();
        assert.equal(meta.width, r.width);
        assert.equal(meta.height, r.height);
        rendered++;
      }
    }
    assert.ok(rendered >= 40, `${rendered} renders`);
  });

  it('without brand colors the palette comes from the visual style, not from a grey default', async () => {
    const t = active.find((x) => x.styles.includes('bold_startup') && !x.requires.some((r) => (FACT_SLOTS as readonly string[]).includes(r)))!;
    assert.ok(t, 'a bold_startup template without fact requirements exists');
    const r = await renderTemplate({ template: t, width: 540, height: 540, content: copyOnly(t), palette: [], styleId: 'bold_startup', brandName: 'JigJoy', logo: null, images: { hero: await placeholderImage(540, 540, ['#335577', '#99bbdd'], 7) } });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { data, info } = await sharp(r.png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const fb = STYLE_FALLBACK_COLORS.bold_startup;
    const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const close = (px: number, c: number[]) => Math.abs(data[px * 3] - c[0]) < 40 && Math.abs(data[px * 3 + 1] - c[1]) < 40 && Math.abs(data[px * 3 + 2] - c[2]) < 40;
    let styled = 0;
    for (let i = 0; i < info.width * info.height; i++) if (close(i, hex(fb.primary)) || close(i, hex(fb.accent)) || close(i, hex(fb.secondary))) styled++;
    assert.ok(styled > info.width * info.height * 0.02, `the style palette is visible (${styled} px)`);
  });

  it('a fact-gated template is refused without its fact (never filled with an invented one)', async () => {
    const gated = active.filter((t) => t.requires.some((r) => (FACT_SLOTS as readonly string[]).includes(r)));
    assert.ok(gated.length > 0);
    for (const t of gated.slice(0, 8)) {
      const cls = t.classes[0];
      const { width, height } = previewSizeFor(cls);
      const r = await renderTemplate({ template: t, width, height, content: copyOnly(t), palette: [], styleId: t.styles[0], brandName: 'JigJoy', logo: null, images: { hero: await placeholderImage(width, height, ['#335577', '#99bbdd'], 3) } });
      assert.equal(r.ok, false, `${t.id} must not render without its required facts`);
      if (!r.ok) assert.equal(r.reason, 'missing_required');
    }
  });
});
