import { languageName } from '../discovery/input';
import type { F1Context } from '../audit/context';
import type { CreativeBoard } from './board';
import type { CreativeInput, F3Context } from './context';
import type { CreativeFormat } from './formats';
import type { ReviewFindingRecord } from './schemas';
import { CTA_TYPES, ISSUE_KINDS, CAMPAIGN_PLATFORMS, isCampaignPlatform } from './schemas';
import { planForPrompt, type CopyPlan } from '../copywriting/plan';
import { principleGuide } from '../copywriting/principles';

const RULES = `
GROUND RULES (apply to everything you write)
1. Work ONLY from the material in this conversation: <business_research>, <strategy> and the task. You have no tools and cannot browse. The strategy is your single source of truth for positioning, audience and messages: do not invent a different strategy.
2. NEVER invent: discounts, offers, prices, testimonials, reviews, customer numbers, awards, certifications, guarantees, results, statistics, partners, competitor names, web addresses, e-mail addresses, street addresses, calendar dates or deadlines. A number may appear only if it is in the material. If the project has no website, no text shows any web address: the call to action names an action ("Learn more", "Get started"), never a place. Respect "claimsToAvoid" in the creative brief: those claims must not appear in any form.
3. Every factual claim you make goes into "claims" with where it comes from: "brief" (creative brief), "f1" (business research), "f3" (strategy), "user" (stated by the user), or "hypothesis" (NOT supported by the material: avoid these in advertising). "ref" is the id of the F3 or F1 finding if you can name one, else null.
4. Be concrete and specific to THIS business and audience; no generic filler, no clichés.
5. Tone follows the brand voice in <copy_plan> (and the creative brief). Write ALL human-readable text in the requested language; keep JSON keys and enum values exactly as defined.
6. Output ONLY a JSON object matching the required schema. No prose, no markdown.`;

export const CREATIVE_INSTRUCTIONS = {
  writer: `You are the Content Writer (A3) of a small marketing team. Your only job is the campaign's TEXT; layout, pictures and rendering are done by others. The strategy decided WHY and WHAT to communicate; you decide HOW.
HOW YOU WRITE. Follow <copy_plan>: its purpose, its PRIMARY principles (build on them), its OPTIONAL principles (only where they fit naturally), its EXCLUDED principles (never use them), the brand voice and, per placement, the principles that suit the format, the length limits (a platform maximum is a hard limit) and the format guidance. Pick a natural combination for every piece: a concise piece that applies two or three principles well beats one that forces many, and more principles is never better. List in "principles" only the ids a piece really applies. Write for THIS business, offering, audience and industry in the brand's own voice: a diving school, a fashion label, a software startup and a governance consultancy must sound different; never borrow another brand's phrases and never sound like generic marketing. Keep the core message consistent and change the presentation per platform.
1. CONCEPTS: write the requested number of campaign concepts. Each one is built on ONE main message or content pillar of the strategy (name it in "basis"): an angle, a key message, the audience, a call to action (types: ${CTA_TYPES.join(', ')}), a "visualIdea" describing what a REAL photograph of this business should show (used to pick an approved picture; no picture is generated), its "purpose" and a one-sentence "principleNote" (which principles it uses and why; internal, for the review). Keys "c1", "c2", ...
2. SOCIAL POSTS: for EVERY concept write one post per platform (${CAMPAIGN_PLATFORMS.join(', ')}), native to that platform; never copy the same text across platforms and do not open every post the same way. "hook" is the headline shown on the visual and the first line; "text" is the post as published; "visualLine" is a short, complete supporting line for the visual (not a cut-off sentence); "postingFormat" says how to publish it; hashtags only where they help and within the limit.
   - tiktok: "hook" is the cover-image text and the opening line of the video; "text" is a short caption; "videoScript" is a 15 to 30 second concept the owner can film (opening hook, up to 5 short scenes with seconds, what is filmed, on-screen text, voiceover, a sound note). NEVER say or imply that a video was made. videoScript is null on every other platform.
3. ADS: for the lead concepts write a "web_ad" (web banner) and a "display_ad": attention, ONE benefit, ONE action.
4. PRINT: for the lead concept write a "billboard" (one idea in very few words; empty body and visualLine) and a "flyer" (headline, the clear benefit, a short supporting explanation with evidence, a visualLine and a call to action).
5. A call to action names an action that really exists; with no destination it names the action, never a place, and "missingInformation" says the destination is missing.${RULES}

${principleGuide('full')}`,

  reviewer: `You are the Quality Reviewer (A6), the quality gate of a small marketing team. You review the campaign's copy (posts for each platform, ad and print copy) and, when images are attached, the rendered creatives, against the business research, the strategy, the creative brief and the <copy_plan> (purpose, principles, brand voice, placement limits).
Judge: audience relevance, headline strength, specificity, clarity, brand voice (the profile in the plan), factual credibility (claims the material does not support, invented prices, guarantees, credentials, urgency or limitations), call-to-action quality, platform fit, copy/visual alignment (when images are attached), originality and repetition. Flag generic slogans, repetitive openings, unsupported promises, artificial urgency, empty motivational language, unnecessary jargon, copy repeated across channels and identical calls to action with no strategic reason. Judge the principles by how naturally they serve the message: flag a principle that is forced, excluded by the plan or applied without evidence (kind "principle_misuse"); NEVER reward a piece for using more principles (three applied well beat ten forced) and never ask for a principle the format has no room for.
Issue kinds: ${ISSUE_KINDS.join(', ')}. Severity: blocker = must not be published (false, forbidden or invented claim); major = clearly hurts the campaign; minor = small improvement; info = note. Each issue names the creative asset id, the copy id (V1..) or the concept id (K1..) it concerns, the finding, the evidence, a concrete suggested correction and who fixes it ("copywriter" for text, "layout" for a rendered creative, "visual" for a picture problem).
Besides the issues, SCORE from 1 (unusable) to 5 (excellent; 3 = acceptable; 2 or less = weak) in "scores" when you review text: productAccuracy (factual credibility), brandConsistency (brand voice), audienceRelevance, objectiveAlignment, originality (an angle only THIS business could claim; no repetition), crossChannelConsistency, headlineStrength, specificity, clarity, ctaQuality, platformFit, principleFit (the planned principles applied naturally, none forced). Use null for "scores" when you review images only. A call to action is given as {text, type}: only "text" is visible; "type" is an internal label.
Be fair and specific: do NOT invent problems, do not repeat issues already found by the automatic checks, and return an EMPTY issues list when the material is good.
You are reviewing, not writing. Output ONLY a JSON object matching the required schema.

${principleGuide('review')}`,
} as const;

// ---- blocks ---------------------------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/<\/?(business_research|strategy|task|copy|findings|assets|concepts|copy_plan)/gi, (m) => m.replace('<', '&lt;'));
const tag = (name: string, body: unknown) => `<${name}>\n${esc(typeof body === 'string' ? body : JSON.stringify(body, null, 2))}\n</${name}>`;
const lang = (code: string) => `Write ALL human-readable text in ${languageName(code)}.`;

const MESSAGING_CATEGORIES = new Set(['value_proposition', 'usp', 'differentiator', 'claim', 'offering', 'customer_segment', 'communication', 'problem']);

/** The business research (Product Manifest and the findings relevant to messaging). */
export function businessBlock(f1: F1Context): string {
  const pm = f1.report.productManifest;
  const lines = f1.findings.filter((f) => MESSAGING_CATEGORIES.has(f.category)).slice(0, 24).map((f) => `[${f.id}] (${f.classification}) ${f.statement}${f.excerpt ? ` | excerpt: "${f.excerpt.slice(0, 140)}"` : ''}`);
  return tag('business_research', {
    f1ReportId: f1.reportId,
    partial: f1.partial,
    productManifest: { name: pm.name, tagline: pm.tagline, category: pm.category, industry: pm.industry, businessType: pm.businessType, offering: pm.offering, problem: pm.problem, valueProposition: pm.valueProposition, targetCustomers: pm.targetCustomers, geography: pm.geography, languages: pm.languages, differentiators: pm.differentiators, brand: pm.brand, onlinePresence: pm.onlinePresence, openQuestions: pm.openQuestions, confidence: pm.overallConfidence },
    findings: lines.length ? lines : 'No research finding is relevant to the messaging.',
  });
}

export function strategyBlock(f3: F3Context, input: CreativeInput): string {
  const r = f3.report;
  const b = r.creativeBrief;
  const legacy = (r as { existingMarketing?: { mainProblems?: { title: string }[] } | null }).existingMarketing;
  return tag('strategy', {
    strategyId: f3.strategyId,
    campaign: r.productContext.name,
    ...(input.objective ? { objectiveStatedByUser: input.objective } : {}),
    ...(input.audience ? { targetAudienceStatedByUser: input.audience } : {}),
    valueProposition: r.valueProposition.text,
    positioning: r.positioning.statement.text,
    crowdedThemesToAvoid: r.positioning.crowdedThemesToAvoid,
    campaignGoals: r.campaignGoals.map((g) => g.goal),
    priorityAudiences: r.priorityAudiences.map((a) => `${a.segmentName} (${a.priority})`),
    mainMessages: r.mainMessages.map((m) => ({ message: m.message, audience: m.audience, proofNeeded: m.proofNeeded })),
    contentPillars: r.contentPillars.map((p) => ({ name: p.name, description: p.description })),
    channels: r.channels.filter((c) => input.channels.includes(c.channel)).map((c) => ({ channel: c.channel, role: c.role, approach: c.approach, formats: c.formats })),
    creativeBrief: { objective: b.objective, audiencePrimary: b.audiencePrimary, audienceSecondary: b.audienceSecondary, messagingPriorities: b.messagingPriorities, visualDirection: b.visualDirection, brandConstraints: b.brandConstraints, claimsToAvoid: b.claimsToAvoid, requiredEvidence: b.requiredEvidence, toneOfVoice: b.toneOfVoice, language: b.language },
    ...(legacy?.mainProblems?.length ? { knownMarketingProblems: legacy.mainProblems.slice(0, 4).map((p) => p.title) } : {}),
    openDisagreements: r.disagreements.filter((d) => !d.resolved).map((d) => d.topic),
    strategyFindingIds: r.evidence.findings.slice(0, 18).map((f) => `${f.id}: ${f.title.slice(0, 80)}`),
    unverifiedNote: 'Audience, channel fit and seasonality in the strategy are hypotheses, not facts about customers.',
  });
}

/** The copywriting plan for the writer and the reviewer. */
export function copyPlanBlock(plan: CopyPlan, f3: F3Context): string {
  return tag('copy_plan', planForPrompt(plan, f3.report.creativeBrief.copyDirection ?? null));
}

export function writerMessage(f1: F1Context, f3: F3Context, input: CreativeInput, plan: CopyPlan): string {
  const lead = Math.min(2, input.concepts);
  const platforms = input.channels.filter(isCampaignPlatform);
  return [
    'Write the campaign text as the Content Writer.',
    lang(input.language),
    tag('task', {
      concepts: `exactly ${input.concepts} distinct concept(s), each built on a different main message or content pillar of the strategy`,
      posts: platforms.length ? `one post per concept for each of: ${platforms.join(', ')}` : 'no social posts for this campaign',
      ads: `a web_ad and a display_ad for each of the first ${lead} concept(s)`,
      print: 'a billboard and a flyer for the first concept',
      website: input.websiteUrl ?? 'none supplied: no web address may appear anywhere',
    }),
    copyPlanBlock(plan, f3),
    businessBlock(f1),
    strategyBlock(f3, input),
  ].join('\n\n');
}

const copyView = (v: CreativeBoard['variants'][number]) => ({ id: v.id, concept: v.conceptId, placement: v.placement, platform: v.placement === 'social_post' ? v.channel : null, headline: v.headline, body: v.body, description: v.description, ...(v.visualLine ? { visualLine: v.visualLine } : {}), cta: { text: v.ctaText, type: v.ctaType }, hashtags: v.hashtags, claims: v.claims, principles: v.principles ?? [], ...(v.videoScript ? { videoScript: v.videoScript } : {}) });

export function reviewTextMessage(f1: F1Context, f3: F3Context, input: CreativeInput, board: CreativeBoard, deterministic: Pick<ReviewFindingRecord, 'kind' | 'severity' | 'assetRef' | 'finding'>[], variantIds: string[], plan: CopyPlan): string {
  return [
    'Review the campaign copy as the Quality Reviewer.',
    lang(input.language),
    tag('task', { round: board.round, reviewOnly: 'Judge the copy below against the research, the strategy and the brief.', alreadyFoundByAutomaticChecks: deterministic.slice(0, 30).map((d) => `${d.severity} ${d.kind} ${d.assetRef ?? ''}: ${d.finding.slice(0, 90)}`) }),
    tag('copy', board.variants.filter((v) => variantIds.includes(v.id)).map(copyView)),
    tag('concepts', board.concepts.map((c) => ({ id: c.id, name: c.name, basis: c.basis ?? null, keyMessage: c.keyMessage, ctaType: c.ctaType, purpose: c.purpose ?? null, principleNote: c.principleNote ?? null }))),
    copyPlanBlock(plan, f3),
    businessBlock(f1),
    strategyBlock(f3, input),
  ].join('\n\n');
}

export function reviewVisionMessage(input: CreativeInput, board: CreativeBoard, shown: { assetId: string; format: string; channel: string | null; conceptId: string; headline: string; flags: string[] }[], f3: F3Context): string {
  return [
    'Review the attached rendered creatives as the Quality Reviewer. The images are attached in the order listed.',
    lang(input.language),
    tag('task', { round: board.round, assets: shown, check: 'relevance of the picture to the concept and message, whether the copy on the visual and the picture tell the same story, readability of the text, cropping, visible logo, visual defects, brand consistency across creatives. Do not judge dimensions (measured separately).' }),
    tag('concepts', board.concepts.map((c) => ({ id: c.id, name: c.name, keyMessage: c.keyMessage, visualIdea: c.visualIdea }))),
    strategyBlock(f3, input),
  ].join('\n\n');
}

export function copyRevisionMessage(input: CreativeInput, board: CreativeBoard, findings: ReviewFindingRecord[], variantIds: string[], plan: CopyPlan): string {
  return [
    'Revise ONLY the listed copy to fix the review findings. Keep what is fine, remove or replace every unsupported claim with something the material supports, keep the call to action clear, keep each piece right for its platform and within its limits, keep the brand voice and never use an excluded principle. Return the full corrected text of each listed copy (same ids; "headline" is the hook or headline, "body" the post text, the ad description or the flyer body, "visualLine" the short line on the visual, empty when the piece has none).',
    lang(input.language),
    tag('copy_plan', { voice: planForPrompt(plan, null).voice, excluded: plan.excluded.map((e) => `${e.id}: ${e.reason}`), placements: plan.placements.map((x) => ({ placement: x.key, limits: x.limits })) }),
    tag('findings', findings.map((f) => ({ id: f.id, severity: f.severity, kind: f.kind, assetRef: f.assetRef, finding: f.finding, evidence: f.evidence, suggestedCorrection: f.suggestedCorrection }))),
    tag('copy', board.variants.filter((v) => variantIds.includes(v.id)).map(copyView)),
  ].join('\n\n');
}

export const formatLine = (f: CreativeFormat) => `${f.id} ${f.width}x${f.height}`;
