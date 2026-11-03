import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ChannelId } from '../strategy/channels';
import { limitsFor } from '../creative/limits';
import type { ConceptCritique, CopyOutput, CopyRevisionOutput, LandingOutput, LandingRevisionOutput, ReviewOutput, VariationDirections, VisualDirections } from '../creative/schemas';

/**
 * Default (valid) answers of the F4 agents for the fake OpenAI server. They are built from the prompt the request actually
 * carried (the strategy's value proposition, the concept ids, the variants to revise), contain nothing the deterministic review
 * would flag, and the revision answers genuinely remove what the findings complained about.
 */
export type CreativeFakeAgent = 'copywriter' | 'landing' | 'vcreator' | 'creviewer';

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
  { name: 'Start with confidence', headline: 'Take the first step calmly', angle: 'Reassure newcomers that the first step is manageable', visual: 'A calm, welcoming scene that suggests a first step' },
  { name: 'Clear and honest', headline: 'Know exactly what you get', angle: 'Lead with transparency about what is offered', visual: 'A bright, orderly scene that suggests clarity' },
  { name: 'Learn with people', headline: 'Learn alongside a friendly group', angle: 'Show the human, supportive side', visual: 'People sharing a relaxed moment together' },
  { name: 'Plan your next move', headline: 'Choose your next move with clarity', angle: 'Help the audience decide what to do next', visual: 'A path that leads toward a clear horizon' },
  { name: 'Everyday progress', headline: 'Small steps, steady progress', angle: 'Celebrate steady, realistic progress', visual: 'A quiet scene with a sense of gradual movement' },
];
const FLAVOR: Record<string, string> = {
  instagram: 'Save this post and share it with a friend.',
  facebook: 'Tell us what you would like to know in the comments.',
  linkedin: 'Read how teams and professionals approach this.',
  youtube: 'Watch how it works step by step.',
  tiktok: 'See it in sixty seconds.',
  google_search: 'Find the details you are looking for.',
  email: 'Open the message for the full picture.',
  organic_content: 'Read the story behind the offer.',
  community: 'Join the conversation with others.',
};

/** Clean copy also respects the channel's length limits (the deterministic review measures them): cut at a word boundary. */
export function fit(text: string, channel: string, placement: string, field: 'headline' | 'body', fallback: number): string {
  const max = Math.min(fallback, ...limitsFor(channel, placement).filter((l) => l.field === field).map((l) => l.max));
  return text.length <= max ? text : text.slice(0, max).replace(/\s+\S*$/, '').replace(/[,:;]$/, '');
}

export function defaultCopy(userText: string): CopyOutput {
  const task = block(userText, 'task') as { concepts?: string; channels?: ChannelId[] } | null;
  const n = Math.min(5, Math.max(1, Number(/exactly (\d+)/.exec(String(task?.concepts ?? ''))?.[1] ?? 3)));
  const channels = task?.channels?.length ? task.channels : (['instagram'] as ChannelId[]);
  const vp = valueProposition(userText).replace(/[.!]+$/, '');
  const concepts = Array.from({ length: n }, (_, i) => {
    const h = HOOKS[i % HOOKS.length];
    return { key: `c${i + 1}`, name: h.name, angle: h.angle, keyMessage: `${h.headline}.`, audience: 'People considering this offer', ctaType: 'learn_more' as const, ctaText: 'Learn more', visualIdea: h.visual };
  });
  const variants: CopyOutput['variants'] = [];
  concepts.forEach((c, i) => {
    channels.slice(0, 3).forEach((ch, j) => {
      if (variants.length >= Math.max(12, n * Math.min(3, channels.length))) return; // every concept gets copy, however many there are (5 concepts x 3 channels = 15)
      const placement = j === 0 ? 'paid_ad' : 'organic_post';
      variants.push({
        conceptKey: c.key,
        channel: ch,
        placement,
        length: j === 0 ? 'short' : 'long',
        headline: fit(`${HOOKS[i % HOOKS.length].headline}${j ? ` on ${ch.replace('_', ' ')}` : ''}`, ch, placement, 'headline', 70),
        body: fit(`${vp}. ${FLAVOR[ch] ?? 'Learn more on our site.'} Idea ${i + 1}, ${ch.replace('_', ' ')}: ${HOOKS[i % HOOKS.length].angle.toLowerCase()}.`, ch, placement, 'body', 400),
        description: null,
        ctaText: 'Learn more',
        ctaType: 'learn_more',
        hashtags: [],
        claims: [{ text: vp.slice(0, 150), support: 'f3', ref: null }],
      });
    });
  });
  return { summary: `${n} distinct concept(s) with copy for ${channels.join(', ')}.`, concepts, variants, missingInformation: ['No customer testimonials were supplied, so none are used.'] };
}

export function defaultLanding(userText: string): LandingOutput {
  const vp = valueProposition(userText).replace(/[.!]+$/, '');
  return {
    summary: 'Landing page content that repeats the strategy and the ads.',
    content: {
      seoTitle: vp.slice(0, 60),
      metaDescription: `${vp}. Learn more about the offer.`.slice(0, 160),
      hero: { headline: vp.slice(0, 90), description: 'Everything you need to understand the offer and decide what to do next.', ctaText: 'Learn more' },
      valueProposition: vp.slice(0, 300),
      benefits: [
        { title: 'Clear next step', text: 'A short, honest explanation of what is offered.', evidence: 'f3', ref: null },
        { title: 'Made for beginners', text: 'Written for people who are just getting started.', evidence: 'brief', ref: null },
      ],
      sections: [{ title: 'About the offer', body: vp.slice(0, 300) }],
      howItWorks: [{ step: 'Read', text: 'Read about the offer.' }, { step: 'Ask', text: 'Ask a question if something is unclear.' }],
      faq: [{ q: 'Where do I start?', a: 'Use the button on this page to learn more.' }],
      trustSignals: [],
      ctas: [{ objective: 'learn_more', text: 'Learn more' }],
      ctaObjective: 'learn_more',
      mobileHierarchy: ['Hero', 'Benefits', 'Call to action'],
    },
    missingInformation: ['No reviews or certifications were supplied, so no trust signals are shown.'],
  };
}

const SCENES = ['harbor at sunrise', 'wooden table with warm cups', 'quiet garden path', 'busy open workshop', 'rooftop terrace at dusk', 'stone staircase in soft rain', 'sunlit studio window', 'long beach with drifting kites', 'lantern-lit courtyard', 'mountain trail above clouds', 'glass atrium with tall plants', 'street market with colorful awnings', 'lakeside pier at noon', 'cozy corner with open books', 'bright kitchen counter', 'forest clearing with mist', 'narrow alley with hanging lights', 'wide meadow under a pale sky', 'river bridge at golden hour', 'calm library reading room', 'seaside promenade', 'clay pottery bench', 'orchard rows in bloom', 'harvest table outdoors'];

export function defaultVisual(userText: string): VisualDirections | VariationDirections {
  const task = block(userText, 'task') as { concepts?: { key: string; name: string; visualIdea: string }[]; slots?: { slotId: string; concept: string; number: number; role: string; cameraPerspective: string; lighting: string }[] } | null;
  // several originals per concept: one clearly different proposal per slot, built from the slot's own seeds
  if (task?.slots?.length) {
    return {
      summary: `Planned ${task.slots.length} image(s) without any text.`,
      variations: task.slots.map((s, i) => ({
        slotId: s.slotId,
        name: `${s.concept} picture ${s.number}`,
        goal: `Show ${s.role.split(':')[0].toLowerCase()} number ${i + 1}`,
        medium: i % 2 ? 'documentary-style photograph' : 'editorial photograph',
        subject: `${SCENES[i % SCENES.length]} for ${s.concept}, image ${s.number}`,
        setting: `${SCENES[(i + 3) % SCENES.length]} seen from the side`,
        focalPoint: `the main subject near the ${SCENES[(i + 5) % SCENES.length]}`,
        composition: `${s.cameraPerspective} framing, the ${SCENES[(i + 7) % SCENES.length]} off to one side, calm lower third`,
        mood: 'Calm and trustworthy',
        avoid: ['text', 'logos'],
        altText: `Illustration ${i + 1} for ${s.concept}`,
        promptDetails: `${s.lighting}; unique detail ${i + 1}`,
      })),
    };
  }
  const concepts = task?.concepts ?? [];
  return {
    summary: `Planned ${concepts.length} base image(s) without any text.`,
    directions: concepts.map((c) => ({ conceptKey: c.key, subject: c.visualIdea || c.name, composition: 'Wide framing with a calm, empty lower third.', mood: 'Calm and trustworthy', colors: [], avoid: ['text', 'logos'], altText: `Illustration for ${c.name}`, promptDetails: 'Soft natural light.' })),
  };
}

export const defaultCreativeReview = (): ReviewOutput => ({ summary: 'The copy and landing content are consistent with the strategy and the brief.', issues: [], scores: { productAccuracy: 4, brandConsistency: 4, audienceRelevance: 4, objectiveAlignment: 4, originality: 4, crossChannelConsistency: 4 } });

/** A concept critique that keeps every concept (a test overrides it to make the critique ask for a revision). */
export function defaultConceptCritique(userText: string): ConceptCritique {
  const list = (block(userText, 'concepts_to_critique') ?? []) as { id: string; name: string; visualIdea: string }[];
  return {
    summary: `Reviewed ${list.length} concept(s): each names the product, differs from the others and gives a picture something to show.`,
    concepts: list.map((c) => ({ conceptId: c.id, specificity: 4, originality: 4, audienceFit: 4, visualPotential: 4, verdict: 'keep' as const, problem: '', artDirection: `Show ${c.visualIdea || c.name} as a documentary-style photograph with one clear focal point.`, visualIdeaRevision: null })),
  };
}

const BAD = /\b(guarantee[sd]?|risk[- ]free|money[- ]back|award[- ]winning|awarded|certified by|testimonials?|discounts?|limited[- ]time|sale|best in)\b|\d+\s?%\s?off|\d[\d,.]*\+?\s*(?:happy\s+)?(?:customers|clients|students|users)|\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]{2,}\.(?:com|net|org|io|rs|app|ai)\b\S*|\b(?:until|by)\s+\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/gi;
export const sanitize = (s: string, fallback = 'Learn more') => {
  const out = s.replace(BAD, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.!])/g, '$1').trim();
  return out.length >= 2 ? out : fallback;
};

export function defaultCopyRevision(userText: string): CopyRevisionOutput {
  const variants = (block(userText, 'variants') ?? []) as { id: string; channel?: string; placement?: string; headline: string; body: string; ctaText: string; hashtags: string[]; claims: CopyRevisionOutput['revisions'][number]['claims'] }[];
  return {
    revisions: variants.map((v) => ({
      variantId: v.id,
      headline: fit(sanitize(v.headline, 'A clear next step'), v.channel ?? '', v.placement ?? '', 'headline', 70),
      body: fit(sanitize(v.body, 'Learn what is offered and decide at your own pace.'), v.channel ?? '', v.placement ?? '', 'body', 400),
      ctaText: v.ctaText,
      hashtags: v.hashtags ?? [],
      claims: (v.claims ?? []).filter((c) => c.support !== 'hypothesis'),
    })),
  };
}

export function defaultLandingRevision(userText: string): LandingRevisionOutput {
  const landing = block(userText, 'landing') as { hero?: { headline: string; description: string }; valueProposition?: string; trustSignals?: unknown[]; benefits?: { title: string; text: string }[]; seoTitle?: string; metaDescription?: string } | null;
  const changes: LandingRevisionOutput['changes'] = [];
  const bad = (s?: string) => !!s && sanitize(s) !== s.trim();
  if (bad(landing?.hero?.headline)) changes.push({ path: 'hero.headline', value: sanitize(landing!.hero!.headline).slice(0, 90) });
  if (bad(landing?.hero?.description)) changes.push({ path: 'hero.description', value: sanitize(landing!.hero!.description).slice(0, 300) });
  if (bad(landing?.valueProposition)) changes.push({ path: 'valueProposition', value: sanitize(landing!.valueProposition!).slice(0, 300) });
  if (bad(landing?.seoTitle)) changes.push({ path: 'seoTitle', value: sanitize(landing!.seoTitle!).slice(0, 70) });
  if (bad(landing?.metaDescription)) changes.push({ path: 'metaDescription', value: sanitize(landing!.metaDescription!).slice(0, 170) });
  const removals: LandingRevisionOutput['removals'] = (landing?.trustSignals ?? []).map((_, index) => ({ list: 'trustSignals' as const, index }));
  (landing?.benefits ?? []).forEach((b, index) => bad(`${b.title} ${b.text}`) && removals.push({ list: 'benefits', index }));
  return { changes, removals };
}

// ---- the image endpoint --------------------------------------------------------------------------------------------------------

const cache = new Map<string, string>();
/** A valid PNG (never a real picture): a soft gradient with a few shapes, so crops have something to hold on to. */
export async function fakeImageBase64(size: string, prompt = ''): Promise<string> {
  // the picture depends on the prompt: two different prompts give two different files, the same prompt the same one
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

/** A valid Visual Researcher answer built from the CURRENT BRIEF line of the prompt (keeps the style, rewords the guidance). */
export function defaultDirectionRefinement(userText: string) {
  const line = userText.split('\n').find((l) => l.startsWith('{"styleId"'));
  let cur: Record<string, any> = {};
  try {
    cur = JSON.parse(line ?? '{}');
  } catch {
    cur = {};
  }
  return {
    styleId: cur.styleId ?? 'modern_corporate',
    secondaryStyleIds: [] as string[],
    rationale: 'Refined for this business: a calm, specific look that fits its audience.',
    composition: cur.composition?.length ? cur.composition : ['One clear subject with a calm area for text'],
    mood: cur.mood?.length ? cur.mood : ['calm'],
    imageSubjects: cur.imageSubjects?.length ? cur.imageSubjects : ['people at work in a real setting'],
    imageTreatment: cur.imageTreatment?.length ? cur.imageTreatment : ['natural light'],
    channelNotes: cur.channelNotes ?? [],
    limitations: [] as string[],
  };
}

/** A valid Template Selector answer: for each SLOT, the SECOND template of its shortlist when there is one (so a test can see a re-ranking). */
export function defaultTemplatePicks(userText: string) {
  const picks: { slotId: string; templateId: string; reason: string }[] = [];
  for (const block of userText.split(/\n(?=SLOT )/)) {
    const slot = /^SLOT (\S+)/.exec(block)?.[1];
    if (!slot) continue;
    const ids = [...block.matchAll(/^\s+- (\S+) \|/gm)].map((m) => m[1]);
    if (ids.length) picks.push({ slotId: slot, templateId: ids[1] ?? ids[0], reason: 'Suits the concept and keeps the campaign varied.' });
  }
  return { picks };
}
