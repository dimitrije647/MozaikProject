import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHANNEL_IDS } from '../strategy/channels';
import { STYLE_IDS, StyleDef, TEMPLATE_CATEGORIES } from './schema';
import { STYLES, STYLE_FALLBACK_COLORS, STYLE_MOODS, foldForMatch, getStyle, isStyleId, listStyles, matchStyles } from './styles';

const top = (ctx: Parameters<typeof matchStyles>[0]) => matchStyles(ctx)[0]!.style.id;

describe('style library', () => {
  it('has exactly the ten styles, each valid against the StyleDef schema, ids unique and in STYLE_IDS order', () => {
    assert.equal(STYLES.length, 10);
    assert.deepEqual(STYLES.map((s) => s.id), [...STYLE_IDS]);
    assert.equal(new Set(STYLES.map((s) => s.id)).size, 10);
    assert.equal(new Set(STYLES.map((s) => s.name)).size, 10);
    for (const s of STYLES) {
      const r = StyleDef.safeParse(s);
      assert.ok(r.success, `${s.id}: ${r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))}`);
    }
  });

  it('every template category is covered by at least one style, and every style has real content', () => {
    for (const cat of TEMPLATE_CATEGORIES) assert.ok(STYLES.some((s) => s.templateCategories.includes(cat)), `category ${cat} has no style`);
    for (const s of STYLES) {
      assert.ok(s.keywords.length >= 3 && s.keywords.every((k) => k.trim().length > 0), `${s.id} keywords`);
      assert.ok(s.industries.length >= 1);
      assert.ok(s.composition.length >= 3, `${s.id} composition`);
      assert.ok(s.photography.subjects.length >= 3 && s.photography.treatment.length >= 2 && s.photography.avoid.length >= 2, `${s.id} photography`);
      assert.ok(s.channels.every((c) => (CHANNEL_IDS as readonly string[]).includes(c)));
      assert.ok(s.channels.length >= 3, `${s.id} channels`);
      assert.match(s.color.ink, /^#[0-9A-F]{6}$/i);
      assert.match(s.color.paper, /^#[0-9A-F]{6}$/i);
    }
  });

  it('the three densities and the five font families are all in use (the library is not ten copies of one idea)', () => {
    assert.deepEqual([...new Set(STYLES.map((s) => s.density))].sort(), ['airy', 'balanced', 'dense']);
    assert.ok(new Set(STYLES.map((s) => s.typography.headline.family)).size >= 4);
    assert.ok(new Set(STYLES.map((s) => s.color.ink)).size === 10, 'ink anchors differ per style');
  });

  it('per-style extras exist for every style and are well formed', () => {
    for (const id of STYLE_IDS) {
      assert.ok(STYLE_MOODS[id].length >= 3 && STYLE_MOODS[id].every((m) => m.length <= 40));
      for (const c of Object.values(STYLE_FALLBACK_COLORS[id])) assert.match(c, /^#[0-9A-F]{6}$/i);
    }
  });

  it('getStyle / listStyles / isStyleId', () => {
    for (const id of STYLE_IDS) assert.equal(getStyle(id).id, id);
    assert.throws(() => getStyle('nope' as never));
    assert.equal(listStyles().length, 10);
    assert.notEqual(listStyles(), listStyles(), 'a fresh array each time');
    assert.equal(isStyleId('bold_startup'), true);
    assert.equal(isStyleId('auto'), false);
    assert.equal(isStyleId(undefined), false);
    assert.equal(isStyleId(7), false);
  });
});

describe('foldForMatch', () => {
  it('ignores accents and case, handles đ and Serbian Cyrillic', () => {
    assert.equal(foldForMatch('Kafić'), 'kafic');
    assert.equal(foldForMatch('ŽURKA čaj šuma ćup'), 'zurka caj suma cup');
    assert.equal(foldForMatch('Događaj'), 'dogadaj');
    assert.equal(foldForMatch('ресторан'), 'restoran');
    assert.equal(foldForMatch('Љубав'), 'ljubav');
  });
});

describe('matchStyles', () => {
  it('returns ALL ten styles ranked, with reasons, and is deterministic', () => {
    const ctx = { industry: 'restaurant', text: 'Tasting menu on Friday', channels: ['instagram' as const] };
    const a = matchStyles(ctx);
    const b = matchStyles({ ...ctx });
    assert.equal(a.length, 10);
    assert.deepEqual(new Set(a.map((m) => m.style.id)), new Set(STYLE_IDS));
    assert.deepEqual(a.map((m) => [m.style.id, m.score, m.reasons]), b.map((m) => [m.style.id, m.score, m.reasons]));
    for (const m of a) {
      assert.ok(m.reasons.length >= 1 && m.reasons.every((r) => r.trim().length > 4));
      assert.ok(Number.isFinite(m.score) && m.score >= 0);
    }
    for (let i = 1; i < a.length; i++) assert.ok(a[i - 1]!.score >= a[i]!.score, 'sorted by score');
  });

  it('with no signal every score is 0 and the tie is broken by id', () => {
    const r = matchStyles({});
    assert.ok(r.every((m) => m.score === 0));
    assert.deepEqual(r.map((m) => m.style.id), [...STYLE_IDS].sort());
    const r2 = matchStyles({ text: 'zzz qqq xxx' });
    assert.deepEqual(r2.map((m) => m.style.id), [...STYLE_IDS].sort());
  });

  it('restaurant / restoran / ugostiteljstvo point to hospitality styles', () => {
    for (const industry of ['restaurant', 'restoran', 'Restorani', 'ugostiteljstvo', 'ресторан']) {
      assert.ok(['luxury_hospitality', 'lifestyle_photography'].includes(top({ industry })), `${industry} -> ${top({ industry })}`);
    }
    assert.ok(['luxury_hospitality', 'lifestyle_photography'].includes(top({ text: 'Novi restoran u centru grada, večera uz svijeće' })));
  });

  it('cafe / kafić points to lifestyle photography', () => {
    assert.equal(top({ industry: 'kafić' }), 'lifestyle_photography');
    assert.equal(top({ industry: 'cafe' }), 'lifestyle_photography');
    assert.equal(top({ text: 'Naš kafic i pekara' }), 'lifestyle_photography');
  });

  it('software for developers points to minimalist_tech or bold_startup', () => {
    assert.ok(['minimalist_tech', 'bold_startup'].includes(top({ text: 'SaaS dashboard for developers' })));
    assert.equal(top({ text: 'SaaS dashboard for developers' }), 'minimalist_tech');
    assert.equal(top({ industry: 'software', audience: 'developers' }), 'minimalist_tech');
    assert.equal(top({ industry: 'tehnologija' }), 'minimalist_tech');
    assert.equal(top({ text: 'Mobile app launch for founders, join the waitlist' }), 'bold_startup');
  });

  it('events point to dynamic_events in English and Serbian/Croatian', () => {
    assert.equal(top({ text: 'concert' }), 'dynamic_events');
    assert.equal(top({ text: 'summer festival' }), 'dynamic_events');
    assert.equal(top({ text: 'događaj' }), 'dynamic_events');
    assert.equal(top({ text: 'Veliki dogadjaj u subotu, ulaznice u prodaji' }), 'dynamic_events');
    assert.equal(top({ industry: 'koncerti' }), 'dynamic_events');
    assert.equal(top({ industry: 'events' }), 'dynamic_events');
  });

  it('online shop / discount / prodavnica point to clean_ecommerce', () => {
    assert.equal(top({ text: 'online shop discount' }), 'clean_ecommerce');
    assert.equal(top({ industry: 'webshop' }), 'clean_ecommerce');
    assert.equal(top({ industry: 'prodavnica' }), 'clean_ecommerce');
    assert.equal(top({ text: 'Akcija: popust na sve proizvode, besplatna dostava' }), 'clean_ecommerce');
    assert.equal(top({ industry: 'e-commerce' }), 'clean_ecommerce');
  });

  it('professional services and wellness land on their styles', () => {
    assert.equal(top({ industry: 'usluge' }), 'modern_corporate');
    assert.equal(top({ industry: 'consulting' }), 'modern_corporate');
    assert.equal(top({ industry: 'konsalting' }), 'modern_corporate');
    assert.equal(top({ industry: 'wellness' }), 'soft_lifestyle');
    assert.equal(top({ industry: 'skincare', tone: 'gentle and calm' }), 'soft_lifestyle');
    assert.equal(top({ industry: 'design agency' }), 'contemporary_geometric');
    assert.equal(top({ tone: 'elegant, refined, editorial' }), 'premium_editorial');
    assert.equal(top({ industry: 'fine dining' }), 'luxury_hospitality');
  });

  it('is accent- and case-insensitive: the same text with or without diacritics ranks identically', () => {
    const pairs: [string, string][] = [
      ['kafić', 'kafic'],
      ['DOGAĐAJ', 'dogadaj'],
      ['Žurka u gradu', 'zurka u gradu'],
      ['ugostiteljstvo', 'UGOSTITELJSTVO'],
      ['Sniženje cijena', 'snizenje cijena'],
    ];
    for (const [a, b] of pairs) {
      const ra = matchStyles({ text: a });
      const rb = matchStyles({ text: b });
      assert.deepEqual(ra.map((m) => [m.style.id, m.score]), rb.map((m) => [m.style.id, m.score]), `${a} vs ${b}`);
    }
  });

  it('matches whole words, not substrings: "offering" is not "offer", "software" is not "soft"', () => {
    const offering = matchStyles({ text: 'our offering' }).find((m) => m.style.id === 'clean_ecommerce')!;
    assert.equal(offering.score, 0);
    const software = matchStyles({ text: 'software' }).find((m) => m.style.id === 'soft_lifestyle')!;
    assert.equal(software.score, 0);
  });

  it('accepts a plural of a keyword', () => {
    assert.ok(matchStyles({ text: 'concerts and festivals' }).find((m) => m.style.id === 'dynamic_events')!.score > 0);
    assert.ok(matchStyles({ industry: 'restaurants' })[0]!.score > 0);
  });

  it('channels and the category hint add to the score without overriding the text', () => {
    const base = matchStyles({ text: 'concert' }).find((m) => m.style.id === 'dynamic_events')!.score;
    const withChannels = matchStyles({ text: 'concert', channels: ['tiktok', 'instagram'] }).find((m) => m.style.id === 'dynamic_events')!;
    assert.ok(withChannels.score > base);
    assert.ok(withChannels.reasons.some((r) => /tiktok/i.test(r)));
    const events = matchStyles({ categoryHint: 'events_entertainment' });
    assert.deepEqual(events.slice(0, 2).map((m) => m.style.id), ['contemporary_geometric', 'dynamic_events']);
    assert.equal(events[0]!.score, 3);
    assert.equal(top({ categoryHint: 'events_entertainment', text: 'concert' }), 'dynamic_events');
    const pro = matchStyles({ categoryHint: 'professional_services', channels: ['linkedin'] });
    assert.deepEqual(new Set(pro.slice(0, 3).map((m) => m.style.id)), new Set(['contemporary_geometric', 'minimalist_tech', 'modern_corporate']));
    assert.equal(top({ categoryHint: 'professional_services', industry: 'consulting' }), 'modern_corporate');
    const hint = matchStyles({ categoryHint: 'ecommerce' });
    assert.ok(['clean_ecommerce', 'premium_editorial', 'bold_startup', 'soft_lifestyle'].includes(hint[0]!.style.id));
    assert.ok(hint[0]!.reasons.some((r) => /e-commerce/.test(r)));
    // a strong text signal beats a category hint for another style
    assert.equal(top({ categoryHint: 'ecommerce', industry: 'restaurant', text: 'fine dining tasting menu' }), 'luxury_hospitality');
  });

  it('a long text repeating one theme does not drown a clear industry', () => {
    const noise = 'event '.repeat(40);
    assert.equal(top({ industry: 'software', text: noise }), 'minimalist_tech');
  });

  it('reasons name the words found in the brief', () => {
    const r = matchStyles({ industry: 'restaurant' }).find((m) => m.style.id === 'luxury_hospitality')!;
    assert.ok(r.reasons.some((x) => x.includes('restaurant')));
    const k = matchStyles({ text: 'Tražimo kafić' }).find((m) => m.style.id === 'lifestyle_photography')!;
    assert.ok(k.reasons.some((x) => x.includes('kafić')), 'reasons quote the user\'s own word');
  });

  it('does not mutate the context and tolerates odd values', () => {
    const ctx = { industry: 'cafe', channels: ['instagram' as const, 'instagram' as const] };
    const copy = JSON.parse(JSON.stringify(ctx));
    matchStyles(ctx);
    assert.deepEqual(ctx, copy);
    assert.equal(matchStyles({ industry: undefined, text: '', channels: [] }).length, 10);
  });
});
