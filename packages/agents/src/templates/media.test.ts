import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { getCollection, listCollections, themedTemplates } from '../collections/registry';
import { DeliverableRecord } from '../creative/schemas';
import { brandFactsOf, readBrandFacts } from '../brand/official';
import { brandFindings, templateFindings } from '../creative/checks';
import { planRepairs } from '../creative/repair';
import { ctaOptionsOf, dropWordShortenings, headlineOptionsOf, isFaithfulShortening } from '../hybrid/content';
import { DesignDiagnostics } from '../hybrid/records';
import { readF1Report } from '../audit/context';
import { extractPage } from '../tools/html';
import { brandGraphic, personScene } from '../testing/photo-fixtures';
import { analyzeSubject } from '../imagery/subject';
import { NEVER_A_PICTURE, assetKindOf, heroAccepts, mediaLayers, rankCompositions, scoreComposition, type ContentProfile } from './adapt';
import { repairLoop } from './design-loop';
import { designStatus, preflight } from './preflight';
import { renderTemplate } from './render';
import { validateTemplate, type Layer, type TemplateDef } from './schema';
import type { CreativeBoard } from '../creative/board';

// MVP CREATIVE QUALITY (inspired by the 23 reviewed FIRMENFELS GRUPPE creatives; nothing here names that company): complete text, the right
// picture for the layout, alignment, print rules, the official slogan, repetition and the routing of repairs. Local, deterministic, no model call.

const TEXT = { family: 'sans' as const, weight: 700 };
const PALETTE = ['#12305a', '#d3232a', '#f4f5f7'];
function tpl(id: string, layers: Layer[], classes: TemplateDef['classes'] = ['square', 'landscape', 'portrait', 'story', 'banner']): TemplateDef {
  const v = validateTemplate({ id, name: `Test ${id}`, version: 1, status: 'active', category: 'professional_services', description: 'A synthetic template for the media tests.', styles: ['modern_corporate'], industries: ['*'], channels: [], classes, requires: [], density: 'balanced', family: 'centered', composition: 'A synthetic composition for the media tests.', sample: { headline: 'Sample' }, tone: 'light', layers });
  assert.ok(v.ok, JSON.stringify(!v.ok && v.issues));
  return (v as { template: TemplateDef }).template;
}
const bg: Layer = { id: 'bg', type: 'rect', box: [0, 0, 1, 1], fill: 'paper' } as Layer;
const head = (box: [number, number, number, number], align: 'left' | 'center' | 'right' = 'center'): Layer => ({ id: 'headline', type: 'text', slot: 'headline', box, align, valign: 'middle', style: TEXT, color: 'ink', size: { max: 0.07, min: 0.04 }, maxLines: 3 });
const btn = (box: [number, number, number, number], size = { max: 0.04, min: 0.03 }): Layer => ({ id: 'cta-button', type: 'button', box, fill: 'primary', radius: 0.2, style: { family: 'sans', weight: 700 }, color: 'paper', size }) as Layer;
const run = async (t: TemplateDef, content: Record<string, string>, extra: Record<string, unknown> = {}, W = 1080, H = 1080) => {
  const r = await renderTemplate({ template: t, width: W, height: H, content: { headline: 'Which risk needs whose decision?', ...content }, palette: PALETTE, brandName: 'Acme Group', ...extra });
  assert.ok(r.ok, r.ok ? '' : r.message);
  return r as Extract<typeof r, { ok: true }>;
};
const pre = (r: Awaited<ReturnType<typeof run>>, media: { kind: string | null; logoSpellsName: boolean } | null = null) => preflight({ report: r.report, flags: r.flags, layers: r.layers, hasLogo: false, hasPicture: false, templateHasImage: false, media });
const ELLIPSIS = /…|\.\.\.$/;

describe('P0: complete text, never "Start the free Management and Risk Chec..."', () => {
  // a large label in a button that cannot grow enough (even the full safe width is too narrow for the long call to action at its smallest size)
  const narrow = tpl('t_narrow_cta', [bg, head([0.1, 0.3, 0.8, 0.25]), btn([0.3, 0.66, 0.4, 0.1], { max: 0.06, min: 0.055 })]);

  it('a call to action that does not fit is replaced by the longest SHORTER APPROVED wording that fits completely, never cut', async () => {
    const cta = 'Start the free Management and Risk Check';
    const options = ctaOptionsOf({ ctaText: cta, ctaShort: 'Start the free check', headline: 'h', body: 'b' });
    assert.equal(options[0], 'Start the free check', "the Content Writer's own short form comes first");
    const r = await run(narrow, { cta }, { alternatives: { cta: options } });
    const b = r.report.buttons[0];
    assert.equal(b.trimmed, false);
    assert.ok(options.includes(b.text!), `drawn: ${b.text}`);
    assert.ok(!ELLIPSIS.test(b.text!));
    assert.deepEqual(r.report.shortened?.map((s) => s.slot), ['cta']);
    assert.ok(r.flags.includes('text_shortened:cta') && !r.flags.some((f) => f.startsWith('text_trimmed')));
    assert.equal(pre(r).checks.find((c) => c.id === 'text_fit')!.status, 'pass');
  });

  it('without any approved shorter wording the cut text is a CRITICAL failure: the creative is unresolved, never approved', async () => {
    const r = await run(narrow, { cta: 'Unternehmenssteuerungsundrisikocheckanfrageformular' });
    assert.equal(r.report.buttons[0].trimmed, true);
    const p = pre(r);
    assert.equal(p.checks.find((c) => c.id === 'text_fit')!.status, 'fail');
    assert.equal(designStatus(p), 'unresolved');
  });

  it('shortening only leaves words out: no new offer, number, deadline or service is ever accepted', () => {
    const long = 'Start the free Management and Risk Check';
    for (const s of dropWordShortenings(long)) for (const w of s.split(' ')) assert.ok(long.split(' ').includes(w), `${s}: "${w}" is not in the original`);
    assert.ok(isFaithfulShortening('Start your free Risk Check', long));
    assert.ok(!isFaithfulShortening('Start your free check today', long), 'a new word ("today") is not faithful');
    assert.ok(!isFaithfulShortening('Save 50% on the check', long), 'an invented discount is rejected');
    assert.ok(!isFaithfulShortening('Start the free check…', long), 'an ellipsis is never a wording');
    assert.deepEqual(headlineOptionsOf({ headline: 'Which risks need a decision from the board this quarter?', headlineShort: 'Which risks need 3 decisions?', body: '' }), [], 'a new number in a short headline is rejected');
  });
});

describe('P1: alignment of grouped elements', () => {
  it('a centred layout keeps its button on the centre axis: an off-centre button is measured, put back and the check passes', async () => {
    const centred = tpl('t_centred', [bg, head([0.15, 0.3, 0.7, 0.2]), btn([0.52, 0.6, 0.3, 0.08])]);
    const first = await run(centred, { cta: 'Book a call' });
    const p0 = pre(first);
    assert.equal(p0.checks.find((c) => c.id === 'alignment')!.status, 'fail', 'the off-centre button is detected on the rendered geometry');
    const loop = await repairLoop('t_centred', (tune) => run(centred, { cta: 'Book a call' }, { tune }), (res) => pre(res), 4);
    const b = loop.best!.res.report.buttons[0].rect;
    assert.ok(Math.abs(b.x + b.w / 2 - 540) <= 1080 * 0.025, `button centre ${b.x + b.w / 2}`);
    assert.equal(loop.best!.pre.checks.find((c) => c.id === 'alignment')!.status, 'pass');
  });

  it('intentional asymmetry is allowed: a button outside the text column is not "misaligned"', async () => {
    const asym = tpl('t_asym', [bg, head([0.07, 0.2, 0.45, 0.3], 'left'), btn([0.62, 0.8, 0.3, 0.08])]);
    const r = await run(asym, { cta: 'Book a call' });
    assert.equal(pre(r).checks.find((c) => c.id === 'alignment')!.status, 'pass');
  });
});

describe('P0: the right picture for the layout', () => {
  const overlay = tpl('t_overlay', [{ id: 'photo', type: 'image', slot: 'hero', box: [0, 0, 1, 1] } as Layer, head([0.08, 0.6, 0.84, 0.25], 'left')]);
  const framed = tpl('t_window', [bg, { id: 'photo', type: 'image', slot: 'hero', box: [0.08, 0.08, 0.84, 0.5] } as Layer, head([0.08, 0.66, 0.84, 0.2], 'left')]);
  const profile = (kind: ContentProfile['picture'] extends infer P ? P extends { kind?: infer K } ? K : never : never): ContentProfile => ({ width: 1080, height: 1080, picture: { w: 1200, h: 630, subject: null, kind }, hasSecondPicture: false, logo: null, copy: { headline: 'Which risk needs whose decision?' }, kind: 'social_post' });

  it('a text-heavy brand graphic or a logo can never be a picture; a screenshot only where nothing is written over it', async () => {
    const banner = await brandGraphic(1200, 630);
    const m = await analyzeSubject(banner);
    assert.ok(NEVER_A_PICTURE.has(assetKindOf({ category: 'brand_graphic', text: 'Firm banner og-default', subject: m })));
    assert.equal(assetKindOf({ text: 'site-logo.png' }), 'logo');
    assert.equal(assetKindOf({ text: 'Dashboard screenshot of the reporting tool' }), 'screenshot');
    assert.deepEqual(heroAccepts(overlay, { headline: 'x' }), ['photograph', 'illustration']);
    for (const k of ['text_heavy_graphic', 'brand_graphic', 'logo', 'screenshot'] as const) assert.ok(scoreComposition(overlay, 'base', profile(k)).hard.some((h) => h.startsWith('asset_fit')), `${k} under text is refused`);
    assert.ok(!scoreComposition(framed, 'base', profile('screenshot')).hard.some((h) => h.startsWith('asset_fit')), 'a screenshot in a window is fine');
    assert.ok(scoreComposition(framed, 'base', profile('text_heavy_graphic')).hard.some((h) => h.startsWith('asset_fit')), 'a text banner is never framed as a picture either');
    assert.ok(!scoreComposition(overlay, 'base', profile('photograph')).hard.some((h) => h.startsWith('asset_fit')));
  });

  it('a team photograph is a photograph even when it sits on a plain backdrop', async () => {
    const team = await personScene({ width: 1600, height: 1000, people: [{ x: 0.3, y: 0.4, size: 0.2, tone: 'medium' }, { x: 0.6, y: 0.4, size: 0.2, tone: 'dark' }], backdrop: 'studio' });
    assert.equal(assetKindOf({ category: 'team', subject: await analyzeSubject(team) }), 'photograph');
  });
});

describe('P1: print is not a screen', () => {
  const lib = themedTemplates(getCollection('modern_corporate')!);
  const copy = { headline: 'Know your risks', cta: 'acme.example', brand: 'Acme Group' };

  it('billboard and flyer layouts carry NO button: the call to action is a written line in the headline column', () => {
    const withButtons = listCollections().flatMap((c) => themedTemplates(c)).filter((x) => x.layers.some((l) => l.type === 'button'));
    assert.ok(withButtons.length > 5, 'the library has layouts with buttons to adapt');
    for (const t of withButtons) {
      for (const kind of ['billboard', 'flyer']) {
        const m = mediaLayers(t, kind);
        assert.ok(!m.layers.some((l) => l.type === 'button'), `${t.id} (${kind}) still has a button`);
        assert.ok(m.layers.some((l) => l.type === 'text' && l.slot === 'cta'));
      }
      assert.ok(mediaLayers(t, 'display_ad').layers.some((l) => l.type === 'button'), 'a clickable ad keeps its button');
    }
    const profile: ContentProfile = { width: 1984, height: 992, picture: null, hasSecondPicture: false, logo: { w: 512, h: 512 }, copy, kind: 'billboard' };
    for (const c of rankCompositions(lib, profile).slice(0, 5)) assert.ok(!c.template.layers.some((l) => l.type === 'button'));
  });

  it('a billboard names the business in full next to a symbol-only logo, shows no button and passes the comprehension check', async () => {
    const shield = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><path d="M256 20 L470 110 L440 380 L256 492 L72 380 L42 110 Z" fill="#12305a"/></svg>')).png().toBuffer();
    const t = mediaLayers(tpl('t_bb', [bg, head([0.06, 0.25, 0.6, 0.4], 'left'), btn([0.06, 0.72, 0.25, 0.1]), { id: 'logo', type: 'logo', box: [0.06, 0.06, 0.08, 0.12], align: 'left', valign: 'top', nameStyle: TEXT, nameColor: 'ink' } as Layer], ['banner', 'landscape']), 'billboard');
    const r = await run(t, { headline: 'Know your risks', cta: 'acme.example' }, { logo: shield, tune: { brandName: true } }, 1984, 992);
    const p = pre(r, { kind: 'billboard', logoSpellsName: false });
    assert.equal(r.report.buttons.length, 0);
    assert.equal(r.report.logo?.name, true, 'the business name is written beside the shield');
    for (const id of ['media_button', 'brand_identity', 'billboard_comprehension']) assert.equal(p.checks.find((c) => c.id === id)!.status, 'pass', `${id}: ${p.checks.find((c) => c.id === id)!.detail}`);
    // the same billboard WITH a fake button and only the shield is refused (critical)
    const bad = await run(tpl('t_bb_bad', [bg, head([0.06, 0.25, 0.6, 0.4], 'left'), btn([0.06, 0.72, 0.25, 0.1]), { id: 'logo', type: 'logo', box: [0.06, 0.06, 0.08, 0.12], align: 'left', valign: 'top', nameStyle: TEXT, nameColor: 'ink' } as Layer], ['banner', 'landscape']), { cta: 'Click here' }, { logo: shield }, 1984, 992);
    const pb = pre(bad, { kind: 'billboard', logoSpellsName: false });
    assert.equal(pb.checks.find((c) => c.id === 'media_button')!.status, 'fail');
    assert.equal(pb.checks.find((c) => c.id === 'brand_identity')!.status, 'fail');
    assert.equal(designStatus(pb), 'unresolved');
  });

  it('a flyer says what to do next as written text (with the verified address), not as a dead button', async () => {
    const t = mediaLayers(tpl('t_fl', [bg, head([0.1, 0.2, 0.8, 0.2]), btn([0.3, 0.75, 0.4, 0.06])], ['portrait']), 'flyer');
    const r = await run(t, { cta: 'Start the free check – acme.example' }, {}, 1240, 1748);
    assert.equal(r.report.buttons.length, 0);
    const line = r.report.texts.find((x) => x.slot === 'cta')!;
    assert.match(line.text!, /acme\.example/);
    assert.equal(pre(r, { kind: 'flyer', logoSpellsName: true }).checks.find((c) => c.id === 'flyer_next_step')!.status, 'pass');
  });
});

describe('P1: the official slogan', () => {
  const page = (title: string, h1: string, extra = '') => extractPage(`<html lang="en"><head><title>${title}</title></head><body><h1>${h1}</h1>${extra}</body></html>`, 'https://acme.example/en');

  it('a slogan in the title that the site also shows as a heading is the OFFICIAL slogan, with its source; one title alone is not', () => {
    const f = brandFactsOf([{ url: 'https://acme.example/en', page: page('Acme Group – Stand firm. Move faster.', 'Stand firm. Move faster.', '<a href="mailto:info@acme.example">mail</a> <a href="tel:+41 44 000 00 00">call</a>') }, { url: 'https://acme.example/en/team', page: page('Our team - Acme', 'The people') }], 'Acme Group');
    assert.equal(f.officialSlogan?.text, 'Stand firm. Move faster.');
    assert.equal(f.officialSlogan?.lang, 'en');
    assert.equal(f.officialSlogan?.sourceUrl, 'https://acme.example/en');
    assert.ok(f.officialSlogan!.evidence.some((e) => e.startsWith('title')) && f.officialSlogan!.evidence.some((e) => e.startsWith('heading')));
    assert.deepEqual(f.contact.emails, ['info@acme.example']);
    const once = brandFactsOf([{ url: 'https://acme.example', page: page('Acme Group | Better decisions', 'Welcome') }], 'Acme Group');
    assert.equal(once.officialSlogan, null, 'a line seen in one place only is not claimed as the slogan');
    assert.match(once.notes[0], /not confirmed/);
  });

  it('copy that alters the official slogan or calls an invented line "our slogan" is a Content Writer finding', () => {
    const board = { variants: [
      { id: 'V1', headline: 'Stand firm, move fast.', body: 'x', visualLine: null },
      { id: 'V2', headline: 'Clarity first', body: 'Our slogan: clarity first.', visualLine: null },
      { id: 'V3', headline: 'Stand firm. Move faster.', body: 'Our slogan says it all.', visualLine: null },
    ] } as unknown as CreativeBoard;
    const f = brandFindings({ board, officialSlogan: 'Stand firm. Move faster.' });
    assert.ok(f.some((x) => x.assetRef === 'V1' && x.kind === 'inconsistent_messaging'));
    assert.ok(f.some((x) => x.assetRef === 'V2' && x.kind === 'factual_error' && x.responsibleAgent === 'copywriter'));
    assert.ok(!f.some((x) => x.assetRef === 'V3'), 'the verbatim slogan is fine');
    assert.ok(brandFindings({ board, officialSlogan: null }).some((x) => x.assetRef === 'V2' && /no official slogan/.test(x.finding)));
  });

  it('older F1 reports without brand facts stay readable (no slogan is claimed)', () => {
    assert.equal(readBrandFacts(undefined), null);
    assert.equal(readBrandFacts({ version: 2 }), null);
    void readF1Report;
  });
});

describe('P0: quality routes repairs; older records stay readable', () => {
  it('a cut call to action and a repeated concept become actionable findings: the copy is shortened by the writer and the creatives are rendered again', () => {
    const board = {
      templateQuality: { issues: [
        { slotId: 'c1-x', assetId: 'A1', kind: 'text_trimmed', severity: 'major', message: 'c1-x: the call to action did not fit and was cut; no shorter approved wording fitted either.', repairable: true },
        { slotId: 'c2-x', assetId: 'A2', kind: 'repeated_concept', severity: 'major', message: 'c2-x repeats the creative concept of c1-x in x.', repairable: true },
        { slotId: 'c3-x', assetId: 'A3', kind: 'missing_provenance', severity: 'major', message: 'c3-x: the source of its picture cannot be traced.', repairable: false },
      ] },
      selection: { items: [] },
      layouts: [{ assetId: 'A1', slotId: 'c1-x', variantId: 'V1' }, { assetId: 'A2', slotId: 'c2-x', variantId: 'V2' }, { assetId: 'A3', slotId: 'c3-x', variantId: 'V3' }],
      variants: [{ id: 'V1' }, { id: 'V2' }, { id: 'V3' }],
      templateCreatives: [],
    } as unknown as CreativeBoard;
    const raw = templateFindings({ board });
    assert.deepEqual(raw.map((r) => [r.kind, r.responsibleAgent]), [['text_overflow', 'layout'], ['repetitive', 'layout'], ['source_rights', 'visual']]);
    const findings = raw.map((r, i) => ({ ...r, id: `Q${i + 1}`, round: 1, status: 'open' as const, resolvedInRound: null }));
    const plan = planRepairs(board, findings);
    assert.deepEqual([...plan.copy.keys()], ['V1'], 'the writer shortens exactly the copy that did not fit (one call for the round)');
    assert.equal(plan.rerender.get('c1-x')?.swapTemplate, true);
    assert.equal(plan.rerender.get('c2-x')?.swapTemplate, true, 'a repeated concept is rendered with another template');
    assert.ok(plan.byFinding.some((b) => b.findingId === 'Q3' && b.operation === 'none'), 'missing provenance is never "fixed" by guessing: it stays visible');
  });

  it('records made before these fields existed still parse', () => {
    assert.ok(DesignDiagnostics.safeParse({ passed: true, checks: [], repairs: [], renders: 1, templatesTried: ['x'], templateChanged: false }).success);
    assert.ok(DeliverableRecord.safeParse({ id: 's', kind: 'billboard', label: 'Billboard', conceptId: 'c', channel: 'organic_content', format: 'billboard', width: 10, height: 5, folder: 'print/billboards', status: 'delivered', assetId: 'a', variantId: 'v', withPicture: false, reason: null }).success);
  });
});
