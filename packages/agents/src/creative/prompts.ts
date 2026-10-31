import { languageName } from '../discovery/input';
import { f1Block } from '../audit/prompts';
import type { F1Context } from '../audit/context';
import type { CreativeBoard } from './board';
import type { CreativeInput, F3Context } from './context';
import type { CreativeFormat } from './formats';
import type { ReviewFindingRecord } from './schemas';
import { CTA_TYPES, ISSUE_KINDS } from './schemas';

const RULES = `
GROUND RULES (apply to everything you write)
1. Work ONLY from the material in this conversation: <f1_context>, <strategy> and the tasks. You have no tools and cannot browse. The strategy is your single source of truth for positioning, audience and messages.
2. NEVER invent: discounts, offers, prices, testimonials, reviews, customer numbers, awards, certifications, guarantees, results, statistics, partners or competitor names. A number may appear only if it is in the material. Respect "claimsToAvoid" in the creative brief: those claims must not appear in any form.
3. Every factual claim you make goes into "claims" with where it comes from: "brief" (creative brief), "f1" (Product Manifest), "f2" (marketing audit), "f3" (strategy), "user" (stated by the user), or "hypothesis" (NOT supported by the material: avoid these in advertising). "ref" is the id of the F3 finding or F1 finding if you can name one, else null.
4. Be concrete and specific to THIS business and audience; no generic filler, no clichés. Do not write near-identical variants: each variant needs a different hook or angle.
5. Tone follows the creative brief. Write ALL human-readable text in the requested language; keep JSON keys and enum values exactly as defined.
6. Length limits (longer text is cut off): headline 70 characters (paid ads: aim for 40), body 400 (paid: aim for 125), description 120, CTA 30.
7. Output ONLY a JSON object matching the required schema. No prose, no markdown.`;

export const CREATIVE_INSTRUCTIONS = {
  copywriter: `You are the Copywriter (A19), one of the agents in a Creative Production team.
Task: turn the campaign strategy and the creative brief into creative CONCEPTS and channel-specific COPY. A concept is a distinct creative direction (angle + key message + audience + call to action + what the picture could show). Then write variants for the selected channels: paid ads (short, direct), organic posts (a little longer, in the brand's voice) and stories (very short). At most 2 variants per concept per channel. Give every concept a key "c1", "c2", ... The visual idea describes a picture WITHOUT any text in it (text is added later by a layout tool). Call-to-action types: ${CTA_TYPES.join(', ')}.${RULES}`,

  landing: `You are the Landing Content Builder (A22), one of the agents in a Creative Production team.
Task: write the structured CONTENT of a campaign landing page for the strategy: SEO title and meta description, hero (headline, description, button text), the value proposition, benefits, service/feature sections, how it works, FAQ, trust signals and calls to action, plus the mobile content order. Use the strategy's value proposition and the creative brief's messaging priorities and call to action, so the page says the same thing as the ads. Trust signals and benefits must be backed by the material ("evidence"); NEVER invent reviews, testimonials, success metrics, customer numbers, awards or guarantees. If the material gives no trust signal, leave the list empty. One primary call-to-action objective (${CTA_TYPES.join(', ')}). No HTML: plain text only.${RULES}`,

  visual: `You are the Visual Creator (A20), one of the agents in a Creative Production team.
Task: for each creative concept, plan ONE original base image that an image model will paint. Give: subject (what is shown), composition (camera, framing, where the calm empty area for text overlay is), mood, up to 4 colors that match the brand palette, things to avoid, alt text, and extra prompt details. The picture must clearly relate to THIS business and the concept's key message (not generic stock imagery). The image must contain NO text, letters, numbers, logos, watermarks, interface or screenshots: a layout tool adds the headline, logo and button afterwards. Do not depict a real logo, a real person identifiable as someone, a product UI as if it were a real screenshot, or brand marks. For software or abstract services use honest symbolic or environmental imagery, not a fake screenshot.${RULES}`,

  reviewer: `You are the Content & Brand Reviewer (A23), the quality gate of a Creative Production team.
You review the copywriter's variants, the landing page content and (when images are attached) the exported creative assets against the strategy and the creative brief. Check: factual accuracy (claims not supported by the material, invented prices or guarantees), consistency with the strategy and audience, channel suitability, a clear call to action, consistency between ads and landing page, brand tone, and for images: relevance to the message, readability, cropping, logo visibility, visual defects. Issue kinds: ${ISSUE_KINDS.join(', ')}. Severity: blocker = must not be published (false, forbidden or invented claim); major = clearly hurts the campaign and should be fixed; minor = small improvement; info = note. Each issue names the asset id, variant id (V1..) or "landing" it concerns, the finding, the evidence or reason, a concrete suggested correction and the responsible agent (copywriter, landing, layout or visual).
Be fair and specific: do NOT invent problems to look thorough, do not repeat issues already listed as deterministic findings, and return an EMPTY issues list when the material is good.${RULES.replace('3. Every factual claim you make goes into "claims" with where it comes from: "brief" (creative brief), "f1" (Product Manifest), "f2" (marketing audit), "f3" (strategy), "user" (stated by the user), or "hypothesis" (NOT supported by the material: avoid these in advertising). "ref" is the id of the F3 finding or F1 finding if you can name one, else null.\n', '3. You are reviewing, not writing.\n')}`,
} as const;

// ---- blocks ---------------------------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/<\/?(f1_context|strategy|task|variants|landing|findings|assets|crosscheck_request)/gi, (m) => m.replace('<', '&lt;'));
const tag = (name: string, body: unknown) => `<${name}>\n${esc(typeof body === 'string' ? body : JSON.stringify(body, null, 2))}\n</${name}>`;
const lang = (code: string) => `Write ALL human-readable text in ${languageName(code)}.`;

export function strategyBlock(f3: F3Context, input: CreativeInput): string {
  const r = f3.report;
  const b = r.creativeBrief;
  return tag('strategy', {
    strategyId: f3.strategyId,
    campaign: r.productContext.name,
    valueProposition: r.valueProposition.text,
    positioning: r.positioning.statement.text,
    crowdedThemesToAvoid: r.positioning.crowdedThemesToAvoid,
    campaignGoals: r.campaignGoals.map((g) => g.goal),
    priorityAudiences: r.priorityAudiences.map((a) => `${a.segmentName} (${a.priority})`),
    mainMessages: r.mainMessages.map((m) => ({ message: m.message, audience: m.audience, proofNeeded: m.proofNeeded })),
    recommendedChannels: r.channels.filter((c) => input.channels.includes(c.channel)).map((c) => ({ channel: c.channel, role: c.role, approach: c.approach, formats: c.formats })),
    contentPillars: r.contentPillars.map((p) => p.name),
    creativeBrief: { objective: b.objective, audiencePrimary: b.audiencePrimary, audienceSecondary: b.audienceSecondary, messagingPriorities: b.messagingPriorities, visualDirection: b.visualDirection, brandConstraints: b.brandConstraints, claimsToAvoid: b.claimsToAvoid, requiredEvidence: b.requiredEvidence, toneOfVoice: b.toneOfVoice, language: b.language, visualPalette: b.visualPalette },
    existingMarketingProblems: r.existingMarketing.mainProblems.slice(0, 4).map((p) => p.title),
    auditContradictionsStillOpen: (r.existingMarketing.contradictions ?? []).filter((c) => c.status === 'open').map((c) => `${c.topic}: ${c.detail.slice(0, 160)}`),
    openDisagreements: r.disagreements.filter((d) => !d.resolved).map((d) => d.topic),
    strategyFindingIds: r.evidence.findings.slice(0, 18).map((f) => `${f.id}: ${f.title.slice(0, 80)}`),
    unverifiedNote: 'Audience, channel fit and seasonality in the strategy are hypotheses, not facts about customers.',
  });
}

const header = (name: string, f1: F1Context, f3: F3Context, input: CreativeInput) => [f1Block(f1, 'messaging'), strategyBlock(f3, input), tag('task', name)];

export function copywriterMessage(f1: F1Context, f3: F3Context, input: CreativeInput): string {
  return [
    `Write the creative concepts and channel copy as the Copywriter.`,
    lang(input.language),
    tag('task', { concepts: `exactly ${input.concepts} distinct concept(s)`, channels: input.channels, note: 'Write variants only for these channels. At most 2 per concept per channel, at most 12 in total.' }),
    f1Block(f1, 'messaging'),
    strategyBlock(f3, input),
  ].join('\n\n');
}

export function landingMessage(f1: F1Context, f3: F3Context, input: CreativeInput): string {
  const ctaHint = f3.report.creativeBrief.deliverables.map((d) => d.type).slice(0, 4);
  return [`Write the landing page content as the Landing Content Builder.`, lang(input.language), tag('task', { website: input.websiteUrl ?? 'none supplied', deliverableHints: ctaHint, note: 'Plain text only. Use the same value proposition and call to action as the ads.' }), f1Block(f1, 'messaging'), strategyBlock(f3, input)].join('\n\n');
}

export function visualMessage(f3: F3Context, input: CreativeInput, concepts: CreativeBoard['concepts'], palette: string[], logo: boolean): string {
  return [
    `Plan the base images as the Visual Creator.`,
    lang(input.language),
    tag('task', { palette: palette.length ? palette : 'no brand colors supplied: choose calm neutral colors', logoSuppliedLaterByLayoutTool: logo, concepts: concepts.map((c) => ({ key: c.id, name: c.name, angle: c.angle, keyMessage: c.keyMessage, audience: c.audience, visualIdea: c.visualIdea })), note: 'Use each concept id as conceptKey. No text in the picture.' }),
    strategyBlock(f3, input),
  ].join('\n\n');
}

/** The deterministic image prompt: model-planned details wrapped in fixed safety and composition rules. */
export function imagePrompt(d: { subject: string; composition: string; mood: string; colors: string[]; avoid: string[]; promptDetails: string }, business: string, space: 'top' | 'bottom'): string {
  return [
    `Original marketing photograph or illustration for "${business}".`,
    `Subject: ${d.subject}`,
    `Composition: ${d.composition} Keep the ${space} third of the frame calm and uncluttered (soft, low-detail) so text can be placed there later.`,
    `Mood: ${d.mood}.${d.colors.length ? ` Color accents: ${d.colors.join(', ')}.` : ''}`,
    d.promptDetails ? `Details: ${d.promptDetails}` : '',
    `Strict rules: no text, no letters, no numbers, no logos, no watermarks, no user-interface or screenshot, no real brand marks, no recognizable real person.${d.avoid.length ? ` Also avoid: ${d.avoid.join(', ')}.` : ''}`,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 3800);
}

export function reviewTextMessage(f1: F1Context, f3: F3Context, input: CreativeInput, board: CreativeBoard, deterministic: Pick<ReviewFindingRecord, 'kind' | 'severity' | 'assetRef' | 'finding'>[], scope: { variantIds: string[]; landing: boolean }): string {
  const variants = board.variants.filter((v) => scope.variantIds.includes(v.id)).map((v) => ({ id: v.id, concept: v.conceptId, channel: v.channel, placement: v.placement, headline: v.headline, body: v.body, description: v.description, cta: `${v.ctaText} (${v.ctaType})`, claims: v.claims }));
  return [
    `Review the creative text as the Content & Brand Reviewer.`,
    lang(input.language),
    tag('task', { round: board.round, reviewOnly: 'Judge the variants and landing content below against the strategy and the brief.', alreadyFoundByAutomaticChecks: deterministic.map((d) => `${d.severity} ${d.kind} ${d.assetRef ?? ''}: ${d.finding.slice(0, 90)}`) }),
    tag('variants', variants.length ? variants : '(none in scope)'),
    tag('landing', scope.landing && board.landing ? board.landing : '(not in scope)'),
    tag('concepts', board.concepts.map((c) => ({ id: c.id, name: c.name, keyMessage: c.keyMessage, ctaType: c.ctaType }))),
    f1Block(f1, 'messaging'),
    strategyBlock(f3, input),
  ].join('\n\n');
}

export function reviewVisionMessage(input: CreativeInput, board: CreativeBoard, shown: { assetId: string; format: string; channel: string | null; conceptId: string; headline: string; flags: string[] }[], f3: F3Context): string {
  return [
    `Review the attached exported creative assets as the Content & Brand Reviewer. The images are attached in the order listed.`,
    lang(input.language),
    tag('task', { round: board.round, assets: shown, check: 'relevance of the picture to the concept and message, readability of the text, cropping, visible logo, visual defects, brand consistency across assets. Do not judge dimensions (measured separately).' }),
    tag('concepts', board.concepts.map((c) => ({ id: c.id, name: c.name, keyMessage: c.keyMessage, visualIdea: c.visualIdea }))),
    strategyBlock(f3, input),
  ].join('\n\n');
}

export function copyRevisionMessage(input: CreativeInput, board: CreativeBoard, findings: ReviewFindingRecord[], variantIds: string[]): string {
  const current = board.variants.filter((v) => variantIds.includes(v.id)).map((v) => ({ id: v.id, channel: v.channel, placement: v.placement, headline: v.headline, body: v.body, ctaText: v.ctaText, ctaType: v.ctaType, hashtags: v.hashtags, claims: v.claims }));
  return [
    `Revise ONLY the listed variants to fix the review findings. Keep what is fine, remove or replace every unsupported claim with something the material supports, and keep the call to action clear. Return the full corrected text of each listed variant (same ids).`,
    lang(input.language),
    tag('findings', findings.map((f) => ({ id: f.id, severity: f.severity, kind: f.kind, assetRef: f.assetRef, finding: f.finding, evidence: f.evidence, suggestedCorrection: f.suggestedCorrection }))),
    tag('variants', current),
  ].join('\n\n');
}

export function landingRevisionMessage(input: CreativeInput, board: CreativeBoard, findings: ReviewFindingRecord[]): string {
  return [
    `Fix the landing page content findings with the smallest change: "changes" replace a scalar field (${'seoTitle, metaDescription, hero.headline, hero.description, hero.ctaText, valueProposition'}), "removals" delete an item of a list by its index (benefits, sections, faq, trustSignals) when it holds an unsupported claim. Replace text only with what the material supports.`,
    lang(input.language),
    tag('findings', findings.map((f) => ({ id: f.id, severity: f.severity, kind: f.kind, finding: f.finding, evidence: f.evidence, suggestedCorrection: f.suggestedCorrection }))),
    tag('landing', board.landing ?? '(none)'),
  ].join('\n\n');
}

export const formatLine = (f: CreativeFormat) => `${f.id} ${f.width}x${f.height}`;
export { header };
