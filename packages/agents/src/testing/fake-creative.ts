import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { limitsFor } from '../creative/limits';
import { CAMPAIGN_PLATFORMS, type CopyOutput, type CopyRevisionOutput, type ReviewOutput } from '../creative/schemas';

/**
 * Default (valid) answers of the F4 agents for the fake provider servers (tests only). They are built from the prompt the request actually
 * carried (the strategy's value proposition, the platforms, the copy to revise), contain nothing the deterministic review would flag, and the
 * revision answers genuinely remove what the findings complained about.
 */
export type CreativeFakeAgent = 'writer' | 'creviewer';

const block = (text: string, tag: string): unknown => {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
};

const valueProposition = (t: string) => /"valueProposition": "([^"]{4,})"/.exec(t)?.[1] ?? 'A clear and honest offer for people who want to get started';

const HOOKS = [
  { name: 'Start with confidence', headline: 'Take the first step calmly', angle: 'Reassure newcomers that the first step is manageable', visual: 'A calm, welcoming entrance where a first visitor is greeted in person' },
  { name: 'Clear and honest', headline: 'Know exactly what you get', angle: 'Lead with transparency about what is offered', visual: 'A bright counter where the offer is laid out plainly for a customer' },
  { name: 'Learn with people', headline: 'Learn alongside a friendly group', angle: 'Show the human, supportive side', visual: 'A small group of people sharing a relaxed moment around a table' },
  { name: 'Plan your next move', headline: 'Choose your next move with clarity', angle: 'Help the audience decide what to do next', visual: 'A person planning on paper at a quiet desk by a window' },
  { name: 'Everyday progress', headline: 'Small steps, steady progress', angle: 'Celebrate steady, realistic progress', visual: 'Hands at work on a project that is clearly taking shape' },
];
const FLAVOR: Record<string, string> = {
  x: 'Tell us what you think.',
  instagram: 'Save this post and share it with a friend.',
  facebook: 'Tell us what you would like to know in the comments.',
  linkedin: 'Read how teams and professionals approach this.',
  tiktok: 'See it in thirty seconds.',
};
/** Each platform opens differently (the copy checks flag posts that all open with the same words). */
const OPENER: Record<string, string> = { x: 'Quick take:', instagram: 'Picture this:', facebook: 'Here is something useful.', linkedin: 'A practical note for professionals:', tiktok: 'Watch this:' };
const HOOK_TAIL: Record<string, string> = { x: ' today', tiktok: ' in 30 seconds', facebook: ' together', instagram: '', linkedin: ' at work' };

/** Clean copy also respects the platform's length limits (the deterministic review measures them): cut at a word boundary. */
export function fit(text: string, channel: string, placement: string, field: 'headline' | 'body', fallback: number): string {
  const max = Math.min(fallback, ...limitsFor(channel, placement).filter((l) => l.field === field || (field === 'body' && l.field === 'post')).map((l) => l.max));
  return text.length <= max ? text : text.slice(0, max).replace(/\s+\S*$/, '').replace(/[,:;]$/, '');
}

export function defaultCopy(userText: string): CopyOutput {
  const task = block(userText, 'task') as { concepts?: string; posts?: string } | null;
  const n = Math.min(5, Math.max(1, Number(/exactly (\d+)/.exec(String(task?.concepts ?? ''))?.[1] ?? 3)));
  const listed = /for each of: ([a-z_, ]+)/.exec(String(task?.posts ?? ''))?.[1]?.split(',').map((x) => x.trim()) ?? [];
  const platforms = CAMPAIGN_PLATFORMS.filter((p) => !listed.length || listed.includes(p));
  const vp = valueProposition(userText).replace(/[.!]+$/, '');
  const claims = [{ text: vp.slice(0, 150), support: 'f3' as const, ref: null }];
  const concepts = Array.from({ length: n }, (_, i) => {
    const h = HOOKS[i % HOOKS.length];
    return { key: `c${i + 1}`, name: h.name, basis: `Main message ${i + 1} of the strategy`, angle: h.angle, keyMessage: `${h.headline}.`, audience: 'People considering this offer', ctaType: 'learn_more' as const, ctaText: 'Learn more', visualIdea: h.visual, purpose: 'awareness' as const, principleNote: 'P1 hook, P3 audience and P6 a concrete situation; no urgency (none is evidenced).' };
  });
  const posts: CopyOutput['posts'] = [];
  concepts.forEach((c, i) => {
    const h = HOOKS[i % HOOKS.length];
    for (const p of platforms) {
      posts.push({
        conceptKey: c.key,
        platform: p,
        hook: fit(`${h.headline}${HOOK_TAIL[p] ?? ''}`, p, 'social_post', 'headline', 70),
        text: fit(`${OPENER[p] ?? ''} ${vp}. ${FLAVOR[p] ?? ''} Idea ${i + 1} on ${p}: ${h.angle.toLowerCase()}.`.trim(), p, 'social_post', 'body', 400),
        visualLine: fit(`${vp}.`, p, 'social_post', 'body', 100),
        cta: 'Learn more',
        ctaType: 'learn_more',
        hashtags: p === 'linkedin' || p === 'x' ? [] : ['#getstarted'],
        postingFormat: p === 'tiktok' ? 'Vertical 9:16 video with the cover image as thumbnail' : 'Single image post',
        videoScript: p === 'tiktok' ? { hook: h.headline, durationSeconds: 20, scenes: [{ seconds: '0-5', visual: h.visual, onScreenText: h.headline, voiceover: vp.slice(0, 120) }, { seconds: '5-20', visual: 'The offer shown in a real setting', onScreenText: 'Learn more', voiceover: 'Find out what is offered.' }], soundNote: 'Calm background music' } : null,
        claims,
        principles: p === 'linkedin' ? ['P3', 'P9', 'P12'] : ['P1', 'P6'],
      });
    }
  });
  const lead = concepts.slice(0, Math.min(2, n));
  const ads: CopyOutput['ads'] = lead.flatMap((c, i) => (['web_ad', 'display_ad'] as const).map((kind) => ({ conceptKey: c.key, kind, headline: fit(HOOKS[i % HOOKS.length].headline, 'google_search', kind, 'headline', 30), description: fit(`${vp}.`, 'google_search', kind, 'body', 90), cta: 'Learn more', ctaType: 'learn_more' as const, claims, principles: ['P1', 'P4', 'P11'] })));
  const print: CopyOutput['print'] = [
    { conceptKey: 'c1', kind: 'billboard', headline: HOOKS[0].headline, body: '', visualLine: '', cta: 'Learn more', ctaType: 'learn_more', claims, principles: ['P1', 'P12'] },
    { conceptKey: 'c1', kind: 'flyer', headline: HOOKS[0].headline, body: `${vp}. Everything you need to decide what to do next.`, visualLine: fit(`${vp}.`, 'organic_content', 'flyer', 'body', 100), cta: 'Learn more', ctaType: 'learn_more', claims, principles: ['P1', 'P4', 'P11'] },
  ];
  return { summary: `${n} concept(s) with posts for ${platforms.join(', ')}, ad and print copy.`, concepts, posts, ads, print, missingInformation: ['No customer testimonials were supplied, so none are used.'] };
}

export const defaultCreativeReview = (): ReviewOutput => ({ summary: 'The copy is consistent with the strategy and the brief.', issues: [], scores: { productAccuracy: 4, brandConsistency: 4, audienceRelevance: 4, objectiveAlignment: 4, originality: 4, crossChannelConsistency: 4, headlineStrength: 4, specificity: 4, clarity: 4, ctaQuality: 4, platformFit: 4, principleFit: 4 } });

const BAD = /\b(guarantee[sd]?|risk[- ]free|money[- ]back|award[- ]winning|awarded|certified by|testimonials?|discounts?|limited[- ]time|sale|best in)\b|\d+\s?%\s?off|\d[\d,.]*\+?\s*(?:happy\s+)?(?:customers|clients|students|users)|\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]{2,}\.(?:com|net|org|io|rs|app|ai)\b\S*|\b(?:until|by)\s+\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/gi;
export const sanitize = (s: string, fallback = 'Learn more') => {
  const out = s.replace(BAD, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.!])/g, '$1').trim();
  return out.length >= 2 ? out : fallback;
};

export function defaultCopyRevision(userText: string): CopyRevisionOutput {
  const copy = (block(userText, 'copy') ?? []) as { id: string; platform?: string | null; placement?: string; headline: string; body: string; visualLine?: string; cta?: { text: string }; hashtags: string[]; claims: CopyRevisionOutput['revisions'][number]['claims'] }[];
  return {
    revisions: copy.map((v) => {
      const channel = v.platform ?? (v.placement === 'web_ad' || v.placement === 'display_ad' ? 'google_search' : 'organic_content');
      return {
        variantId: v.id,
        headline: fit(sanitize(v.headline, 'A clear next step'), channel, v.placement ?? '', 'headline', 70),
        body: fit(sanitize(v.body, 'Learn what is offered and decide at your own pace.'), channel, v.placement ?? '', 'body', 400),
        visualLine: v.visualLine ? sanitize(v.visualLine, '').slice(0, 100) : '',
        ctaText: v.cta?.text ?? 'Learn more',
        hashtags: v.hashtags ?? [],
        claims: (v.claims ?? []).filter((c) => c.support !== 'hypothesis'),
      };
    }),
  };
}

const cache = new Map<string, string>();
/** A valid PNG (never a real picture): a soft gradient with a few shapes. Tests use it as an approved "photograph". */
export async function fakeImageBase64(size: string, prompt = ''): Promise<string> {
  const key = `${size}|${prompt}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const [w, h] = size.split('x').map(Number);
  const hex = createHash('sha1').update(prompt).digest('hex');
  const c1 = `#${hex.slice(0, 6)}`;
  const c2 = `#${hex.slice(6, 12)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${prompt ? c1 : '#2b6f8f'}"/><stop offset="1" stop-color="${prompt ? c2 : '#d9b27c'}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.7}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.12}" fill="#f4e3c1" opacity="0.9"/><rect x="${w * 0.1}" y="${h * 0.45}" width="${w * 0.35}" height="${h * 0.1}" fill="#1b4a63" opacity="0.7"/></svg>`;
  const b64 = (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');
  cache.set(key, b64);
  return b64;
}
