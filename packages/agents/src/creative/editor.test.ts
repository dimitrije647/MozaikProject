import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import sharp from 'sharp';
import { CREATIVE_FORMATS } from './formats';
import { CreativeRenderSpec, RENDERER_VERSION, editorFields, renderEdit, renderSpec, sha256Of, validateEdits, type EditInputs } from './editor';
import { flattenFor, mediaLayers, reflowText } from '../templates/adapt';
import { repairLoop } from '../templates/design-loop';
import { TEMPLATE_LIBRARY } from '../templates/library';
import { preflight, visibilityScore } from '../templates/preflight';
import { renderTemplate } from '../templates/render';
import { analyzeSubject } from '../imagery/subject';
import { formatClassOf, type PxRect, type RenderReport } from '../templates/schema';

// THE CREATIVE EDITOR, locally and deterministically: a creative is rendered the way the Creative Designer renders it, its specification is kept,
// and its text is changed. No provider, no network: the module imports none (checked below).

const PALETTE = ['#0b6e4f', '#1c1a17', '#c9a227'];

async function photo(w = 1600, h = 1200): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#3b6e8f"/><circle cx="${w * 0.55}" cy="${h * 0.45}" r="${h * 0.25}" fill="#d9a066"/><rect x="${w * 0.1}" y="${h * 0.7}" width="${w * 0.8}" height="${h * 0.12}" fill="#20303f"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}
async function logoPng(): Promise<Buffer> {
  return sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><rect x="0" y="0" width="120" height="120" rx="20" fill="#c9a227"/><rect x="140" y="40" width="240" height="40" fill="#1c1a17"/></svg>')).png().toBuffer();
}

/** What the Creative Designer stores for a creative it rendered (same steps: media layers, reflowed text, the bounded repair loop). */
async function designed(templateId: string, format: keyof typeof CREATIVE_FORMATS, kind: string, copy: Record<string, string>, inputs: EditInputs): Promise<{ spec: CreativeRenderSpec; png: Buffer; report: RenderReport }> {
  const fmt = CREATIVE_FORMATS[format];
  const lib = TEMPLATE_LIBRARY.find((t) => t.id === templateId)!;
  const content = { ...copy, brand: 'Harbour Lane Studio' } as unknown as Record<string, string> & { headline: string };
  const m = inputs.hero ? await analyzeSubject(inputs.hero) : null;
  const subject = m ? { faces: m.faces, subject: m.subject, graphic: m.graphic } : undefined;
  const template = reflowText(mediaLayers(flattenFor(lib, formatClassOf(fmt.width, fmt.height)), kind), content as never, fmt.width, fmt.height);
  const hasImg = template.layers.some((l) => l.type === 'image');
  const check = { hasLogo: !!inputs.logo, hasPicture: hasImg && !!inputs.hero, templateHasImage: hasImg, media: { kind, logoSpellsName: false, fastScroll: false, textBudget: null, pictureIsPhoto: !!inputs.hero }, density: template.density ?? null };
  const run = await repairLoop(templateId, (tune) => renderTemplate({ template, width: fmt.width, height: fmt.height, content, palette: PALETTE, brandName: 'Harbour Lane Studio', images: hasImg && inputs.hero ? { hero: inputs.hero } : {}, logo: inputs.logo ?? null, logoAdapt: true, ...(subject && hasImg ? { subject } : {}), tune }), (res) => preflight({ report: res.report, flags: res.flags, layers: res.layers, hasLogo: check.hasLogo, hasPicture: check.hasPicture, templateHasImage: hasImg, media: check.media, layout: { density: check.density } }), 4);
  const best = run.best!;
  const spec = CreativeRenderSpec.parse({
    v: 1,
    renderer: RENDERER_VERSION,
    slotId: `${templateId}-${format}`,
    templateId,
    templateVersion: lib.version,
    variant: 'base',
    template,
    width: fmt.width,
    height: fmt.height,
    palette: PALETTE,
    styleId: null,
    anchors: null,
    brandName: 'Harbour Lane Studio',
    hero: hasImg && inputs.hero ? { id: 'photo-1', sha256: sha256Of(inputs.hero) } : null,
    secondary: null,
    heroFocus: null,
    logo: inputs.logo ? { sha256: sha256Of(inputs.logo) } : null,
    logoAdapt: true,
    tune: best.tune,
    content,
    original: Object.fromEntries(best.res.drawn.filter((d) => d !== 'brand').map((d) => [d, content[d]])),
    check,
    baseline: best.pre.failures.map((f) => f.id),
    baselineVisibility: best.res.report.hero ? visibilityScore(best.res.report) : null,
    pictureKind: inputs.hero ? 'photograph' : null,
  });
  return { spec, png: best.res.png, report: best.res.report };
}

/** Canvas pixels that differ between two renders of the same size. */
async function changedPixels(a: Buffer, b: Buffer): Promise<{ x: number; y: number }[]> {
  const ra = await sharp(a).raw().toBuffer({ resolveWithObject: true });
  const rb = await sharp(b).raw().toBuffer();
  const out: { x: number; y: number }[] = [];
  const { width, channels } = ra.info;
  for (let i = 0; i < ra.data.length; i += channels) {
    if (Math.abs(ra.data[i] - rb[i]) + Math.abs(ra.data[i + 1] - rb[i + 1]) + Math.abs(ra.data[i + 2] - rb[i + 2]) > 6) out.push({ x: (i / channels) % width, y: Math.floor(i / channels / width) });
  }
  return out;
}
const grow = (r: PxRect, m: number): PxRect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
const inRect = (p: { x: number; y: number }, r: PxRect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

describe('creative editor (deterministic, no AI)', () => {
  let hero: Buffer;
  let logo: Buffer;
  before(async () => {
    hero = await photo();
    logo = await logoPng();
  });
  const copy = { headline: 'Who owns the next decision?', support: 'A calm plan for the handover of your company.', cta: 'Explore the approach' };

  it('loads the editable fields from the stored specification: only slots the template draws, the business name protected, stable ids', async () => {
    const { spec } = await designed('services_explainer', 'instagram_portrait', 'social_post', copy, { logo });
    const fields = editorFields(spec);
    assert.deepEqual(fields.map((f) => f.id).sort(), ['cta', 'headline', 'support']);
    assert.equal(fields.find((f) => f.id === 'headline')!.value, copy.headline);
    assert.equal(fields.find((f) => f.id === 'headline')!.required, true);
    assert.ok(!fields.some((f) => (f.id as string) === 'brand' || (f.id as string) === 'eyebrow'), 'no control for a slot the creative does not show');
  });

  it('reproduces the stored creative exactly from its specification', async () => {
    const d = await designed('services_explainer', 'instagram_portrait', 'social_post', copy, { logo });
    const again = await renderSpec(d.spec, { logo });
    assert.ok(again.ok);
    if (again.ok) assert.equal(sha256Of(again.png), sha256Of(d.png));
  });

  it('HEADLINE edit: only the text area changes; picture, crop, logo, palette and the other layers stay where they were', async () => {
    const d = await designed('editorial_cover_story', 'instagram_portrait', 'social_post', copy, { hero, logo });
    const r = await renderEdit(d.spec, { headline: 'Who makes the next decision?' }, { hero, logo });
    assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
    if (!r.ok) return;
    assert.equal(r.fitting, 'unchanged_layout');
    assert.equal(r.width, d.spec.width);
    assert.equal(r.height, d.spec.height);
    assert.deepEqual(r.report.logo?.rect, d.report.logo?.rect, 'the logo stays in place');
    assert.deepEqual(r.report.hero?.rect, d.report.hero?.rect, 'the picture box is the same');
    assert.equal(r.report.hero?.cropLoss, d.report.hero?.cropLoss, 'the crop is the same');
    assert.equal(r.report.texts.find((t) => t.slot === 'headline')!.text, 'Who makes the next decision?');
    const meta = await sharp(r.png).metadata();
    assert.equal(meta.width, d.spec.width);
    assert.equal(meta.height, d.spec.height);
    // every changed pixel lies in the headline area (old or new ink), nowhere else
    const head = [d.report.texts.find((t) => t.slot === 'headline')!.rect, r.report.texts.find((t) => t.slot === 'headline')!.rect].map((x) => grow(x, 6));
    const diff = await changedPixels(d.png, r.png);
    assert.ok(diff.length > 50, 'the headline really changed');
    const outside = diff.filter((p) => !head.some((h) => inRect(p, h)));
    assert.ok(outside.length < diff.length * 0.01, `${outside.length} of ${diff.length} changed pixels are outside the headline`);
  });

  it('CTA and SUPPORT edits are drawn exactly as written, without a shorter replacement or an ellipsis', async () => {
    const d = await designed('services_explainer', 'instagram_portrait', 'social_post', copy, { logo });
    const r = await renderEdit(d.spec, { cta: 'Book a call', support: 'Plan the handover step by step.' }, { logo });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.report.buttons[0].text, 'Book a call');
    assert.equal(r.report.texts.find((t) => t.slot === 'support')!.text, 'Plan the handover step by step.');
    assert.ok(!r.flags.some((f) => f.startsWith('text_trimmed') || f.startsWith('text_shortened')));
    assert.ok(!r.report.texts.some((t) => (t.text ?? '').includes('…')));
    assert.equal(r.spec.palette.join(), PALETTE.join(), 'the brand palette is kept');
  });

  it('a LONGER text is fitted by the layout (wrapping, sizing, spacing, repairs, a variant), never cut', async () => {
    const d = await designed('services_explainer', 'instagram_portrait', 'social_post', copy, { logo });
    const long = 'Who owns the next big decision when the founder steps back from the business?';
    const r = await renderEdit(d.spec, { headline: long }, { logo });
    assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
    if (!r.ok) return;
    assert.equal(r.report.texts.find((t) => t.slot === 'headline')!.text, long);
    assert.ok(!r.flags.some((f) => f.startsWith('text_trimmed')));
    assert.ok(r.report.texts.find((t) => t.slot === 'headline')!.rect.h > d.report.texts.find((t) => t.slot === 'headline')!.rect.h, 'more lines');
  });

  it('text that cannot fit is REJECTED with the field named; no image is produced and nothing is rewritten', async () => {
    const d = await designed('services_explainer', 'instagram_portrait', 'social_post', copy, { logo });
    const r = await renderEdit(d.spec, { cta: 'Explore the complete approach to company succession planning now and book a consultation call with our team today' }, { logo });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.errors.some((e) => e.field === 'cta' && /too long/.test(e.message) && /Shorten/.test(e.message)), JSON.stringify(r.errors));
    assert.ok(!('png' in r));
  });

  it('validates the input: unknown fields, too long, empty required fields; control characters are removed', () => {
    return designed('services_explainer', 'instagram_portrait', 'social_post', copy, { logo }).then(({ spec }) => {
      const bad = validateEdits(spec, { headline: '', stat: '42', support: 'x'.repeat(400) });
      assert.equal(bad.ok, false);
      if (!bad.ok) {
        assert.ok(bad.errors.some((e) => e.field === 'stat'));
        assert.ok(bad.errors.some((e) => e.field === 'headline' && /empty/.test(e.message)));
        assert.ok(bad.errors.some((e) => e.field === 'support' && /longer/.test(e.message)));
      }
      const good = validateEdits(spec, { headline: ' New\u0000 headline‮  here ' });
      assert.ok(good.ok);
      if (good.ok) assert.equal(good.values.headline, 'New headline here');
      assert.equal(validateEdits(spec, 'headline').ok, false);
      assert.equal(validateEdits(spec, { headline: 42 }).ok, false);
    });
  });

  it('markup in the text is drawn as text (escaped), never interpreted', async () => {
    const d = await designed('services_explainer', 'instagram_portrait', 'social_post', copy, { logo });
    const r = await renderEdit(d.spec, { headline: '<b>Bold</b> & "safe" <svg onload=x>' }, { logo });
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.report.texts.find((t) => t.slot === 'headline')!.text, '<b>Bold</b> & "safe" <svg onload=x>');
  });

  it('is deterministic: the same text gives the same bytes (the preview IS the saved image)', async () => {
    const d = await designed('services_explainer', 'x_post', 'social_post', copy, { logo });
    const a = await renderEdit(d.spec, { headline: 'Who decides next?' }, { logo });
    const b = await renderEdit(d.spec, { headline: 'Who decides next?' }, { logo });
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.equal(a.sha256, b.sha256);
  });

  it('a rendering failure (the picture can no longer be read) returns no image and leaves the specification untouched', async () => {
    const d = await designed('editorial_cover_story', 'instagram_portrait', 'social_post', copy, { hero, logo });
    const before = JSON.stringify(d.spec);
    const r = await renderEdit(d.spec, { headline: 'New' }, { hero: Buffer.from('not an image'), logo });
    assert.equal(r.ok, false);
    assert.equal(JSON.stringify(d.spec), before);
  });

  it('makes no provider call: the editor imports no AI client, transport or network module', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(require('node:path').join(__dirname, 'editor.ts'), 'utf8');
    for (const banned of ['openai', 'anthropic', 'gateway', 'fetch(', 'http', 'text-transport']) assert.ok(!src.toLowerCase().includes(banned), `editor.ts mentions ${banned}`);
  });
});
