import type { SourceRecord, SourceStore } from '../discovery/f1/board';
import { normalizeText } from '../discovery/input';
import type { EvidenceStatus } from '../discovery/schemas';
import type { F1Context } from '../audit/context';
import { STRATEGY_INFO, strategyRoleByName, type StrategyAgentKind, type StrategyBoard, type StrategyFinding } from './board';
import { CHANNELS, type ChannelId } from './channels';
import { STALE_AFTER_DAYS, ageDays, type F2Context, type StrategyFacts, type StrategyInput } from './context';
import { STRATEGY_REPORT_VERSION, type CampaignStrategyReport, type F4CreativeBrief, type LlmStrategyFinding, type StrategyDraft, type StrategyStatement } from './schemas';

/**
 * The F3 evidence policy, enforced IN CODE on everything the strategy agents produce. Same classes as F1/F2:
 *  - verified: an OBSERVATION of a measurable property of a LIVE source retrieved in this run (a competitor page's
 *    title, a public-holiday date from the calendar API) with a verbatim excerpt. Never for search snippets,
 *    user text, fixtures, model knowledge, or claims a page makes about itself.
 *  - claimed: said by a source or the user, with a verbatim excerpt or a traceable F1/F2 finding (search results are leads).
 *  - inferred: a judgment or hypothesis. Audience segments, channel fit and seasonal patterns are inferred unless a source proves them.
 * Additionally: no invented money/percentage/ROI figures, competitors are "confirmed" only if their page was retrieved,
 * holiday dates are "public_holiday_api" only if the calendar was really queried, and nothing from an old audit is
 * carried forward as freshly verified.
 */
export interface StrategyPolicyIssue {
  type:
    | 'reference_normalized'
    | 'unknown_source'
    | 'unknown_reference'
    | 'excerpt_not_found'
    | 'verified_downgraded'
    | 'claim_downgraded'
    | 'statement_capped'
    | 'competitor_unconfirmed'
    | 'date_basis_downgraded'
    | 'unsupported_figure'
    | 'detail_mismatch'
    | 'stale_reference'
    | 'caveat_added'
    | 'channel_not_evaluated'
    | 'channel_capped'
    | 'contradiction_added';
  agent: string;
  detail: string;
}

const RANK: Record<EvidenceStatus, number> = { unknown: 0, inferred: 1, claimed: 2, verified: 3, disputed: -1 };
const BY_RANK: EvidenceStatus[] = ['unknown', 'inferred', 'claimed', 'verified'];
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);
const LIVE_ORIGINS = new Set(['public_page', 'live_api']);
const isLive = (s: SourceRecord) => s.live && !s.fixture && !!s.origin && LIVE_ORIGINS.has(s.origin) && s.status === 'retrieved';

export interface StrategyPolicyContext {
  store: SourceStore;
  f1: F1Context;
  f2: F2Context;
  now: Date;
  issues: StrategyPolicyIssue[];
}

// ---- invented figures ---------------------------------------------------------------------------------------------------------

const FIGURE_RE = /(?:[$€£]\s?\d[\d.,]*\s?(?:k|m|million|thousand)?|\b\d[\d.,]*\s?(?:%|percent|per cent|posto|odsto)|\b\d[\d.,]*\s?(?:k|m)?\s?(?:USD|EUR|RSD|dollars?|euros?|dinara?)\b|\b(?:CPC|CPM|CPA|CAC|ROAS|ROI|CTR|CVR)\b[^.;\n]{0,30}?\d[\d.,]*\s?%?)/gi;
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** Replaces money/percentage/ROI figures that appear nowhere in the allowed material. Returns the removed figures. */
export function scrubFigures(textIn: string, allowedCorpus: string): { text: string; removed: string[] } {
  const corpus = squash(allowedCorpus);
  const removed: string[] = [];
  const text = textIn.replace(FIGURE_RE, (m) => {
    if (corpus.includes(squash(m))) return m;
    removed.push(m);
    return '[figure removed: not in any source]';
  });
  return { text, removed };
}

/** Everything a figure may legitimately come from: the user's brief, F1 and F2 reports and the cited source text. */
export function allowedCorpus(ctx: StrategyPolicyContext, extra = ''): string {
  return `${JSON.stringify(ctx.f1.report)} ${JSON.stringify(ctx.f2.report)} ${extra}`;
}

// ---- findings ------------------------------------------------------------------------------------------------------------------

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

export function validateStrategyFinding(llm: LlmStrategyFinding, agent: string, role: StrategyAgentKind, ctx: StrategyPolicyContext): Omit<StrategyFinding, 'id' | 'crosscheck' | 'at'> {
  const { store, f1, f2, issues } = ctx;
  let { classification, sourceType, sourceId, locator, excerpt } = llm;
  let adjustment: string | null = null;
  const adjust = (type: StrategyPolicyIssue['type'], why: string) => {
    adjustment = adjustment ? `${adjustment} ${why}` : why;
    issues.push({ type, agent, detail: `"${clip(llm.title)}": ${why}` });
  };

  // F1/F2 finding ids cited as sourceId are references, not sources (models do this).
  const f1Ids = new Set(f1.findings.map((f) => f.id));
  const f2Ids = new Set(f2.findings.map((f) => f.id));
  if (sourceId && !store.get(sourceId) && (f1Ids.has(sourceId) || f2Ids.has(sourceId))) {
    issues.push({ type: 'reference_normalized', agent, detail: `"${clip(llm.title)}": ${sourceId} was cited as a source and is now an ${f1Ids.has(sourceId) ? 'F1' : 'F2'} reference.` });
    sourceType = f1Ids.has(sourceId) ? 'f1_finding' : 'f2_finding';
    locator = sourceId;
    sourceId = null;
  }

  const src = sourceId ? store.get(sourceId) : undefined;
  if (sourceId && !src) {
    adjust('unknown_source', `cited source ${sourceId} does not exist.`);
    sourceId = null;
  }
  if (src) sourceType = src.kind === 'holiday_calendar' ? 'holiday_api' : src.kind === 'search_result' ? 'search_result' : src.kind === 'website' ? 'website' : src.origin === 'user_provided' ? 'user_provided' : src.kind === 'f1_report' ? 'f1_finding' : src.kind === 'f2_audit' ? 'f2_finding' : sourceType;

  const f1Ref = sourceType === 'f1_finding' ? f1.findings.find((f) => f.id === locator) : undefined;
  const f2Ref = sourceType === 'f2_finding' ? f2.findings.find((f) => f.id === locator) : undefined;
  if ((sourceType === 'f1_finding' && !f1Ref) || (sourceType === 'f2_finding' && !f2Ref)) {
    adjust('unknown_reference', `${sourceType === 'f1_finding' ? 'F1' : 'F2'} finding ${locator ?? '(none)'} does not exist.`);
    sourceType = 'ai_inference';
    locator = null;
  }
  const ref = f1Ref ?? f2Ref;

  if (excerpt) {
    const found = src ? store.contains(src.id, excerpt) : ref ? normalizeText(`${ref.statement} ${ref.excerpt ?? ''}`).includes(normalizeText(excerpt)) && normalizeText(excerpt).length >= 6 : false;
    if (!found) {
      adjust('excerpt_not_found', 'the quoted excerpt was not found verbatim in the cited source and was removed.');
      excerpt = null;
    }
  }

  const userProvided = sourceType === 'user_provided' || src?.origin === 'user_provided';
  const cap = (max: EvidenceStatus, why: string, type: StrategyPolicyIssue['type']) => {
    if (RANK[classification] > RANK[max]) {
      adjust(type, why);
      classification = max;
    }
  };

  // 1. what kind of statement it is
  if (llm.kind === 'assessment' || llm.kind === 'hypothesis') cap('inferred', `a ${llm.kind} is a judgment, not an observation: at most "inferred".`, 'verified_downgraded');
  if (llm.kind === 'claim_on_source') cap('claimed', 'a claim made by a source is at most "claimed".', 'verified_downgraded');
  if (llm.kind === 'gap') cap('unknown', 'a gap is missing data.', 'verified_downgraded');
  // Audience, channel fit and seasonal demand are interpretations unless a source proves them.
  if (role.key === 'audience' || role.key === 'scout') cap('inferred', 'audience and channel fit are hypotheses, not measurements.', 'verified_downgraded');
  if (role.key === 'seasonal' && sourceType !== 'holiday_api') cap('inferred', 'seasonal patterns without a calendar source are hypotheses.', 'verified_downgraded');

  // 2. verified needs a live, tool-observed source with a verbatim excerpt (and never a search snippet)
  if (classification === 'verified') {
    const ok = !!src && isLive(src) && !!excerpt && llm.kind === 'observation' && src.kind !== 'search_result' && (sourceType === 'website' || sourceType === 'holiday_api');
    if (!ok) {
      const why = src?.fixture ? 'the source is a test fixture, never real evidence.' : src?.kind === 'search_result' ? 'a search snippet is a lead, not verification.' : userProvided ? 'user-provided data cannot be verified.' : 'it needs a live source observed in this run and a verbatim excerpt.';
      classification = userProvided ? 'claimed' : 'inferred';
      adjust('verified_downgraded', why);
    }
  }
  if (classification === 'claimed') {
    const traceable = (!!src && !!excerpt) || (!!ref && RANK[ref.classification as EvidenceStatus] >= RANK.claimed) || (userProvided && !!src);
    if (!traceable) {
      classification = 'inferred';
      adjust('claim_downgraded', 'a "claimed" statement must cite a source with a verbatim excerpt or an F1/F2 finding.');
    }
  }
  if (src?.kind === 'search_result') cap('claimed', 'a search result is only a lead.', 'verified_downgraded');

  // 3. never stronger than the earlier-phase finding it comes from; nothing stale is carried forward as verified
  if (ref) {
    cap(BY_RANK[Math.max(0, RANK[ref.classification as EvidenceStatus])] ?? 'inferred', `cannot be stronger than ${sourceType === 'f1_finding' ? 'F1' : 'F2'} finding ${ref.id} (${ref.classification}).`, 'statement_capped');
    const age = ageDays(ctx.now, sourceType === 'f1_finding' ? f1.generatedAt : f2.generatedAt);
    if (age !== null && age > STALE_AFTER_DAYS && classification === 'verified') {
      classification = 'claimed';
      adjust('stale_reference', `the ${sourceType === 'f1_finding' ? 'F1 report' : 'F2 audit'} is ${age} days old: its observations are not re-verified.`);
    }
  }

  // 4. typed details belong to exactly one role
  let segment = llm.segment;
  let competitor = llm.competitor;
  let channelEval = llm.channel;
  let opportunity = llm.opportunity;
  const want = role.key === 'audience' ? 'segment' : role.key === 'competitor' ? 'competitor' : role.key === 'scout' ? 'channel' : role.key === 'seasonal' ? 'opportunity' : null;
  if ((segment && want !== 'segment') || (competitor && want !== 'competitor') || (channelEval && want !== 'channel') || (opportunity && want !== 'opportunity')) adjust('detail_mismatch', 'details that do not belong to this participant were removed.');
  if (want !== 'segment') segment = null;
  if (want !== 'competitor') competitor = null;
  if (want !== 'channel') channelEval = null;
  if (want !== 'opportunity') opportunity = null;
  if (role.key === 'scout' && channelEval && channelEval.channel !== role.channel) {
    adjust('detail_mismatch', `the evaluation was for ${channelEval.channel}, but this scout covers ${role.channel}.`);
    channelEval = { ...channelEval, channel: role.channel };
  }

  // 5. competitors exist only if a page of theirs was actually retrieved in this run
  if (competitor) {
    const host = hostOf(competitor.url);
    const retrieved = !!host && store.all().some((s) => s.kind === 'website' && s.status === 'retrieved' && hostOf(s.url) === host);
    if (competitor.url && !host) competitor = { ...competitor, url: null };
    if (competitor.existence === 'confirmed' && !retrieved) {
      adjust('competitor_unconfirmed', 'existence was marked confirmed, but no page of this competitor was retrieved in this run.');
      competitor = { ...competitor, existence: 'unconfirmed' };
    }
    if (competitor.existence === 'unconfirmed') {
      if (!src || src.kind === 'search_result') cap('claimed', 'a competitor known only from a search lead or from the model is unconfirmed.', 'competitor_unconfirmed');
      if (!src) cap('inferred', 'a competitor without any source is only a hypothesis.', 'competitor_unconfirmed');
      competitor = { ...competitor, relation: competitor.relation === 'unverified' || !src ? 'unverified' : competitor.relation };
    }
  }

  // 6. dates and their basis
  if (opportunity) {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (opportunity.startDate && !iso.test(opportunity.startDate)) opportunity = { ...opportunity, startDate: null };
    if (opportunity.endDate && !iso.test(opportunity.endDate)) opportunity = { ...opportunity, endDate: null };
    if (opportunity.dateBasis === 'public_holiday_api' && !(src?.kind === 'holiday_calendar' && src.status === 'retrieved')) {
      adjust('date_basis_downgraded', 'the date was attributed to the public-holiday calendar, but no calendar response backs it.');
      opportunity = { ...opportunity, dateBasis: 'recurring_pattern' };
      cap('inferred', 'a recurring pattern without a calendar source is inferred.', 'date_basis_downgraded');
    }
    if (opportunity.dateBasis === 'user_provided' && !userProvided) {
      adjust('date_basis_downgraded', 'the event was attributed to the user, but no user-provided source backs it.');
      opportunity = { ...opportunity, dateBasis: 'speculative' };
      cap('inferred', 'a speculative window is inferred.', 'date_basis_downgraded');
    }
    if (opportunity.dateBasis === 'speculative' || opportunity.dateBasis === 'recurring_pattern') cap('inferred', 'timing without a calendar or user source is inferred.', 'date_basis_downgraded');
  }

  // 7. invented figures
  const corpus = allowedCorpus(ctx, src ? store.text(src.id) : '');
  const clean = (s: string | null): string | null => {
    if (!s) return s;
    const r = scrubFigures(s, corpus);
    if (r.removed.length) {
      adjust('unsupported_figure', `removed figure(s) that appear in no source: ${r.removed.join(', ')}.`);
      cap('inferred', 'it contained an unsupported figure.', 'unsupported_figure');
    }
    return r.text;
  };
  const statement = clean(llm.statement) ?? llm.statement;
  const reasoning = clean(llm.reasoning) ?? llm.reasoning;
  const recommendation = clean(llm.recommendation);
  if (channelEval) channelEval = { ...channelEval, audienceFit: clean(channelEval.audienceFit) ?? channelEval.audienceFit, constraints: channelEval.constraints.map((c) => clean(c) ?? c), measurement: channelEval.measurement.map((c) => clean(c) ?? c), risks: channelEval.risks.map((c) => clean(c) ?? c) };

  const area = role.key === 'scout' ? 'channel' : STRATEGY_INFO[role.key].area;
  return {
    agent,
    area,
    channel: role.key === 'scout' ? role.channel : null,
    kind: llm.kind,
    title: llm.title,
    statement,
    classification,
    importance: llm.importance,
    sourceType,
    sourceId,
    locator,
    excerpt,
    reasoning,
    confidence: llm.confidence === null ? null : Math.min(1, Math.max(0, llm.confidence)),
    recommendation,
    segment,
    competitor,
    channelEval,
    opportunity,
    adjustment,
  };
}

// ---- report finalization ---------------------------------------------------------------------------------------------------------

const strongest = (ids: string[], byId: Map<string, StrategyFinding>): EvidenceStatus | null => {
  const found = ids.map((i) => byId.get(i)).filter((f): f is StrategyFinding => !!f);
  if (!found.length) return null;
  return BY_RANK[Math.max(...found.map((f) => Math.max(0, RANK[f.classification])))];
};

export interface FinalizeArgs {
  f1: F1Context;
  f2: F2Context;
  input: StrategyInput;
  facts: StrategyFacts;
  now: Date;
  partial: boolean;
  fixtureSources: boolean;
  runId: string | null;
  searchProvider: string;
  searchConfigured: boolean;
}

/** Deep-maps every string of a JSON-like value. */
function mapStrings<T>(v: T, fn: (s: string) => string): T {
  if (typeof v === 'string') return fn(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn)) as unknown as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)])) as T;
  return v;
}

export function finalizeStrategy(draftIn: StrategyDraft, board: StrategyBoard, ctx: StrategyPolicyContext, args: FinalizeArgs): { report: CampaignStrategyReport; issues: StrategyPolicyIssue[] } {
  const { f1, f2 } = args;
  const issues: StrategyPolicyIssue[] = [];
  const who = STRATEGY_INFO.strategist.name;
  const byId = new Map(board.findings.map((f) => [f.id, f]));
  const known = (ids: string[]) => [...new Set(ids)].filter((i) => byId.has(i));

  // 0. no invented figures anywhere in what the strategist wrote
  const corpus = allowedCorpus(ctx, board.findings.map((f) => `${f.statement} ${f.excerpt ?? ''} ${f.reasoning}`).join(' '));
  const draft = mapStrings(draftIn, (s) => {
    const r = scrubFigures(s, corpus);
    if (r.removed.length) issues.push({ type: 'unsupported_figure', agent: who, detail: `removed figure(s) that appear in no source: ${r.removed.join(', ')}.` });
    return r.text;
  });

  // 1. crowded positioning themes (from competitor findings) must not be sold as unique
  const crowded = board.findings.filter((f) => f.competitor?.crowdedTheme).map((f) => ({ id: f.id, theme: f.competitor!.crowdedTheme! }));
  const themeHit = (text: string, ids: string[]) => crowded.find((c) => ids.includes(c.id) || normalizeText(text).includes(normalizeText(c.theme)));
  const fix = (s: StrategyStatement, forPositioning = false): StrategyStatement => {
    const ids = known(s.findingIds);
    const top = strongest(ids, byId);
    let status = s.status;
    const limit = top ?? 'inferred';
    if (RANK[status] > RANK[limit]) {
      issues.push({ type: 'statement_capped', agent: who, detail: `"${clip(s.text)}": ${status} -> ${limit} (${top ? 'strongest cited finding' : 'no supporting finding'}).` });
      status = limit;
    }
    if (ids.length && ids.every((i) => byId.get(i)!.classification === 'disputed')) status = 'disputed';
    let caveat = s.caveat;
    const hit = forPositioning ? themeHit(s.text, ids) : undefined;
    if (hit) {
      if (RANK[status] > RANK.inferred) status = 'inferred';
      if (!caveat || !normalizeText(caveat).includes(normalizeText(hit.theme).slice(0, 12))) {
        caveat = `Competitors also position on "${hit.theme}" (${hit.id}); this is not a unique advantage unless the offer is clearly different.`;
        issues.push({ type: 'caveat_added', agent: who, detail: `"${clip(s.text)}" overlaps the crowded theme "${hit.theme}".` });
      }
    }
    return { ...s, findingIds: ids, status, caveat };
  };

  // 2. recommended channels must have been evaluated by a scout, and cannot outrank that scout's own verdict
  const evals = new Map(board.findings.filter((f) => f.channel && f.channelEval).map((f) => [f.channel as ChannelId, f]));
  const channels: StrategyDraft['channels'] = [];
  for (const c of draft.channels) {
    const ev = evals.get(c.channel);
    if (!ev) {
      issues.push({ type: 'channel_not_evaluated', agent: who, detail: `${c.channel} was recommended but no Channel Scout evaluated it, so it was removed.` });
      continue;
    }
    if (ev.channelEval!.fit === 'unsuitable' || ev.channelEval!.role === 'skip') {
      issues.push({ type: 'channel_capped', agent: who, detail: `${c.channel} was recommended, but its scout rated it unsuitable/skip, so it was removed.` });
      continue;
    }
    let role = c.role;
    if ((ev.channelEval!.fit === 'weak' || ev.channelEval!.role === 'test') && role !== 'test') {
      issues.push({ type: 'channel_capped', agent: who, detail: `${c.channel}: ${role} -> test (its scout rated the fit ${ev.channelEval!.fit}).` });
      role = 'test';
    }
    channels.push({ ...c, role, findingIds: known([...c.findingIds, ev.id]) });
  }

  // 3. every disputed finding appears in the open disagreements
  const disagreements = draft.disagreements.map((d) => ({ ...d, findingIds: known(d.findingIds) }));
  const covered = new Set(disagreements.flatMap((d) => d.findingIds));
  for (const f of board.findings.filter((x) => x.classification === 'disputed' && !covered.has(x.id))) {
    const rec = board.crosschecks.find((c) => c.claimId === f.id && c.verdict === 'disagree');
    disagreements.push({ topic: f.title, positions: [`${f.agent}: ${f.statement}`.slice(0, 300), ...(rec ? [`${rec.reviewer}: ${rec.rationale ?? 'disagrees'}`.slice(0, 300)] : [])], resolution: 'Unresolved: carry as an open question and validate before relying on it.', resolved: false, findingIds: [f.id] });
    issues.push({ type: 'contradiction_added', agent: who, detail: `Disputed finding ${f.id} was missing from the disagreements and was added.` });
  }

  const pm = f1.report.productManifest;
  const ageF2 = ageDays(args.now, f2.generatedAt);
  const ageF1 = ageDays(args.now, f1.generatedAt);
  const stale = (ageF2 ?? 0) > STALE_AFTER_DAYS || (ageF1 ?? 0) > STALE_AFTER_DAYS;
  const ref = (f: StrategyFinding) => ({ findingId: f.id, agent: f.agent, status: f.classification, confidence: f.confidence, sourceId: f.sourceId, locator: f.locator, crosscheck: f.crosscheck.status + (f.crosscheck.reviewers.length ? ` (${f.crosscheck.reviewers.join(', ')})` : '') });
  const searchUsed = !!args.facts.competitors?.searchUsed;

  const palette = pm.brand?.palette ?? [];
  const f2Claims = f2.findings.filter((f) => f.kind === 'claim_on_source').map((f) => ({ claim: f.statement.slice(0, 240), reason: `Flagged by the Marketing Audit (${f.id}): it needs evidence before it is used in advertising.` }));
  const claimsToAvoid = [...draft.creativeBrief.claimsToAvoid, ...f2Claims].filter((c, i, a) => a.findIndex((x) => normalizeText(x.claim) === normalizeText(c.claim)) === i).slice(0, 12);
  const brief: F4CreativeBrief = {
    ...draft.creativeBrief,
    claimsToAvoid,
    suggestedConceptCount: Math.min(5, Math.max(1, draft.creativeBrief.suggestedConceptCount || 3)),
    channels: draft.creativeBrief.channels.filter((c) => channels.some((x) => x.channel === c.channel)),
    productIdentity: { name: pm.name, category: pm.category, businessType: pm.businessType, summary: f1.report.identity.summary, valueProposition: pm.valueProposition },
    language: draft.language,
    visualPalette: palette,
    visualBasis: palette.length ? 'f1_measured_palette' : 'none',
    provenance: { f1ReportId: f1.reportId, f2AuditId: f2.auditId, strategyRunId: args.runId },
  };

  const limitations = buildLimitations(board, args, stale, ageF1, ageF2);
  const { creativeBrief: _omit, ...rest } = draft;
  void _omit;
  const report: CampaignStrategyReport = {
    ...rest,
    schemaVersion: STRATEGY_REPORT_VERSION,
    partial: args.partial,
    valueProposition: fix(draft.valueProposition, true),
    positioning: { ...draft.positioning, statement: fix(draft.positioning.statement, true), differentiators: draft.positioning.differentiators.map((d) => fix(d, true)) },
    channels,
    disagreements,
    priorityAudiences: draft.priorityAudiences.map((a) => ({ ...a, findingIds: known(a.findingIds) })),
    campaignGoals: draft.campaignGoals.map((g) => ({ ...g, findingIds: known(g.findingIds) })),
    mainMessages: draft.mainMessages.map((m) => ({ ...m, findingIds: known(m.findingIds) })),
    timing: draft.timing.map((t) => ({ ...t, findingIds: known(t.findingIds) })),
    contentPillars: draft.contentPillars.map((p) => ({ ...p, findingIds: known(p.findingIds) })),
    risks: draft.risks.map((r) => ({ ...r, findingIds: known(r.findingIds) })),
    strategicPriorities: draft.strategicPriorities.map((p) => ({ ...p, findingIds: known(p.findingIds) })),
    additionalLimitations: draft.additionalLimitations,
    productContext: {
      f1ReportId: f1.reportId,
      f1SchemaVersion: f1.schemaVersion,
      f1GeneratedAt: f1.generatedAt,
      name: pm.name,
      category: pm.category,
      businessType: String(pm.businessType),
      summary: f1.report.identity.summary,
      offering: pm.offering.summary,
      valueProposition: pm.valueProposition,
      targetCustomers: pm.targetCustomers,
      geography: pm.geography,
      f1Confidence: pm.overallConfidence,
    },
    existingMarketing: {
      f2AuditId: f2.auditId,
      f2SchemaVersion: f2.schemaVersion,
      f2GeneratedAt: f2.generatedAt,
      ageDays: ageF2,
      stale: (ageF2 ?? 0) > STALE_AFTER_DAYS,
      partial: f2.partial,
      mainProblems: f2.report.mainProblems.slice(0, 8).map((p) => ({ title: p.title, severity: p.severity, area: p.area, status: p.status })),
      notes: [
        ageF2 === null ? 'The age of the audit is unknown.' : `The audit is ${ageF2} day(s) old${(ageF2 ?? 0) > STALE_AFTER_DAYS ? `: older than ${STALE_AFTER_DAYS} days, so it may not reflect the current website and profiles` : ''}.`,
        ...(f2.partial ? ['The audit was partial: some areas were not audited.'] : []),
      ],
    },
    audienceResearch: board.findings.filter((f) => f.segment).map((f) => ({ segment: f.segment!, status: f.classification, statement: f.statement, reasoning: f.reasoning, ref: ref(f) })),
    competitorLandscape: {
      searchProvider: args.searchProvider,
      searchUsed,
      userSuppliedUrls: args.facts.competitors?.userSupplied ?? 0,
      profiles: board.findings.filter((f) => f.competitor).map((f) => ({ competitor: f.competitor!, status: f.classification, statement: f.statement, ref: ref(f) })),
      gaps: args.facts.competitors?.gaps ?? ['Competitor research was not performed.'],
    },
    channelEvaluation: {
      evaluated: board.findings.filter((f) => f.channelEval).map((f) => ({ scout: f.agent, evaluation: f.channelEval!, status: f.classification, statement: f.statement, reasoning: f.reasoning, ref: ref(f) })),
      notSelected: board.scoutDecisions.filter((d) => !d.selected).map((d) => ({ channel: d.channel, reason: d.reason, score: d.score })),
      selection: board.scoutDecisions.map((d) => ({ channel: d.channel, selected: d.selected, score: d.score, ruleHits: d.ruleHits, reason: d.reason })),
    },
    seasonalOpportunities: {
      holidayCalendar: args.facts.holidays ?? { used: false, country: null, note: 'The holiday calendar was not used.', holidays: [] },
      opportunities: board.findings.filter((f) => f.opportunity).map((f) => ({ opportunity: f.opportunity!, status: f.classification, statement: f.statement, ref: ref(f) })),
    },
    evidence: {
      findingCount: board.findings.length,
      byStatus: board.findings.reduce<Record<string, number>>((a, f) => ((a[f.classification] = (a[f.classification] ?? 0) + 1), a), {}),
      crosschecks: board.crosschecks.map((c) => ({ claimId: c.claimId, producer: c.producer, reviewer: c.reviewer, verdict: c.verdict, rationale: c.rationale, status: c.status })),
      sources: board.sources.map((s) => ({ id: s.id, kind: s.kind, label: s.label, status: s.status, origin: s.origin ?? (s.fixture ? 'fixture' : s.live ? 'public_page' : 'user_provided'), live: s.live, fixture: s.fixture, error: s.error })),
      findings: board.findings.map((f) => ({ id: f.id, agent: f.agent, kind: f.kind, title: f.title, statement: f.statement, classification: f.classification, sourceId: f.sourceId, locator: f.locator, excerpt: f.excerpt, crosscheck: f.crosscheck.status + (f.crosscheck.reviewers.length ? ` (${f.crosscheck.reviewers.join(', ')})` : ''), at: f.at })),
    },
    limitations,
    metrics: [],
    creativeBrief: brief,
  };
  return { report, issues };
}

function buildLimitations(board: StrategyBoard, args: FinalizeArgs, stale: boolean, ageF1: number | null, ageF2: number | null): string[] {
  const out: string[] = [];
  for (const s of board.plan?.skipped ?? []) out.push(`${s.agent} did not run: ${s.reason}.`);
  for (const p of board.participantStatuses.filter((x) => x.state === 'failed' || x.state === 'timed_out')) out.push(`${p.agent} ${p.state === 'timed_out' ? 'timed out' : 'failed'}${p.error ? `: ${p.error.message}` : ''}. Its area is incomplete.`);
  for (const s of board.sources.filter((x) => x.status !== 'retrieved')) out.push(`${s.label}: ${s.status}${s.error ? ` (${s.error})` : ''}.`);
  for (const g of args.facts.competitors?.gaps ?? []) out.push(g);
  if (args.facts.holidays && !args.facts.holidays.used) out.push(args.facts.holidays.note);
  if (stale) out.push(`The underlying ${(ageF1 ?? 0) > STALE_AFTER_DAYS ? 'F1 report' : 'F2 audit'} is older than ${STALE_AFTER_DAYS} days (F1 ${ageF1 ?? '?'} d, F2 ${ageF2 ?? '?'} d): the website, profiles and market may have changed.`);
  if (args.f1.partial) out.push('The F1 Product Discovery report was partial.');
  if (args.f2.partial) out.push('The F2 Marketing Audit was partial.');
  out.push('Audience segments, channel fit and seasonal demand are hypotheses until validated with real data; no market size, reach, cost-per-click, conversion rate or ROI is claimed.');
  if (args.fixtureSources) out.push('FIXTURE MODE: external sources in this run are test data, not real evidence.');
  return [...new Set(out)];
}

export { CHANNELS, strategyRoleByName };
