import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import sharp from 'sharp';
import { flattenFor, mediaLayers, reflowText } from './adapt';
import { chooseSecondary, frameReport, judgeFrame, planCrop, type FrameCandidate } from './crop';
import { repairLoop } from './design-loop';
import { TEMPLATE_LIBRARY } from './library';
import { CRITICAL_CHECKS, designStatus, preflight } from './preflight';
import { renderTemplate } from './render';
import type { RenderSubject, UnitBox } from './schema';

// MEANINGFUL CROPS of the small second picture of two-picture layouts (the FIRMENFELS TikTok covers showed half a face at the frame edge and
// slices of a group). Face positions are given explicitly (the detector is a heuristic; these tests check what the crop and the checks do with
// its evidence). Pictures are synthetic: no private photograph is a fixture.

async function picture(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#4a5d6e' } }).jpeg().toBuffer();
}
/** n faces side by side starting at x0, every `step` apart (fractions of the picture), heads at the same height */
function group(n: number, x0: number, step: number, fw: number, fy = 0.3, fh = 0.18): RenderSubject {
  const faces: UnitBox[] = Array.from({ length: n }, (_, i) => [x0 + i * step, fy, fw, fh]);
  const left = Math.max(0, x0 - fw * 0.3);
  const right = Math.min(1, x0 + (n - 1) * step + fw * 1.3);
  return { faces, subject: [left, Math.max(0, fy - fh * 0.6), right - left, Math.min(1 - Math.max(0, fy - fh * 0.6), 0.7)], graphic: false };
}

const story = () => {
  const t0 = TEMPLATE_LIBRARY.find((t) => t.id === 'ecommerce_new_collection')!;
  const content = { headline: 'Who owns the next decision?', cta: 'Explore the approach', brand: 'Northwind' };
  return { t0, content, template: reflowText(mediaLayers(flattenFor(t0, 'story'), 'social_post'), content as never, 1080, 1920) };
};
const check = (template: { density?: 'airy' | 'balanced' | 'dense' }) => (res: { report: Parameters<typeof preflight>[0]['report']; flags: string[]; layers: string[] }) =>
  preflight({ report: res.report, flags: res.flags, layers: res.layers, hasLogo: false, hasPicture: true, templateHasImage: true, media: { kind: 'social_post', logoSpellsName: false, fastScroll: true, pictureIsPhoto: true }, layout: { density: template.density } });

describe('meaningful crops of the second picture', () => {
  let hero: Buffer;
  before(async () => {
    hero = await picture(2000, 2000);
  });

  it('FACES NEAR THE FRAME EDGE: the old centre crop cut two faces; the subject-aware crop shows a whole face and the check passes', async () => {
    const { template } = story();
    const sec = await picture(1500, 1000);
    const subject = group(2, 0.3, 0.32, 0.1);
    const res = await renderTemplate({ template, width: 1080, height: 1920, content: { headline: 'Who owns the next decision?', cta: 'Explore the approach' }, palette: ['#14213d', '#ffffff'], brandName: 'Northwind', images: { hero, secondary: sec }, secondarySubject: subject });
    assert.ok(res.ok);
    if (!res.ok) return;
    const s = res.report.secondary!;
    assert.ok(s, 'the second frame is reported');
    // what the renderer did before (a centre crop that knows nothing about the people) on the same frame
    const centre = planCrop({ imgW: 1500, imgH: 1000, bw: Math.round(s.rect.w), bh: Math.round(s.rect.h), focus: [0.5, 0.5], layerRect: s.rect, canvasW: 1080, canvasH: 1920 });
    const old = judgeFrame(frameReport(s.rect, centre, 1500, 1000, subject, false));
    assert.equal(old.status, 'fail', 'the centre crop cut the faces');
    assert.match(old.problems[0], /cut by the edge/);
    // now: a whole face, nobody cut
    assert.ok(s.faces.some((f) => f.inFrame >= 0.85));
    assert.ok(!s.faces.some((f) => f.inFrame > 0.15 && f.inFrame < 0.85));
    const pre = check(template)(res);
    assert.equal(pre.checks.find((c) => c.id === 'secondary_crop')!.status, 'pass');
    assert.ok(res.flags.includes('crop_subject_aware:secondary'));
  });

  it('a WIDE GROUP picture in a NARROW PORTRAIT frame is unintelligible: secondary_crop fails (critical) and showing it whole is refused (it would be a thin strip)', async () => {
    const { t0, template } = story();
    const pano = await picture(4000, 1000);
    const packed = group(8, 0.08, 0.105, 0.1, 0.25, 0.3);
    const run = await repairLoop(t0.id, (tune) => renderTemplate({ template, width: 1080, height: 1920, content: { headline: 'Who owns the next decision?', cta: 'Explore the approach' }, palette: ['#14213d', '#ffffff'], brandName: 'Northwind', images: { hero, secondary: pano }, secondarySubject: packed, tune }), check(template), 4);
    const best = run.best!;
    const c = best.pre.checks.find((x) => x.id === 'secondary_crop')!;
    assert.equal(c.status, 'fail', c.detail);
    assert.ok(CRITICAL_CHECKS.has('secondary_crop'));
    assert.equal(designStatus(best.pre), 'unresolved', 'never certified as finished');
    assert.notEqual(best.tune.secondaryFit, 'contain', 'a 4:1 picture letterboxed into a portrait frame is not a fix');
    assert.ok(best.res.report.secondary!.containFill < 0.55);
  });

  it('a GROUP photo in a SMALL square window that only fits a slice of it: the repair shows the whole picture when that still fills the frame', async () => {
    const t0 = TEMPLATE_LIBRARY.find((t) => t.id === 'hospitality_food_showcase')!;
    const content = { headline: 'A table for the whole team', cta: 'Book now', brand: 'Northwind' };
    const template = reflowText(mediaLayers(flattenFor(t0, 'square'), 'social_post'), content as never, 1080, 1080);
    const sec = await picture(1500, 1000);
    const packed = group(6, 0.06, 0.15, 0.12, 0.25, 0.25);
    const run = await repairLoop(t0.id, (tune) => renderTemplate({ template, width: 1080, height: 1080, content, palette: ['#7a2e2e', '#fff7ec'], brandName: 'Northwind', images: { hero, secondary: sec }, secondarySubject: packed, tune }), check(template), 4);
    const best = run.best!;
    assert.equal(best.tune.secondaryFit, 'contain');
    assert.equal(best.res.report.secondary!.fit, 'contain');
    assert.equal(best.pre.checks.find((x) => x.id === 'secondary_crop')!.status, 'pass');
    assert.ok(best.actions.some((a) => a.kind === 'crop' && /whole second picture/.test(a.detail)));
  });

  it('the SAME photograph twice in one creative fails', async () => {
    const { template } = story();
    const res = await renderTemplate({ template, width: 1080, height: 1920, content: { headline: 'Who owns the next decision?', cta: 'Explore the approach' }, palette: ['#14213d', '#ffffff'], brandName: 'Northwind', images: { hero, secondary: hero } });
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.report.secondary!.sameAsHero, true);
    const c = check(template)(res).checks.find((x) => x.id === 'secondary_crop')!;
    assert.equal(c.status, 'fail');
    assert.match(c.detail, /same photograph appears twice/);
  });

  it('without face evidence only a WARNING is given for a narrow slice (the detector may have missed the people)', () => {
    const plan = planCrop({ imgW: 3000, imgH: 1000, bw: 360, bh: 715, focus: [0.5, 0.5], layerRect: { x: 0, y: 0, w: 360, h: 715 }, canvasW: 1080, canvasH: 1920, subject: { faces: [], subject: [0.05, 0.1, 0.9, 0.8], graphic: false } });
    const j = judgeFrame(frameReport({ x: 0, y: 0, w: 360, h: 715 }, plan, 3000, 1000, { faces: [], subject: [0.05, 0.1, 0.9, 0.8], graphic: false }, false));
    assert.equal(j.status, 'warn');
  });

  it('ALTERNATIVE PICTURE: a second picture that would show a fragment is replaced by an approved photograph that frames a whole person; the main photo is never repeated', () => {
    const rect = { x: 86, y: 936, w: 360, h: 715 };
    const groupPic: FrameCandidate = { id: 'group', w: 4000, h: 1000, subject: group(8, 0.08, 0.105, 0.1, 0.25, 0.3), uses: 0 };
    const portrait: FrameCandidate = { id: 'portrait', w: 800, h: 1200, subject: { faces: [[0.4, 0.2, 0.2, 0.15]], subject: [0.25, 0.1, 0.5, 0.85], graphic: false }, uses: 1 };
    const pick = chooseSecondary({ rect, canvasW: 1080, canvasH: 1920, heroId: 'hero', assigned: groupPic, others: [portrait] });
    assert.deepEqual(pick, { id: 'portrait', replaced: true, problem: pick.problem });
    assert.ok(pick.problem && /face|fragment/.test(pick.problem));
    // the assigned picture is fine: kept
    assert.deepEqual(chooseSecondary({ rect, canvasW: 1080, canvasH: 1920, heroId: 'hero', assigned: portrait, others: [groupPic] }), { id: 'portrait', replaced: false, problem: null });
    // the assigned second picture IS the main photograph: another one is used
    const same = chooseSecondary({ rect, canvasW: 1080, canvasH: 1920, heroId: 'hero', assigned: { ...portrait, id: 'hero' }, others: [portrait] });
    assert.equal(same.id, 'portrait');
    // nothing better exists: the assigned one stays and its problem is named (the preflight and the layout choice decide)
    const none = chooseSecondary({ rect, canvasW: 1080, canvasH: 1920, heroId: 'hero', assigned: groupPic, others: [] });
    assert.equal(none.id, 'group');
    assert.ok(none.problem);
  });
});
