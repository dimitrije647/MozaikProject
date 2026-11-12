import { buildPhasePlan, campaignSettings, initialPhases, planResearch, PHASE_ORDER, SOCIAL_CHANNELS, voiceSettings, type ResearchCandidate } from '../src/mozaik/factory-plan';
import { estimateCost } from '../src/mozaik/cost-estimate';

/**
 * V4 CAMPAIGN PRODUCTION: the pure planning rules of the one production workflow. No database, no network, no provider: nothing is billed.
 * (Written with the V4 simplification; to be run in the dedicated verification task.)
 */
describe('Campaign Production planning (V4)', () => {
  const project = { marketingGoal: 'More course sign-ups', targetAudience: 'Beginners in Novi Sad', seasonalCalendar: false };
  const report = (id: string, createdAt: string, o: Partial<ResearchCandidate> = {}): ResearchCandidate => ({ id, runId: `run-${id}`, createdAt: new Date(createdAt), model: 'm', partial: false, usable: true, ...o });

  it('has ONE workflow: Business Research -> Marketing Strategy -> Creative Production, with no audit stage', () => {
    expect(PHASE_ORDER).toEqual(['discovery', 'strategy', 'creative']);
    const phases = initialPhases(buildPhasePlan(null));
    expect(phases.map((p) => [p.code, p.action])).toEqual([['F1', 'run'], ['F3', 'run'], ['F4', 'run']]);
  });

  it('defaults come from the project; all five social platforms; 3 concepts; nothing about presets, models or images', () => {
    const s = campaignSettings({}, project);
    expect(s).toEqual({ objective: 'More course sign-ups', targetAudience: 'Beginners in Novi Sad', channels: [...SOCIAL_CHANNELS], concepts: 3, competitorUrls: [], useHolidayCalendar: false, refreshResearch: false, voice: null });
    expect(Object.keys(s)).not.toEqual(expect.arrayContaining(['preset', 'imageModel', 'model']));
  });

  it('the campaign may override objective, audience, channels and concepts; unknown channels are ignored; concepts are clamped', () => {
    const s = campaignSettings({ objective: '  Launch the summer course ', targetAudience: 'Families', channels: ['x', 'tiktok', 'youtube', 'x'], concepts: 9 }, project);
    expect(s.objective).toBe('Launch the summer course');
    expect(s.targetAudience).toBe('Families');
    expect(s.channels).toEqual(['x', 'tiktok']);
    expect(s.concepts).toBe(5);
  });

  it('current research is reused (only Business Research); stale or refreshed research runs again; old schema is never reused', () => {
    const list = [report('new', '2026-11-10T10:00:00Z'), report('old', '2026-11-01T10:00:00Z')];
    expect(planResearch(list, new Date('2026-11-09T00:00:00Z'), false).reuse?.id).toBe('new');
    expect(planResearch(list, new Date('2026-11-11T00:00:00Z'), false).reuse).toBeNull();
    expect(planResearch(list, null, true).reuse).toBeNull();
    expect(planResearch([report('v1', '2026-11-10T10:00:00Z', { usable: false })], null, false).reuse).toBeNull();
    const plan = buildPhasePlan(list[0]);
    expect(plan.map((p) => p.action)).toEqual(['reuse', 'run', 'run']);
  });

  it('the cost estimate covers text calls only and says when the approved budget is below it', () => {
    const est = estimateCost({ textModel: 'unpriced-model', phases: [{ phase: 'discovery', runs: true, typicalCalls: 2, capCalls: 5, outputCap: 6000 }], profiles: {}, approvedUsd: 1 });
    expect(est.available).toBe(false);
    expect(est.totals.typicalUsd).toBeNull();
    expect(est.budget.status).toBe('unknown');
  });

  it('the writing style is an optional override: unknown tones are ignored, empty input means "infer the brand voice"', () => {
    expect(voiceSettings(null)).toBeNull();
    expect(voiceSettings({ tone: 'shouty', avoid: ['  '] })).toBeNull();
    expect(voiceSettings({ tone: 'playful', humor: false, avoid: ['cheap', 'cheap', 'guaranteed'] })).toEqual({ tone: 'playful', humor: false, preferredTerms: [], avoid: ['cheap', 'guaranteed'] });
  });
});
