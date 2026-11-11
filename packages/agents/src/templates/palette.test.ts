import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bestReadable, contrast, ensureContrast, hexToHsl, hexToRgb, hslToHex, mix, normalizeHex, readableOn, relativeLuminance, rgbToHex } from './color';
import { resolvePalette } from './palette';
import { COLOR_ROLES } from './schema';

const HEX = /^#[0-9a-f]{6}$/;

describe('color helpers', () => {
  it('normalizes hex and rejects junk', () => {
    assert.equal(normalizeHex('#ABCDEF'), '#abcdef');
    assert.equal(normalizeHex('#abc'), '#aabbcc');
    assert.equal(normalizeHex(' #123456 '), '#123456');
    for (const bad of ['', 'red', '#12', '#gggggg', '123456', '#12345', '#1234567', null, undefined, 42]) assert.equal(normalizeHex(bad as never), null, String(bad));
  });

  it('converts rgb <-> hex <-> hsl without drifting', () => {
    assert.deepEqual(hexToRgb('#3157d5'), [49, 87, 213]);
    assert.equal(rgbToHex(49, 87, 213), '#3157d5');
    assert.equal(rgbToHex(-5, 300, 12.4), '#00ff0c');
    for (const c of ['#3157d5', '#f4a62a', '#14213d', '#808080', '#ffffff', '#000000']) {
      const { h, s, l } = hexToHsl(c);
      const back = hexToRgb(hslToHex(h, s, l));
      const orig = hexToRgb(c);
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - orig[i]) <= 1, `${c} channel ${i}`);
    }
  });

  it('computes WCAG luminance and contrast', () => {
    assert.equal(relativeLuminance('#ffffff'), 1);
    assert.equal(relativeLuminance('#000000'), 0);
    assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 1e-9);
    assert.ok(Math.abs(contrast('#777777', '#ffffff') - 4.48) < 0.05);
    assert.equal(contrast('#336699', '#336699'), 1);
  });

  it('mixes, picks the readable one and ensures contrast', () => {
    assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
    assert.equal(mix('#102030', '#ffffff', 0), '#102030');
    assert.equal(mix('#102030', '#ffffff', 1), '#ffffff');
    assert.equal(readableOn('#101010', '#111111', '#f0f0f0'), '#f0f0f0');
    assert.equal(bestReadable('#ffcc00', ['#ffffff', '#222222', '#000000']).color, '#000000');
    const fixed = ensureContrast('#f5d000', '#ffffff', 4.5);
    assert.ok(contrast(fixed, '#ffffff') >= 4.5);
    assert.equal(ensureContrast('#111111', '#ffffff', 4.5), '#111111'); // already fine: unchanged
    assert.ok(contrast(ensureContrast('#777777', '#808080', 5), '#808080') >= 5);
    assert.equal(ensureContrast('#777777', '#808080', 9), '#000000', 'unreachable target: the better of black and white');
  });
});

describe('resolvePalette', () => {
  it('returns every role as #rrggbb for any input', () => {
    for (const input of [[], ['#3157d5'], ['#3157d5', '#f4a62a', '#14213d'], ['nope', '#12'], ['#fff'], ['#000000'], ['#ffffff']]) {
      const p = resolvePalette(input);
      for (const role of COLOR_ROLES) assert.match(p[role], HEX, `${role} for ${JSON.stringify(input)}`);
      assert.equal(p.white, '#ffffff');
      assert.equal(p.black, '#000000');
    }
  });

  it('uses the brand colors as given (primary, secondary, accent)', () => {
    const p = resolvePalette(['#3157d5', '#e63946', '#f4a62a']);
    assert.equal(p.primary, '#3157d5');
    assert.equal(p.secondary, '#e63946');
    assert.equal(p.accent, '#f4a62a');
  });

  it('handles an empty palette with neutral defaults and the style anchors', () => {
    const p = resolvePalette([]);
    assert.match(p.primary, HEX);
    assert.notEqual(p.ink, p.paper);
    assert.ok(contrast(p.ink, p.paper) >= 7);
    assert.ok(contrast(p.accent, p.primary) >= 3, 'the derived accent stands out from the primary');
    const a = resolvePalette([], { ink: '#0f1419', paper: '#fafafa' });
    assert.equal(a.ink, '#0f1419');
    assert.equal(a.paper, '#fafafa');
  });

  it('handles a single color: derives secondary and accent, keeps primary', () => {
    const p = resolvePalette(['#2a9d8f']);
    assert.equal(p.primary, '#2a9d8f');
    assert.notEqual(p.secondary, p.primary);
    assert.notEqual(p.accent, p.primary);
    assert.ok(contrast(p.accent, p.primary) >= 3);
  });

  it('ignores invalid hex and duplicates, and accepts short hex', () => {
    const p = resolvePalette(['not-a-color', '#12', '#3157D5', '#3157d5', '#fa0']);
    assert.equal(p.primary, '#3157d5');
    assert.equal(p.secondary, '#ffaa00');
    const junk = resolvePalette(['x', '', '#zzzzzz']);
    assert.deepEqual(junk, resolvePalette([]));
  });

  it('keeps a near-white primary as given but still produces readable text colors and a visible accent', () => {
    const p = resolvePalette(['#fafafa']);
    assert.equal(p.primary, '#fafafa');
    assert.ok(contrast(p.onPrimary, p.primary) >= 4.5);
    assert.ok(contrast(p.accent, p.primary) >= 3);
    assert.ok(contrast(p.ink, p.paper) >= 7);
    assert.notEqual(p.paper, p.primary, 'paper is a tint, so a primary-colored shape still shows on it');
  });

  it('keeps a near-black primary as given and gives ink a deeper shade of it', () => {
    const p = resolvePalette(['#050505']);
    assert.equal(p.primary, '#050505');
    assert.ok(contrast(p.onPrimary, p.primary) >= 4.5);
    assert.ok(contrast(p.accent, p.primary) >= 3);
    const dark = resolvePalette(['#0a1a33', '#f4a62a']);
    assert.equal(dark.primary, '#0a1a33');
    assert.notEqual(dark.ink, dark.primary);
    assert.ok(relativeLuminance(dark.ink) < relativeLuminance(dark.primary));
  });

  it('picks ink and paper from the palette when it has a dark and a light neutral', () => {
    const p = resolvePalette(['#e63946', '#1d2433', '#f7f1e3']);
    assert.equal(p.ink, '#1d2433');
    assert.equal(p.paper, '#f7f1e3');
  });

  it('does not mistake a vivid light brand color for paper', () => {
    const p = resolvePalette(['#3157d5', '#ffe14d']);
    assert.notEqual(p.paper, '#ffe14d');
  });

  it('on-colors reach 4.5:1 on their surface across many brands', () => {
    const brands = [['#3157d5'], ['#f4b6c2', '#cde7f0', '#fbe7a1'], ['#6d28d9', '#0b1020', '#22d3ee'], ['#ffd60a'], ['#0b3d2e', '#c9a227'], ['#7a7a7a'], ['#e11d48', '#fff1f2']];
    for (const b of brands) {
      const p = resolvePalette(b);
      assert.ok(contrast(p.onPrimary, p.primary) >= 4.5, `onPrimary ${b}`);
      assert.ok(contrast(p.onAccent, p.accent) >= 4.5, `onAccent ${b}`);
      assert.ok(contrast(p.onInk, p.ink) >= 4.5, `onInk ${b}`);
      assert.ok(contrast(p.onPaper, p.paper) >= 4.5, `onPaper ${b}`);
      assert.ok(contrast(p.muted, p.paper) >= 4.5, `muted ${b}`);
    }
  });

  it('is deterministic', () => {
    assert.deepEqual(resolvePalette(['#3157d5', '#f4a62a']), resolvePalette(['#3157d5', '#f4a62a']));
  });
});
