import type { F1Context } from '../audit/context';
import type { ScoutDecision, StrategyFinding } from './board';
import { CHANNELS, scoutName, type ChannelId } from './channels';
import type { F2Context, StrategyInput } from './context';

/**
 * Deterministic Channel Scout eligibility. No model call: transparent rules over the project context decide
 * which channels get a dedicated scout participant. Every rule that fired is recorded, so the UI and the report
 * can explain exactly why a scout was (or was not) created. The rules are a starting heuristic for choosing
 * WHICH specialists to spend model calls on; they are not claims about what works on a channel.
 */
export const SCOUT_THRESHOLD = 4;

const B2B_HINT = /\b(compan(y|ies)|business(es)?|team|enterprise|b2b|manager|startup|agenc(y|ies)|organi[sz]ation|firm|firma|preduze|kompanij|profesional)/i;
const VISUAL = new Set(['physical_product', 'ecommerce', 'local_business', 'education', 'service']);
const SIGNIFICANT_TYPES = new Set(['software', 'agency']);

export interface ScoutContext {
  f1: F1Context;
  f2: F2Context;
  input: StrategyInput;
  /** Audience findings already on the board (segment kinds), if the Audience Researcher succeeded. */
  audience: Pick<StrategyFinding, 'segment' | 'classification'>[];
}

export function evaluateScouts(ctx: ScoutContext, maxScouts: number): ScoutDecision[] {
  const pm = ctx.f1.report.productManifest;
  const bt = String(pm.businessType);
  const segs = ctx.audience.map((a) => a.segment).filter((s): s is NonNullable<typeof s> => !!s);
  let b2b = segs.filter((s) => s.kind === 'b2b').length;
  let b2c = segs.filter((s) => s.kind === 'b2c').length;
  const mixed = segs.filter((s) => s.kind === 'mixed').length;
  const audienceSource = segs.length ? 'audience research' : 'the product manifest';
  if (!segs.length) {
    const hay = `${pm.targetCustomers.join(' ')} ${ctx.input.targetAudience ?? ''}`;
    if (B2B_HINT.test(hay) || SIGNIFICANT_TYPES.has(bt) && /team|compan|business/i.test(hay)) b2b = 1;
    else b2c = 1;
  }
  const isB2B = b2b > 0 && b2b >= b2c;
  const isB2C = b2c > 0 || mixed > 0;
  const local = pm.geography.length > 0 && (bt === 'local_business' || bt === 'service' || bt === 'education' || /local|city|town/i.test(pm.geography.join(' ')));
  const hasSite = !!ctx.input.websiteUrl;
  const supplied = new Set(ctx.input.socialProfiles.map((s) => (s.platform.toLowerCase() === 'twitter' ? 'x' : s.platform.toLowerCase())));
  for (const p of ctx.f2.report.socialPlatforms) if (p.access !== 'not_supplied' && p.access !== 'invalid') supplied.add(p.platform);
  const hasRepo = !!pm.onlinePresence.repository;

  const decisions = CHANNELS.map((ch) => {
    let score = 0;
    const hits: string[] = [];
    const add = (n: number, why: string) => {
      score += n;
      hits.push(`${n > 0 ? '+' : ''}${n} ${why}`);
    };
    const own = ch.social ? supplied.has(ch.social) : false;
    switch (ch.id) {
      case 'instagram':
        if (isB2C) add(3, `consumer audience (${audienceSource})`);
        if (VISUAL.has(bt)) add(2, `visual-friendly business type (${bt})`);
        if (local) add(1, 'local business');
        if (isB2B && !isB2C) add(-3, 'purely business audience');
        if (own) add(2, 'an Instagram profile was supplied');
        break;
      case 'facebook':
        if (isB2C) add(2, `consumer audience (${audienceSource})`);
        if (local) add(2, 'local business');
        if (bt === 'local_business' || bt === 'education' || bt === 'service') add(2, `locally-oriented business type (${bt})`);
        if (own) add(2, 'a Facebook profile was supplied');
        break;
      case 'linkedin':
        if (isB2B) add(4, `business audience (${audienceSource})`);
        if (SIGNIFICANT_TYPES.has(bt)) add(3, `professional business type (${bt})`);
        if (own) add(2, 'a LinkedIn profile was supplied');
        if (isB2C && !isB2B) add(-4, 'purely consumer audience');
        break;
      case 'youtube':
        if (VISUAL.has(bt) || bt === 'software') add(3, `demonstrations and tutorials suit the business type (${bt})`);
        if (isB2C) add(1, 'consumer audience');
        if (hasSite) add(1, 'a website exists to link to');
        if (own) add(2, 'a YouTube channel was supplied');
        break;
      case 'tiktok':
        if (isB2C && VISUAL.has(bt)) add(3, 'consumer audience with a visual offer');
        if (own) add(3, 'a TikTok profile was supplied');
        if (isB2B && !isB2C) add(-3, 'purely business audience');
        break;
      case 'google_search':
        if (['local_business', 'service', 'education', 'software', 'ecommerce', 'physical_product', 'agency'].includes(bt)) add(3, `people search for this kind of offer (${bt})`);
        if (local) add(2, 'local intent searches');
        if (hasSite) add(1, 'a website exists as a landing page');
        else add(-1, 'no website yet: needs a landing page or business listing first');
        break;
      case 'email':
        if (isB2B || bt === 'software' || bt === 'ecommerce' || bt === 'education') add(3, `repeat contact suits the business (${bt}${isB2B ? ', business audience' : ''})`);
        add(1, 'owned channel');
        if (hasSite) add(2, 'a website exists to collect subscribers');
        else add(-2, 'no website to collect subscribers');
        break;
      case 'organic_content':
        add(3, 'every business can publish owned content');
        if (hasSite) add(1, 'a website exists to host it');
        break;
      case 'community':
        if (bt === 'software' || bt === 'education') add(2, `communities form around ${bt}`);
        if (hasRepo) add(2, 'a public repository exists');
        if (local) add(1, 'local clubs and groups');
        break;
    }
    return { channel: ch.id as ChannelId, name: scoutName(ch.id), selected: false, score, ruleHits: hits, reason: '' };
  });

  const eligible = decisions.filter((d) => d.score >= SCOUT_THRESHOLD).sort((a, b) => b.score - a.score || CHANNELS.findIndex((c) => c.id === a.channel) - CHANNELS.findIndex((c) => c.id === b.channel));
  let chosen = eligible.slice(0, Math.max(0, maxScouts));
  if (!chosen.length && maxScouts > 0) chosen = [decisions.find((d) => d.channel === 'organic_content')!];
  const chosenSet = new Set(chosen.map((d) => d.channel));
  for (const d of decisions) {
    d.selected = chosenSet.has(d.channel);
    const rules = d.ruleHits.length ? d.ruleHits.join('; ') : 'no rule applied';
    d.reason = d.selected
      ? `Selected (score ${d.score}, threshold ${SCOUT_THRESHOLD}): ${rules}`
      : d.score >= SCOUT_THRESHOLD
        ? `Not selected: score ${d.score} qualifies, but the limit of ${maxScouts} scouts per run was reached by higher-scoring channels (${rules})`
        : `Not selected: score ${d.score} is below the threshold of ${SCOUT_THRESHOLD} (${rules})`;
  }
  return decisions.sort((a, b) => Number(b.selected) - Number(a.selected) || b.score - a.score);
}
