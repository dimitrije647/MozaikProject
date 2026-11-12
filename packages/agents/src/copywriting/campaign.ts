import type { F1Context } from '../audit/context';
import type { CreativeInput, F3Context } from '../creative/context';
import { planCopywriting, type CopyPlan } from './plan';
import { inferBrandVoice } from './voice';

/**
 * The copywriting plan of ONE campaign from what the run already has: the business research (industry, offering, brand notes, confidence),
 * the strategy's creative brief (tone of voice, copy direction), the campaign input (objective, audience, platforms, the user's voice
 * override), the approved collection (a soft hint) and the facts the user entered. Deterministic: no model call, nothing re-researched.
 */
export function campaignCopyPlan(a: { f1: F1Context; f3: F3Context; input: CreativeInput; collectionId: string | null; facts?: { offer?: string; offerDetail?: string; date?: string } | null }): CopyPlan {
  const pm = a.f1.report.productManifest;
  const brief = a.f3.report.creativeBrief;
  const voice = inferBrandVoice({
    language: a.input.language,
    audience: a.input.audience || brief.audiencePrimary || null,
    industry: pm.industry ?? null,
    category: pm.category ?? null,
    businessType: pm.businessType ?? null,
    offering: pm.offering ? [pm.offering.summary, ...pm.offering.items].join(' ') : null,
    brandStyle: pm.brand?.style ?? null,
    brandNotes: pm.brand?.notes ?? null,
    toneOfVoice: brief.toneOfVoice ?? null,
    researchConfidence: pm.overallConfidence ?? null,
    collectionId: a.collectionId,
    override: a.input.voice ?? null,
  });
  return planCopywriting({
    objective: a.input.objective || brief.objective || null,
    direction: brief.copyDirection ?? null,
    voice,
    platforms: a.input.channels,
    hasWebsite: !!a.input.websiteUrl,
    userFacts: a.facts ?? null,
  });
}
