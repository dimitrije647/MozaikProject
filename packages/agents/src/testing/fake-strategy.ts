import { CHANNELS, channelById } from '../strategy/channels';
import type { LlmStrategyFinding, StrategyAgentOutput, StrategyDraft } from '../strategy/schemas';
import { parseSources, type PromptSource } from './prompt-parse';

/**
 * Default (valid) answers of the F3 agents for the fake OpenAI server. Built from the prompt the request actually
 * carried, so findings cite real source ids and VERBATIM lines of the blocks they were shown.
 */
export type StrategyFakeAgent = 'audience' | 'competitor' | 'seasonal' | 'scout' | 'strategist';

export function parseStrategyFindingIds(text: string) {
  return [...text.matchAll(/\[(A\d{2}(?:-[A-Z]{2})?-\d+)\] \((\w+), (\w+), (\w+), (\w+)/g)].map((m) => ({ id: m[1], classification: m[2], importance: m[3], area: m[4], kind: m[5] }));
}

const line = (text: string, prefix: string) => text.split('\n').find((l) => l.startsWith(prefix)) ?? null;

const F = (f: Partial<LlmStrategyFinding> & Pick<LlmStrategyFinding, 'kind' | 'title' | 'statement' | 'classification'>): LlmStrategyFinding => ({
  importance: 'medium',
  sourceType: 'ai_inference',
  sourceId: null,
  locator: null,
  excerpt: null,
  reasoning: 'Follows from the supplied F1/F2 context.',
  confidence: 0.6,
  recommendation: null,
  segment: null,
  competitor: null,
  channel: null,
  opportunity: null,
  ...f,
});

const isSoftware = (t: string) => /"businessType": "(software|agency)"/.test(t);

export function defaultStrategyAnalysis(agent: StrategyFakeAgent, userText: string, channel: string | null): StrategyAgentOutput {
  const sources = parseSources(userText);
  switch (agent) {
    case 'audience': {
      const f1Ref = /\[(A\d{1,2}-\d+)\] \(\w+, [A-Za-z ]+\)/.exec(userText)?.[1] ?? null;
      const b2b = isSoftware(userText);
      const seg = (name: string, kind: 'b2b' | 'b2c', fit: 'strong' | 'moderate') =>
        F({
          kind: 'hypothesis',
          title: `Segment: ${name}`,
          statement: `${name} may be a customer segment for this offer.`,
          classification: 'inferred',
          importance: 'high',
          sourceType: f1Ref ? 'f1_finding' : 'ai_inference',
          locator: f1Ref,
          segment: { name, kind, needs: ['A clear, trustworthy offer'], painPoints: ['Unclear where to start'], motivations: ['Wants a good result'], barriers: ['Price uncertainty'], decisionProcess: 'Compares a few options before deciding.', messagingPreferences: ['Plain language'], productFit: fit },
        });
      return {
        summary: 'Hypothesized customer segments for the offer.',
        findings: b2b ? [seg('Small remote teams', 'b2b', 'strong'), seg('Team leads', 'b2b', 'moderate')] : [seg('Curious beginners', 'b2c', 'strong'), seg('Holiday travelers', 'b2c', 'moderate')],
        missingInformation: ['No customer interviews or survey data'],
      };
    }
    case 'competitor': {
      const pages = sources.filter((s) => s.kind === 'website');
      const leads = sources.filter((s) => s.kind === 'search_result');
      const findings: LlmStrategyFinding[] = pages.map((p, i) => {
        const title = line(p.text, 'title:') ?? p.label;
        const url = /^url: (\S+)/m.exec(p.text)?.[1] ?? null;
        const crowded = /premium/i.test(p.text) ? 'premium quality' : null;
        return F({
          kind: 'observation',
          title: `Competitor: ${p.label}`,
          statement: `${p.label} offers a comparable service and positions itself on its own site.`,
          classification: 'verified',
          importance: 'high',
          sourceType: 'website',
          sourceId: p.id,
          locator: url,
          excerpt: title.slice(0, 120),
          competitor: { name: p.label.slice(0, 100), url, relation: i === 0 ? 'direct' : 'indirect', existence: 'confirmed', positioning: 'Positions on its own strengths.', offerings: ['Main service'], differentiators: [], weaknesses: [], crowdedTheme: crowded },
        });
      });
      for (const l of leads.filter((l) => !pages.some((p) => p.label === l.label)).slice(0, 2)) {
        findings.push(F({ kind: 'claim_on_source', title: `Lead: ${l.label}`, statement: `A search result mentions ${l.label}.`, classification: 'claimed', sourceType: 'search_result', sourceId: l.id, excerpt: l.label.slice(0, 80), competitor: { name: l.label.slice(0, 100), url: null, relation: 'indirect', existence: 'unconfirmed', positioning: null, offerings: [], differentiators: [], weaknesses: [], crowdedTheme: null } }));
      }
      return { summary: 'Competitors found in the retrieved material.', findings, missingInformation: ['Prices of competitors are unknown'] };
    }
    case 'seasonal': {
      const cal = sources.find((s) => s.kind === 'holiday_calendar');
      const findings: LlmStrategyFinding[] = [];
      const first = cal?.text.split('\n').find((l) => /^\d{4}-\d{2}-\d{2} \| /.test(l));
      if (cal && first) {
        const [date, name] = first.split(' | ');
        findings.push(
          F({
            kind: 'observation',
            title: `Public holiday: ${name}`,
            statement: `${name} falls on ${date} according to the public holiday calendar.`,
            classification: 'verified',
            importance: 'medium',
            sourceType: 'holiday_api',
            sourceId: cal.id,
            excerpt: first,
            opportunity: { name, window: date, startDate: date, endDate: date, dateBasis: 'public_holiday_api', leadTimeWeeks: 4, relevance: 'A public holiday may change attention and availability.', regionNote: null },
          }),
        );
      }
      findings.push(
        F({
          kind: 'hypothesis',
          title: 'Recurring summer season',
          statement: 'Interest in this kind of offer may rise in the warmer months (a typical pattern, not measured here).',
          classification: 'verified',
          importance: 'medium',
          opportunity: { name: 'Summer season', window: 'June to August', startDate: null, endDate: null, dateBasis: 'public_holiday_api', leadTimeWeeks: 8, relevance: 'Plan content weeks ahead of the season.', regionNote: null },
        }),
      );
      return { summary: 'Time-sensitive opportunities.', findings, missingInformation: ['No local event calendar was supplied'] };
    }
    case 'scout': {
      const ch = channelById(channel ?? 'organic_content')!;
      const audienceId = /\[(A14-\d+)\]/.exec(userText)?.[1] ?? null;
      const primary = ['instagram', 'linkedin', 'google_search'].includes(ch.id);
      return {
        summary: `${ch.name} evaluated for this business.`,
        findings: [
          F({
            kind: 'assessment',
            title: `${ch.name} fit`,
            statement: `${ch.name} looks ${primary ? 'like a good' : 'like a possible'} channel for this offer, as a hypothesis.`,
            classification: 'inferred',
            importance: 'high',
            reasoning: `Based on the segments ${audienceId ?? 'in the audience research'} and the F2 audit.`,
            channel: { channel: ch.id, fit: primary ? 'strong' : 'moderate', audienceFit: 'The segments are likely to use this channel.', organicSuitability: 'high', paidSuitability: 'unknown', contentTypes: ['Short posts'], complexity: 'medium', constraints: ['Needs regular content'], measurement: ['Engagement and clicks to the website'], risks: ['Effort without a clear audience'], role: primary ? 'primary' : 'secondary' },
          }),
          F({ kind: 'gap', title: `${ch.name} measurement`, statement: 'No platform statistics are available to size the opportunity.', classification: 'unknown', importance: 'low' }),
        ],
        missingInformation: ['Platform reach is unknown'],
      };
    }
    default:
      return { summary: '', findings: [], missingInformation: [] };
  }
}

export function defaultStrategyDraft(userText: string, overrides: Partial<StrategyDraft> = {}): StrategyDraft {
  const ids = parseStrategyFindingIds(userText);
  const of = (area: string) => ids.filter((i) => i.area === area).map((i) => i.id);
  const st = (text: string, findingIds: string[], status: StrategyDraft['valueProposition']['status'] = 'inferred') => ({ text, status, basis: findingIds.length ? `Findings ${findingIds.join(', ')}` : 'No direct finding', caveat: null, findingIds });
  const recommend = /The channels you may recommend are exactly: (.*)\./.exec(userText)?.[1] ?? '';
  const channelIds = recommend.split(',').map((s) => s.trim()).filter((s) => CHANNELS.some((c) => c.id === s)) as (typeof CHANNELS)[number]['id'][];
  const scoutIdFor = (id: string) => {
    const short = CHANNELS.find((c) => c.id === id)!.short;
    return ids.find((i) => i.id.startsWith(`A16-${short}-`))?.id;
  };
  const audienceIds = of('audience');
  const competitorIds = of('competitor');
  const partial = /Set partial=true/.test(userText);
  const first = channelIds[0];
  return {
    schemaVersion: 1,
    language: 'en',
    partial,
    executiveSummary: 'A strategy built from the audience, competitor, seasonal and channel findings.',
    priorityAudiences: audienceIds.slice(0, 2).map((id, i) => ({ segmentName: i === 0 ? 'Primary segment' : 'Secondary segment', priority: i === 0 ? ('primary' as const) : ('secondary' as const), rationale: 'Best product fit among the hypothesized segments.', findingIds: [id] })),
    campaignGoals: [{ goal: 'Increase qualified enquiries', measuredBy: 'Number of enquiries from the chosen channels', rationale: 'Matches the stated marketing goal.', findingIds: audienceIds.slice(0, 1) }],
    valueProposition: st('A clear and trustworthy offer for the primary segment.', audienceIds.slice(0, 1)),
    positioning: {
      statement: st('Position as the approachable, trustworthy option.', [...audienceIds.slice(0, 1), ...competitorIds.slice(0, 1)]),
      differentiators: [st('Premium quality is the differentiator.', competitorIds.slice(0, 1), 'verified')],
      crowdedThemesToAvoid: [],
    },
    mainMessages: [{ message: 'Start with a clear first step', audience: 'Primary segment', proofNeeded: ['Customer evidence'], findingIds: audienceIds.slice(0, 1) }],
    channels: channelIds.map((c, i) => ({ channel: c, role: i === 0 ? ('primary' as const) : ('secondary' as const), approach: 'organic' as const, rationale: `Recommended by the ${c} scout.`, formats: ['Short posts'], findingIds: [scoutIdFor(c)].filter((x): x is string => !!x) })),
    organicPaid: { approach: 'Start organic, test paid later.', paidRole: 'Amplify what works organically.', budgetNote: 'No budget was supplied.' },
    timing: of('seasonal').slice(0, 1).map((id) => ({ window: 'Before the season', rationale: 'Plan ahead of the seasonal window.', dateBasis: 'recurring_pattern' as const, findingIds: [id] })),
    contentPillars: [{ name: 'Getting started', description: 'Explain the first step.', channels: first ? [first] : [], findingIds: audienceIds.slice(0, 1) }],
    campaignStructure: [{ phase: 'Prepare', duration: '2 weeks', objective: 'Fix the audit problems', activities: ['Fix the website message'] }],
    kpis: [{ kpi: 'Qualified enquiries', channel: first ?? null, measuredBy: 'Form submissions' }],
    risks: [{ risk: 'Segments are unvalidated hypotheses', mitigation: 'Validate with a small test', findingIds: audienceIds.slice(0, 1) }],
    strategicPriorities: [{ priority: 'Fix the message first', rationale: 'The audit found an unclear message.', findingIds: audienceIds.slice(0, 1) }],
    disagreements: [],
    openQuestions: ['Who is the ideal customer?'],
    additionalLimitations: [],
    creativeBrief: {
      objective: 'Drive qualified enquiries',
      audiencePrimary: 'Primary segment',
      audienceSecondary: ['Secondary segment'],
      messagingPriorities: ['Clear first step'],
      channels: channelIds.slice(0, 2).map((c) => ({ channel: c, formats: ['Short post'], notes: 'Keep it simple.' })),
      visualDirection: null,
      brandConstraints: ['No brand guideline was supplied'],
      claimsToAvoid: [{ claim: 'Guaranteed results', reason: 'No evidence supports a guarantee.' }],
      requiredEvidence: ['Customer testimonials'],
      deliverables: [{ type: 'Social post', channel: first ?? null, count: 3 }],
      suggestedConceptCount: 3,
      toneOfVoice: 'Friendly',
    },
    ...overrides,
  };
}

export type { PromptSource };
