import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PERMISSION_STATUS, REFERENCE_KINDS, STYLE_IDS, VisualDirectionBrief } from './schema';
import {
  LINK_ONLY_USED,
  NOT_ANALYZED_PLATFORM,
  NO_TEXT_SENTENCE,
  REFERENCE_POLICY,
  buildVisualDirection,
  describeColor,
  referenceMayContribute,
  visualDirectionForPrompt,
  visualDirectionSummary,
  type VisualDirectionInput,
  type VisualReferenceInput,
} from './visual-direction';

const base = (o: Partial<VisualDirectionInput> = {}): VisualDirectionInput => ({ projectName: 'Test Project', channels: ['instagram', 'facebook'], brandPalette: [], ...o });
const rich = (o: Partial<VisualDirectionInput> = {}): VisualDirectionInput =>
  base({
    projectName: 'Casa Verde',
    industry: 'restaurant',
    productSummary: 'A neighborhood restaurant serving seasonal Mediterranean dishes with a weekly tasting menu. Open for dinner Tuesday to Sunday.',
    audience: 'Couples and small groups looking for a relaxed evening out',
    tone: 'warm, elegant',
    objective: 'Get more table reservations for weekend dinners',
    designDirection: 'Candlelit, intimate, natural materials',
    channels: ['instagram', 'facebook', 'email'],
    brandPalette: ['#1F4D3A', '#C8A15A', '#F2E8D5'],
    ...o,
  });

const ref = (o: Partial<VisualReferenceInput> & Pick<VisualReferenceInput, 'id' | 'kind' | 'permission'>): VisualReferenceInput => ({ label: `Ref ${o.id}`, ...o });
const PIN = 'https://www.pinterest.com/someone/secret-board-name/';
const LINK = 'https://example.com/inspiration/my-private-moodboard-xyz';

const valid = (b: unknown) => {
  const r = VisualDirectionBrief.safeParse(b);
  assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 4)));
  return r.data!;
};
const withoutRefs = (b: VisualDirectionBrief) => ({ ...b, references: [] });

describe('buildVisualDirection: shape and determinism', () => {
  it('always returns a brief that is valid against the VisualDirectionBrief schema', () => {
    const inputs: VisualDirectionInput[] = [
      base(),
      rich(),
      rich({ userStyleId: 'dynamic_events' }),
      base({ brandPalette: ['#000000'], channels: ['tiktok', 'youtube', 'linkedin', 'google_search', 'email', 'organic_content', 'community', 'facebook', 'instagram'] }),
      base({ brandPalette: ['#fff', '#12345', 'red', 'rgb(1,2,3)', '#AABBCC'], industry: 'software', productSummary: 'x'.repeat(5000), audience: 'y'.repeat(2000), tone: 'z '.repeat(500), objective: 'sale '.repeat(300), designDirection: 'w '.repeat(900) }),
      rich({ references: Array.from({ length: 40 }, (_, i) => ref({ id: `r${i}`, kind: 'user_upload', permission: 'user_provided', label: 'L'.repeat(300), note: 'n'.repeat(400), palette: ['#112233', '#445566'], url: `https://example.com/${'a'.repeat(400)}` })) }),
      { projectName: '', channels: [], brandPalette: [] },
      { projectName: 'x', channels: ['instagram', 'instagram', 'bogus' as never], brandPalette: undefined as never },
    ];
    for (const i of inputs) {
      const b = buildVisualDirection(i);
      valid(b);
      assert.equal(b.origin, 'deterministic');
      assert.ok((STYLE_IDS as readonly string[]).includes(b.styleId));
    }
  });

  it('is deterministic and does not mutate its input', () => {
    const i = rich({
      references: [
        ref({ id: 'logo', kind: 'brand_asset', permission: 'owned_by_user', palette: ['#336699', '#CC9933'], note: 'Primary logo' }),
        ref({ id: 'pin', kind: 'pinterest_board', permission: 'platform_restricted_not_stored', url: PIN }),
      ],
    });
    const snapshot = JSON.parse(JSON.stringify(i));
    const a = buildVisualDirection(i);
    const b = buildVisualDirection(i);
    assert.deepEqual(a, b);
    assert.deepEqual(buildVisualDirection(JSON.parse(JSON.stringify(i))), a);
    assert.deepEqual(i, snapshot);
    assert.equal(visualDirectionForPrompt(a), visualDirectionForPrompt(b));
  });

  it('does not depend on the order of equal-status channels beyond listing them', () => {
    const a = buildVisualDirection(rich({ channels: ['instagram', 'email'] }));
    const b = buildVisualDirection(rich({ channels: ['email', 'instagram'] }));
    assert.equal(a.styleId, b.styleId);
    assert.deepEqual(a.colors, b.colors);
    assert.deepEqual(a.channelNotes.map((n) => n.channel).sort(), b.channelNotes.map((n) => n.channel).sort());
  });
});

describe('buildVisualDirection: style choice', () => {
  it('auto picks from the brief', () => {
    assert.equal(buildVisualDirection(rich()).styleId, 'luxury_hospitality');
    assert.equal(buildVisualDirection(rich({ userStyleId: 'auto' })).styleId, 'luxury_hospitality');
    assert.equal(buildVisualDirection(base({ industry: 'SaaS', productSummary: 'A dashboard for developers', audience: 'engineering teams' })).styleId, 'minimalist_tech');
    assert.equal(buildVisualDirection(base({ industry: 'događaji', productSummary: 'Organizujemo koncerte i festivale' })).styleId, 'dynamic_events');
    assert.equal(buildVisualDirection(base({ industry: 'online shop', objective: 'discount on the summer collection' })).styleId, 'clean_ecommerce');
  });

  it('the style the user selected always wins over the automatic one', () => {
    const auto = buildVisualDirection(rich());
    for (const id of STYLE_IDS) {
      const b = buildVisualDirection(rich({ userStyleId: id }));
      assert.equal(b.styleId, id);
      valid(b);
    }
    assert.notEqual(auto.styleId, 'dynamic_events');
    const picked = buildVisualDirection(rich({ userStyleId: 'dynamic_events' }));
    assert.equal(picked.styleId, 'dynamic_events');
    assert.match(picked.rationale, /chosen by you/i);
    assert.match(picked.rationale, /Dynamic Events/);
    assert.ok(!picked.secondaryStyleIds.includes('dynamic_events'));
    assert.ok(picked.typography.headline === 'condensed');
  });

  it('an unknown userStyleId is ignored (treated as auto)', () => {
    assert.equal(buildVisualDirection(rich({ userStyleId: 'nope' as never })).styleId, buildVisualDirection(rich()).styleId);
  });

  it('with nothing to go on, a neutral default is used and the rationale says so', () => {
    const b = buildVisualDirection(base());
    assert.equal(b.styleId, 'modern_corporate');
    assert.match(b.rationale, /Nothing in the brief/i);
    assert.ok(b.limitations.some((l) => /default/i.test(l)));
    assert.equal(b.confidence, 'low');
  });

  it('records secondary styles that also fit, never the chosen one, at most two', () => {
    const b = buildVisualDirection(base({ industry: 'cafe', productSummary: 'A cozy cafe and bakery, brunch on weekends', tone: 'warm' }));
    assert.equal(b.styleId, 'lifestyle_photography');
    assert.ok(b.secondaryStyleIds.length <= 2);
    assert.ok(!b.secondaryStyleIds.includes(b.styleId));
  });
});

describe('buildVisualDirection: colors', () => {
  it('keeps the brand colors, in order, as primary / secondary / accent', () => {
    const b = buildVisualDirection(rich({ brandPalette: ['#1D4ED8', '#F59E0B', '#10B981'] }));
    assert.equal(b.colors.primary, '#1D4ED8');
    assert.equal(b.colors.secondary, '#F59E0B');
    assert.equal(b.colors.accent, '#10B981');
    assert.match(b.colors.notes, /Primary: brand color/);
    assert.ok(!b.limitations.some((l) => /derived/i.test(l)));
  });

  it('preserves the exact text of a brand color (case included)', () => {
    const b = buildVisualDirection(rich({ brandPalette: ['#1d4ed8', '#f59e0b', '#10b981'] }));
    assert.deepEqual([b.colors.primary, b.colors.secondary, b.colors.accent], ['#1d4ed8', '#f59e0b', '#10b981']);
  });

  it('derives the accent (and the secondary) when the brand gives fewer than three colors', () => {
    const two = buildVisualDirection(rich({ brandPalette: ['#1D4ED8', '#F59E0B'] }));
    assert.equal(two.colors.primary, '#1D4ED8');
    assert.equal(two.colors.secondary, '#F59E0B');
    assert.match(two.colors.accent, /^#[0-9A-F]{6}$/);
    assert.ok(!['#1D4ED8', '#F59E0B'].includes(two.colors.accent.toUpperCase()));
    assert.match(two.colors.notes, /Accent: derived from the primary/);
    assert.ok(two.limitations.some((l) => /accent/i.test(l) && /derived/i.test(l)));

    const one = buildVisualDirection(rich({ brandPalette: ['#1D4ED8'] }));
    assert.equal(one.colors.primary, '#1D4ED8');
    assert.match(one.colors.secondary, /^#[0-9A-F]{6}$/);
    assert.match(one.colors.accent, /^#[0-9A-F]{6}$/);
    assert.notEqual(one.colors.secondary.toUpperCase(), '#1D4ED8');
    assert.notEqual(one.colors.accent.toUpperCase(), '#1D4ED8');
    assert.notEqual(one.colors.accent.toUpperCase(), one.colors.secondary.toUpperCase());
    assert.ok(one.limitations.some((l) => /secondary and accent/i.test(l)));
    valid(one);
  });

  it('derived colors follow the style\'s accent logic and are stable', () => {
    const a = buildVisualDirection(rich({ brandPalette: ['#1D4ED8'], userStyleId: 'bold_startup' }));
    const b = buildVisualDirection(rich({ brandPalette: ['#1D4ED8'], userStyleId: 'bold_startup' }));
    assert.deepEqual(a.colors, b.colors);
    const c = buildVisualDirection(rich({ brandPalette: ['#1D4ED8'], userStyleId: 'soft_lifestyle' }));
    assert.notEqual(a.colors.accent, c.colors.accent, 'complement and analogous accents differ');
  });

  it('empty palette: neutral colors from the style and an honest limitation', () => {
    const b = buildVisualDirection(rich({ brandPalette: [] }));
    assert.ok(b.limitations.includes('No brand palette supplied: neutral palette from the style was used.'));
    assert.match(b.colors.primary, /^#[0-9A-F]{6}$/);
    assert.match(b.colors.notes, /Primary: style default/);
    assert.ok(!/brand color/.test(b.colors.notes), 'never claims brand colors it does not have');
    assert.equal(b.colors.ink, '#15110E');
    assert.equal(b.colors.paper, '#F2EBE0');
  });

  it('invalid colors are dropped and reported; 3-digit hex is accepted', () => {
    const b = buildVisualDirection(rich({ brandPalette: ['not-a-color', '#abc', 'rgb(1,2,3)', '#1D4ED8', '#1d4ed8'] }));
    assert.equal(b.colors.primary, '#aabbcc');
    assert.equal(b.colors.secondary, '#1D4ED8');
    assert.ok(b.limitations.some((l) => /not valid hex/i.test(l)));
  });

  it('near-black and near-white brand colors become ink and paper, not the primary', () => {
    const b = buildVisualDirection(rich({ brandPalette: ['#FFFFFF', '#0A0A0A', '#E4572E', '#17BEBB'], userStyleId: 'minimalist_tech' }));
    assert.equal(b.colors.primary, '#E4572E');
    assert.equal(b.colors.secondary, '#17BEBB');
    assert.equal(b.colors.ink, '#0A0A0A');
    assert.equal(b.colors.paper, '#FFFFFF');
  });

  it('ink and paper fall back to the style anchors when the brand gives none or too little contrast', () => {
    const none = buildVisualDirection(rich({ brandPalette: ['#E4572E', '#17BEBB', '#F2B134'], userStyleId: 'premium_editorial' }));
    assert.equal(none.colors.ink, '#1C1A17');
    assert.equal(none.colors.paper, '#F3EEE6');
    const low = buildVisualDirection(rich({ brandPalette: ['#E4572E', '#6A6A6A', '#F5F5F5'], userStyleId: 'premium_editorial' }));
    assert.equal(low.colors.paper, '#F5F5F5');
  });

  it('an all-neutral brand (black / white / gray) is reported and gets the accent from the style', () => {
    const b = buildVisualDirection(rich({ brandPalette: ['#000000', '#FFFFFF'], userStyleId: 'modern_corporate' }));
    assert.equal(b.colors.primary, '#000000');
    assert.equal(b.colors.accent, '#2E8B9A');
    assert.ok(b.limitations.some((l) => /neutral/i.test(l)));
    valid(b);
    const onlyWhite = buildVisualDirection(rich({ brandPalette: ['#FFFFFF'], userStyleId: 'modern_corporate' }));
    valid(onlyWhite);
    assert.equal(onlyWhite.colors.paper, '#FFFFFF');
    assert.notEqual(onlyWhite.colors.primary, '#FFFFFF');
  });

  it('colors from a contributing reference come AFTER the brand palette and never replace it', () => {
    const b = buildVisualDirection(
      rich({
        brandPalette: ['#1D4ED8'],
        references: [ref({ id: 'logo', kind: 'brand_asset', permission: 'owned_by_user', label: 'Logo', palette: ['#D62828', '#2A9D8F'] })],
      }),
    );
    assert.equal(b.colors.primary, '#1D4ED8');
    assert.equal(b.colors.secondary, '#D62828');
    assert.equal(b.colors.accent, '#2A9D8F');
    assert.match(b.references[0]!.used, /Palette used: #D62828, #2A9D8F/);
    assert.ok(!b.limitations.some((l) => /derived/i.test(l)));
  });

  it('a reference palette that adds nothing is recorded as "not needed"', () => {
    const b = buildVisualDirection(rich({ brandPalette: ['#1D4ED8', '#F59E0B', '#10B981'], references: [ref({ id: 'u', kind: 'user_upload', permission: 'user_provided', palette: ['#D62828'] })] }));
    assert.deepEqual([b.colors.primary, b.colors.secondary, b.colors.accent], ['#1D4ED8', '#F59E0B', '#10B981']);
    assert.match(b.references[0]!.used, /not needed/i);
  });

  it('with no brand palette but a brand-asset palette, colors come from the asset and the limitation says so', () => {
    const b = buildVisualDirection(rich({ brandPalette: [], references: [ref({ id: 'logo', kind: 'brand_asset', permission: 'owned_by_user', palette: ['#336699', '#CC9933', '#339966'] })] }));
    assert.equal(b.colors.primary, '#336699');
    assert.ok(!b.limitations.includes('No brand palette supplied: neutral palette from the style was used.'));
    assert.ok(b.limitations.some((l) => /uploaded references/i.test(l)));
    assert.equal(b.confidence, 'high');
  });
});

describe('buildVisualDirection: text-driven parts (nothing invented)', () => {
  it('typography families come from the style and the notes are bounded', () => {
    const b = buildVisualDirection(rich({ userStyleId: 'premium_editorial' }));
    assert.equal(b.typography.headline, 'serif');
    assert.equal(b.typography.body, 'sans');
    assert.ok(b.typography.notes.length > 20 && b.typography.notes.length <= 200);
  });

  it('subjects use the product and audience words and then the style guidance', () => {
    const b = buildVisualDirection(rich());
    assert.match(b.imageSubjects[0]!, /^Scene grounded in the product: A neighborhood restaurant serving seasonal Mediterranean dishes/);
    assert.match(b.imageSubjects[1]!, /Couples and small groups/);
    assert.ok(b.imageSubjects.length >= 4 && b.imageSubjects.length <= 6);
    // the style's own subjects follow
    assert.ok(b.imageSubjects.some((s) => /Candlelit table/.test(s)));
    // no product at all: nothing about a product is made up
    const bare = buildVisualDirection(base({ industry: 'cafe' }));
    assert.ok(!bare.imageSubjects.some((s) => /product/i.test(s)));
    assert.match(bare.imageSubjects[0]!, /typical for cafe/);
  });

  it('the objective shapes the composition', () => {
    assert.ok(buildVisualDirection(rich()).composition.some((c) => /reservation or booking/.test(c)));
    assert.ok(buildVisualDirection(base({ industry: 'online shop', objective: 'Popust na letnju kolekciju' })).composition.some((c) => /offer badge/.test(c)));
    assert.ok(buildVisualDirection(base({ industry: 'software', objective: 'Start a free trial' })).composition.some((c) => /sign-up/.test(c)));
    const none = buildVisualDirection(base({ industry: 'software' }));
    assert.ok(none.composition.length >= 4 && none.composition.length <= 5);
    assert.ok(none.composition.some((c) => /layout/i.test(c)));
  });

  it('mood takes words from the tone and the design direction, then fills with the style\'s', () => {
    const b = buildVisualDirection(rich({ tone: 'playful and bold', designDirection: 'calm' }));
    assert.deepEqual(b.mood.slice(0, 3), ['playful', 'bold', 'calm']);
    assert.ok(b.mood.length <= 5 && b.mood.every((m) => m.length <= 40));
    assert.deepEqual(new Set(b.mood).size, b.mood.length);
    const sr = buildVisualDirection(rich({ tone: 'prijateljski i toplo', designDirection: '' }));
    assert.deepEqual(sr.mood.slice(0, 2), ['friendly', 'warm']);
  });

  it('there is one channel note per requested channel, deduplicated, ignoring unknown ids', () => {
    const b = buildVisualDirection(rich({ channels: ['tiktok', 'instagram', 'tiktok', 'nope' as never] }));
    assert.deepEqual(b.channelNotes.map((n) => n.channel), ['tiktok', 'instagram']);
    assert.ok(b.channelNotes.every((n) => n.note.length > 20 && n.note.length <= 160));
    assert.deepEqual(buildVisualDirection(rich({ channels: [] })).channelNotes, []);
  });

  it('reference notes of contributing references reach the treatment, nothing else does', () => {
    const b = buildVisualDirection(rich({ references: [ref({ id: 'up', kind: 'user_upload', permission: 'user_provided', label: 'Shop front', note: 'We like the wooden counter and warm light' })] }));
    assert.match(b.imageTreatment[0]!, /^Reference "Shop front": We like the wooden counter/);
    assert.match(b.references[0]!.used, /note used/);
    assert.ok(b.imageTreatment.length <= 5);
  });

  it('URLs in free text never survive into the brief', () => {
    const b = buildVisualDirection(rich({ productSummary: 'See https://secret.example.com/path?x=1 for our dishes. Fresh daily.', audience: 'visit www.private-site.rs now' }));
    const text = JSON.stringify(b);
    assert.ok(!/secret\.example|private-site/.test(text));
  });
});

describe('buildVisualDirection: confidence and limitations', () => {
  it('low when the brief gave almost nothing, high when industry + audience + brand palette are present', () => {
    assert.equal(buildVisualDirection(base()).confidence, 'low');
    assert.equal(buildVisualDirection(base({ brandPalette: ['#1D4ED8'] })).confidence, 'low');
    assert.equal(buildVisualDirection(base({ industry: 'software' })).confidence, 'low');
    assert.equal(buildVisualDirection(base({ industry: 'software', audience: 'developers' })).confidence, 'medium');
    assert.equal(buildVisualDirection(base({ industry: 'software', audience: 'developers', brandPalette: ['#1D4ED8'] })).confidence, 'high');
    assert.equal(buildVisualDirection(rich()).confidence, 'high');
    assert.equal(buildVisualDirection(rich({ brandPalette: [] })).confidence, 'medium');
  });

  it('a very thin brief says so; a rich one carries at most the honest palette notes', () => {
    assert.ok(buildVisualDirection(base()).limitations.some((l) => /starting point/i.test(l)));
    assert.deepEqual(buildVisualDirection(rich()).limitations, []);
  });

  it('limitations stay within the schema bounds', () => {
    const b = buildVisualDirection(base({ brandPalette: ['x', 'y', 'z'], references: Array.from({ length: 30 }, (_, i) => ref({ id: `${i}`, kind: 'user_link', permission: 'link_only_not_analyzed' })).concat([ref({ id: 'bad', kind: 'nope' as never, permission: 'nope' as never })]) }));
    assert.ok(b.limitations.length <= 8);
    valid(b);
  });
});

describe('references: compliance rules', () => {
  const pin = ref({ id: 'pin1', kind: 'pinterest_board', permission: 'platform_restricted_not_stored', label: 'Dinner ideas board', url: PIN, palette: ['#FF0000', '#00FF00', '#0000FF'], note: 'Use the neon green from this board' });
  const link = ref({ id: 'link1', kind: 'user_link', permission: 'link_only_not_analyzed', label: 'My moodboard', url: LINK, palette: ['#FF00FF'], note: 'Copy the third image exactly' });

  it('Pinterest and link-only references contribute NOTHING (no colors, no text, no notes, no limitation)', () => {
    const plain = buildVisualDirection(rich());
    const withRefs = buildVisualDirection(rich({ references: [pin, link] }));
    assert.deepEqual(withoutRefs(withRefs), withoutRefs(plain));
    assert.equal(visualDirectionForPrompt(withRefs), visualDirectionForPrompt(plain));
    assert.equal(visualDirectionSummary(withRefs), visualDirectionSummary(plain));
    const text = JSON.stringify(withoutRefs(withRefs));
    assert.ok(!/FF0000|00FF00|0000FF|FF00FF/i.test(text));
    assert.ok(!/neon green|third image|Dinner ideas|moodboard/i.test(text));
  });

  it('the same holds when there is no brand palette at all (their palettes must not fill the gap)', () => {
    const plain = buildVisualDirection(rich({ brandPalette: [] }));
    const withRefs = buildVisualDirection(rich({ brandPalette: [], references: [pin, link] }));
    assert.deepEqual(withoutRefs(withRefs), withoutRefs(plain));
    assert.ok(withRefs.limitations.includes('No brand palette supplied: neutral palette from the style was used.'));
  });

  it('they are recorded with the right permission, url and used text', () => {
    const b = buildVisualDirection(rich({ references: [pin, link] }));
    assert.equal(b.references.length, 2);
    const [p, l] = b.references;
    assert.deepEqual(p, { id: 'pin1', kind: 'pinterest_board', label: 'Dinner ideas board', url: PIN, permission: 'platform_restricted_not_stored', used: 'Not analyzed: platform content is shown to the user only' });
    assert.equal(p!.used, NOT_ANALYZED_PLATFORM);
    assert.deepEqual(l, { id: 'link1', kind: 'user_link', label: 'My moodboard', url: LINK, permission: 'link_only_not_analyzed', used: LINK_ONLY_USED });
    valid(b);
  });

  it('a Pinterest board stays "not analyzed" whatever permission is claimed for it', () => {
    for (const permission of PERMISSION_STATUS) {
      const b = buildVisualDirection(rich({ references: [ref({ id: 'p', kind: 'pinterest_board', permission, palette: ['#FF0000'], note: 'x' })] }));
      assert.equal(b.references[0]!.used, NOT_ANALYZED_PLATFORM, permission);
      assert.deepEqual(withoutRefs(b), withoutRefs(buildVisualDirection(rich())), permission);
    }
  });

  it('platform_restricted_not_stored on ANY kind blocks it; link_only_not_analyzed on any kind contributes nothing', () => {
    for (const kind of REFERENCE_KINDS) {
      const a = buildVisualDirection(rich({ brandPalette: ['#1D4ED8'], references: [ref({ id: 'r', kind, permission: 'platform_restricted_not_stored', palette: ['#FF0000'], note: 'leak' })] }));
      assert.equal(a.references[0]!.used, NOT_ANALYZED_PLATFORM, kind);
      assert.ok(!JSON.stringify(withoutRefs(a)).includes('leak') && !/FF0000/i.test(JSON.stringify(withoutRefs(a))), kind);
      const b = buildVisualDirection(rich({ brandPalette: ['#1D4ED8'], references: [ref({ id: 'r', kind, permission: 'link_only_not_analyzed', palette: ['#FF0000'], note: 'leak' })] }));
      assert.ok(!JSON.stringify(withoutRefs(b)).includes('leak') && !/FF0000/i.test(JSON.stringify(withoutRefs(b))), kind);
      assert.equal(b.references[0]!.used, kind === 'pinterest_board' ? NOT_ANALYZED_PLATFORM : LINK_ONLY_USED, kind);
    }
  });

  it('only brand_asset / user_upload / licensed_asset / style_library with an owned / provided / licensed / original permission may contribute', () => {
    const contributing = ['brand_asset', 'user_upload', 'licensed_asset', 'style_library'] as const;
    const okPerms = ['owned_by_user', 'user_provided', 'licensed', 'original_to_launchpilot'] as const;
    for (const kind of REFERENCE_KINDS) {
      for (const permission of PERMISSION_STATUS) {
        const expected = (contributing as readonly string[]).includes(kind) && (okPerms as readonly string[]).includes(permission);
        assert.equal(referenceMayContribute(kind, permission), expected, `${kind}/${permission}`);
        const b = buildVisualDirection(rich({ brandPalette: [], references: [ref({ id: 'r', kind, permission, palette: ['#CC3366', '#3366CC', '#66CC33'] })] }));
        assert.equal(b.colors.primary === '#CC3366', expected, `${kind}/${permission} -> primary ${b.colors.primary}`);
      }
    }
  });

  it('contributing references are recorded with what was used', () => {
    const b = buildVisualDirection(
      rich({
        brandPalette: [],
        references: [
          ref({ id: 'up', kind: 'user_upload', permission: 'user_provided', label: 'Mood photo', palette: ['#996633'], url: 'https://cdn.example.com/u/1.png' }),
          ref({ id: 'logo', kind: 'brand_asset', permission: 'owned_by_user', label: 'Logo', palette: ['#336699'] }),
          ref({ id: 'lic', kind: 'licensed_asset', permission: 'licensed', label: 'Stock photo license', note: 'Warm tabletop photo' }),
          ref({ id: 'lib', kind: 'style_library', permission: 'original_to_launchpilot', label: 'Premium Editorial' }),
        ],
      }),
    );
    assert.equal(b.references.length, 4);
    assert.deepEqual(b.references.map((r) => r.id), ['up', 'logo', 'lic', 'lib'], 'same order as given');
    // brand assets lead the palette even when listed after an upload
    assert.equal(b.colors.primary, '#336699');
    assert.match(b.references[1]!.used, /Palette used: #336699/);
    assert.match(b.references[0]!.used, /Palette used: #996633/);
    assert.match(b.references[2]!.used, /note used/);
    assert.equal(b.references[3]!.used, 'Original LaunchPilot style guidance');
    assert.equal(b.references[0]!.url, 'https://cdn.example.com/u/1.png');
    valid(b);
  });

  it('every reference is recorded, none are added, and garbage urls are dropped', () => {
    const refs = [
      ref({ id: 'a', kind: 'user_link', permission: 'link_only_not_analyzed', url: 'javascript:alert(1)' }),
      ref({ id: 'b', kind: 'pinterest_board', permission: 'platform_restricted_not_stored', url: 'ftp://x/y' }),
      ref({ id: 'c', kind: 'user_upload', permission: 'user_provided', url: null }),
      ref({ id: 'd', kind: 'user_link', permission: 'link_only_not_analyzed', url: LINK }),
    ];
    const b = buildVisualDirection(rich({ references: refs }));
    assert.deepEqual(b.references.map((r) => [r.id, r.url]), [['a', null], ['b', null], ['c', null], ['d', LINK]]);
    assert.equal(buildVisualDirection(rich()).references.length, 0);
  });
});

describe('visualDirectionForPrompt', () => {
  it('always carries the no-text sentence and stays within the length bound', () => {
    const briefs = [
      buildVisualDirection(base()),
      buildVisualDirection(rich()),
      buildVisualDirection(rich({ productSummary: 'p'.repeat(600), audience: 'a'.repeat(300), tone: 'warm bold calm playful elegant', objective: 'book a table', references: [ref({ id: 'n', kind: 'user_upload', permission: 'user_provided', label: 'L'.repeat(100), note: 'n'.repeat(160) })] })),
      ...STYLE_IDS.map((id) => buildVisualDirection(rich({ userStyleId: id }))),
    ];
    for (const b of briefs) {
      const p = visualDirectionForPrompt(b);
      assert.ok(p.includes('no text, letters, logos or watermarks'), p);
      assert.ok(p.includes(NO_TEXT_SENTENCE));
      assert.ok(p.includes('typography is added later by the layout engine'));
      assert.ok(p.length <= 1200, `${p.length} chars`);
      assert.ok(!/\n/.test(p));
    }
  });

  it('survives a brief whose fields are all at their maximum size', () => {
    const b = buildVisualDirection(rich());
    const fat: VisualDirectionBrief = {
      ...b,
      composition: Array.from({ length: 5 }, () => 'c'.repeat(140)),
      mood: Array.from({ length: 5 }, () => 'm'.repeat(40)),
      imageSubjects: Array.from({ length: 6 }, () => 's'.repeat(120)),
      imageTreatment: Array.from({ length: 5 }, () => 't'.repeat(100)),
    };
    const p = visualDirectionForPrompt(fat);
    assert.ok(p.length <= 1200, `${p.length}`);
    assert.ok(p.endsWith(NO_TEXT_SENTENCE));
    assert.ok(p.startsWith('Visual direction: Luxury Hospitality.'));
  });

  it('describes the style, the palette in words and hex, composition, mood, subjects, treatment and what to avoid', () => {
    const p = visualDirectionForPrompt(buildVisualDirection(rich()));
    assert.match(p, /^Visual direction: Luxury Hospitality\./);
    assert.match(p, /Palette: primary .*#1F4D3A, secondary .*#C8A15A, accent .*#F2E8D5/);
    assert.match(p, /Composition:/);
    assert.match(p, /Mood:/);
    assert.match(p, /Subjects:/);
    assert.match(p, /Treatment:/);
    assert.match(p, /Avoid: .*price tags/);
  });

  it('never carries a platform or link reference url, label or note', () => {
    const b = buildVisualDirection(
      rich({
        references: [
          ref({ id: 'pin1', kind: 'pinterest_board', permission: 'platform_restricted_not_stored', label: 'Secret Board Name', url: PIN, note: 'pin note' }),
          ref({ id: 'l1', kind: 'user_link', permission: 'link_only_not_analyzed', label: 'My Private Moodboard', url: LINK, note: 'link note' }),
        ],
      }),
    );
    const p = visualDirectionForPrompt(b);
    const s = visualDirectionSummary(b);
    for (const text of [p, s]) {
      assert.ok(!text.includes('pinterest'), text);
      assert.ok(!text.includes('secret-board-name'));
      assert.ok(!text.includes('my-private-moodboard-xyz'));
      assert.ok(!/https?:\/\//.test(text));
      assert.ok(!/Secret Board Name|My Private Moodboard|pin note|link note/.test(text));
    }
  });

  it('strips any url that somehow got into the brief', () => {
    const b = buildVisualDirection(rich());
    const dirty = { ...b, imageSubjects: ['A table, see https://leak.example.com/x', ...b.imageSubjects] };
    assert.ok(!/leak\.example/.test(visualDirectionForPrompt(dirty)));
  });
});

describe('visualDirectionSummary', () => {
  it('is one or two sentences naming the style and the confidence', () => {
    const s = visualDirectionSummary(buildVisualDirection(rich()));
    assert.match(s, /^Luxury Hospitality: a /);
    assert.match(s, /high confidence/);
    assert.ok(s.length < 400);
    assert.ok((s.match(/\.(\s|$)/g) ?? []).length <= 3);
    assert.match(visualDirectionSummary(buildVisualDirection(base())), /Low confidence|low confidence/);
  });
});

describe('REFERENCE_POLICY', () => {
  it('describes every kind and matches the compliance rules', () => {
    assert.deepEqual(Object.keys(REFERENCE_POLICY).sort(), [...REFERENCE_KINDS].sort());
    for (const k of ['user_upload', 'brand_asset', 'licensed_asset'] as const) {
      assert.equal(REFERENCE_POLICY[k].mode, 'analyzable');
      assert.ok(REFERENCE_POLICY[k].analyzable && REFERENCE_POLICY[k].storable && REFERENCE_POLICY[k].contributes);
    }
    assert.equal(REFERENCE_POLICY.style_library.mode, 'original');
    assert.equal(REFERENCE_POLICY.user_link.mode, 'link_only');
    assert.ok(!REFERENCE_POLICY.user_link.analyzable && !REFERENCE_POLICY.user_link.storable && !REFERENCE_POLICY.user_link.contributes && REFERENCE_POLICY.user_link.displayable);
    assert.equal(REFERENCE_POLICY.pinterest_board.mode, 'display_only');
    assert.ok(!REFERENCE_POLICY.pinterest_board.analyzable && !REFERENCE_POLICY.pinterest_board.storable && !REFERENCE_POLICY.pinterest_board.contributes && REFERENCE_POLICY.pinterest_board.displayable);
    for (const p of Object.values(REFERENCE_POLICY)) assert.ok(p.summary.length > 10);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(REFERENCE_POLICY));
  });
});

describe('describeColor', () => {
  it('gives plain words', () => {
    assert.equal(describeColor('#000000'), 'near-black');
    assert.equal(describeColor('#FFFFFF'), 'white');
    assert.equal(describeColor('#808080'), 'gray');
    assert.match(describeColor('#1D4ED8'), /blue/);
    assert.match(describeColor('#0A2540'), /^deep /);
    assert.match(describeColor('#E4572E'), /red|orange/);
    assert.equal(describeColor('nope'), 'neutral');
  });
});
