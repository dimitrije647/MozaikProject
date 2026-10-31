import type { SafeProviderError } from '../../../ai/errors';
import type { AuditKey } from '../../../audit/board';
import type { SocialRow } from '../../../audit/context';
import { auditorMessage, srcBlock } from '../../../audit/prompts';
import type { AuditAgentOutput, LlmAuditFinding } from '../../../audit/schemas';
import type { SourceRecord } from '../../../discovery/f1/board';
import { describePageSpeed } from '../../../tools/pagespeed';
import { checkPresence, describePresence } from '../../../tools/presence';
import { auditSite, describePage, type PageSignals, type SiteAudit } from '../../../tools/seo';
import { SOCIAL_PLATFORMS, describeYouTube, parseSocialUrl } from '../../../tools/social';
import type { PhaseAgent } from '../f1/agent';
import type { F2Env } from './env';

/**
 * The deterministic "gather" step of each F2 auditor. Tools do the retrieval; the model only ever sees the
 * compact, delimited result. Every retrieval, success or failure, is published as `source.retrieved`.
 */
export type F2Prep =
  | { kind: 'ready'; message: string; images?: { mediaType: string; base64: string }[] }
  | { kind: 'direct'; output: AuditAgentOutput; reason: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; error: SafeProviderError };

const fail = (message: string): F2Prep => ({ kind: 'fail', error: { code: 'source_unavailable', message } });

type NewSource = Pick<SourceRecord, 'kind' | 'label' | 'status'> & Partial<Omit<SourceRecord, 'id' | 'retrievedAt' | 'excerpt' | 'chars'>>;

function addSource(env: F2Env, agent: PhaseAgent, rec: NewSource, text?: string): SourceRecord {
  const r = env.store.add({ live: false, fixture: false, url: null, httpStatus: null, bytes: null, error: null, producer: agent.name, ...rec }, text);
  env.ctx.emit('source.retrieved', { agent: agent.name, source: r }, agent.participant);
  return r;
}

const webOrigin = (env: F2Env) => (env.settings.fixtureSources ? 'fixture' : 'public_page') as 'fixture' | 'public_page';
const apiOrigin = (env: F2Env) => (env.settings.fixtureSources ? 'fixture' : 'live_api') as 'fixture' | 'live_api';

// ---- shared website collection (owned by the SEO Auditor; memoized per run) ---------------------------------------------------

/** Crawls the site once. The first caller starts it; everyone awaits the same promise. Never throws. */
export function ensureSite(env: F2Env): Promise<SiteAudit | null> {
  env.siteP ??= collectSite(env).catch(() => null);
  return env.siteP;
}

async function collectSite(env: F2Env): Promise<SiteAudit | null> {
  const url = env.input.websiteUrl;
  const owner = env.agents.get('seo');
  if (!url || !owner) return null;
  const fixture = env.settings.fixtureSources;
  const origin = webOrigin(env);
  const signal = AbortSignal.any([env.ctx.signal, AbortSignal.timeout(env.settings.collectTimeoutMs)]);
  const audit = await auditSite(env.tools.web, url, { maxPages: env.settings.maxPages, maxLinkChecks: env.settings.maxLinkChecks }, signal);
  env.facts.site = audit;

  if (!audit.home.ok) {
    env.facts.siteError = audit.home.message;
    addSource(env, owner, { kind: 'website', label: url, url, status: 'failed', live: true, fixture, origin, httpStatus: audit.home.status, error: audit.home.message });
    return audit;
  }
  for (const p of audit.pages) {
    const rec = addSource(
      env,
      owner,
      {
        kind: 'website',
        label: p.title ?? p.finalUrl,
        url: p.finalUrl,
        status: 'retrieved',
        live: true,
        fixture,
        origin,
        httpStatus: p.status,
        injectionSuspected: p.injectionSuspected,
        notes: p.injectionSuspected ? ['Contains text that looks like instructions to an AI. Treated as data only.'] : [],
      },
      describePage(p, 'full'),
    );
    env.pageSources.set(p.finalUrl, rec.id);
  }
  for (const f of audit.failedPages) {
    addSource(env, owner, { kind: 'website', label: f.url, url: f.url, status: 'failed', live: true, fixture, origin, httpStatus: f.status, error: f.message });
  }

  const common = { live: true, fixture, origin, httpStatus: 200 } as const;
  const robotsText =
    audit.robots.status === 'found'
      ? `robots_txt: found\nblocks_all_crawlers: ${audit.robots.blocksAll}\nsitemaps_listed: ${audit.robots.sitemaps.join(', ') || '(none)'}\n--- content ---\n${audit.robots.text.slice(0, 1200)}`
      : audit.robots.status === 'missing'
        ? 'robots_txt: missing (the server answered 404 or similar). Crawlers are not restricted.'
        : audit.robots.status === 'disallowed'
          ? 'robots_txt: present and its rules disallow crawling of the site root for this crawler; its content was not read.'
          : 'robots_txt: could not be retrieved.';
  const r1 = addSource(env, owner, { kind: 'robots', label: 'robots.txt', url: audit.robots.url, status: audit.robots.status === 'unreachable' ? 'failed' : 'retrieved', ...common, error: audit.robots.status === 'unreachable' ? 'robots.txt could not be retrieved.' : null }, robotsText);
  const sm = audit.sitemap;
  const smText = sm.status === 'found' ? `sitemap: found at ${sm.url}\nurl_entries: ${sm.urlCount}\nsitemap_index: ${sm.isIndex}` : sm.status === 'missing' ? `sitemap: not found at ${sm.url} (the server answered 404 or similar)` : `sitemap: ${sm.status}`;
  const r2 = addSource(env, owner, { kind: 'sitemap', label: 'XML sitemap', url: sm.url, status: sm.status === 'unreachable' || sm.status === 'not_checked' ? 'failed' : 'retrieved', ...common, error: sm.status === 'unreachable' ? 'The sitemap could not be retrieved.' : null }, smText);
  const brokenText = `internal_links_status_checked: ${audit.linksChecked + audit.pages.length - 1}\nbroken_internal_links: ${audit.broken.length}\n${audit.broken.map((b) => `- ${b.url} -> ${b.status ?? b.reason} (linked from ${b.from})`).join('\n')}${audit.notes.length ? `\nnotes: ${audit.notes.join(' ')}` : ''}`;
  const r3 = addSource(env, owner, { kind: 'website', label: 'Internal link check', url, status: 'retrieved', ...common }, brokenText);
  env.siteSourceIds.push(r1.id, r2.id, r3.id);
  return audit;
}

export function ensurePageSpeed(env: F2Env): Promise<void> {
  env.psP ??= collectPageSpeed(env).catch(() => undefined);
  return env.psP;
}

async function collectPageSpeed(env: F2Env) {
  const url = env.input.websiteUrl;
  const owner = env.agents.get('seo');
  if (!url || !owner) return;
  const fixture = env.settings.fixtureSources;
  const signal = AbortSignal.any([env.ctx.signal, AbortSignal.timeout(env.settings.collectTimeoutMs)]);
  const res = await env.tools.pagespeed.run(url, 'mobile', signal);
  env.facts.pagespeed = res;
  if (!res.ok) {
    const notCalled = res.code === 'not_configured';
    addSource(env, owner, { kind: 'pagespeed', label: 'Google PageSpeed Insights', status: notCalled ? 'skipped' : 'failed', live: !notCalled, fixture, origin: apiOrigin(env), error: res.message });
    return;
  }
  const rec = addSource(env, owner, { kind: 'pagespeed', label: 'Google PageSpeed Insights (mobile)', url, status: 'retrieved', live: true, fixture, origin: apiOrigin(env), httpStatus: 200 }, describePageSpeed(res));
  env.siteSourceIds.push(rec.id);
}

const pagesOf = (env: F2Env, limit: number): PageSignals[] => (env.facts.site?.pages ?? []).slice(0, limit);
const block = (env: F2Env, p: PageSignals, mode: Parameters<typeof describePage>[1]) => {
  const id = env.pageSources.get(p.finalUrl);
  const rec = id ? env.store.get(id) : undefined;
  return rec ? srcBlock(rec, describePage(p, mode)) : null;
};

// ---- A8 SEO Auditor ----------------------------------------------------------------------------------------------

export async function prepareSeo(env: F2Env, agent: PhaseAgent): Promise<F2Prep> {
  const [site] = await Promise.all([ensureSite(env), ensurePageSpeed(env)]);
  if (!site || !site.home.ok) return fail(`The website could not be read, so no SEO audit is possible. ${site && !site.home.ok ? site.home.message : ''}`.trim());
  const blocks: string[] = [];
  for (const p of pagesOf(env, 4)) {
    const b = block(env, p, 'seo');
    if (b) blocks.push(b);
  }
  for (const id of env.siteSourceIds) {
    const rec = env.store.get(id);
    if (rec && rec.status === 'retrieved') blocks.push(srcBlock(rec, env.store.text(id)));
  }
  const ps = env.facts.pagespeed;
  const extra = [
    `Pages analyzed in detail: ${site.pages.length}. Internal links status-checked: ${site.linksChecked}.`,
    ps && !ps.ok ? `PageSpeed Insights is UNAVAILABLE (${ps.message}). Do not report or estimate any performance metrics.` : '',
    site.failedPages.length ? `Pages that could not be retrieved (do not guess their content): ${site.failedPages.map((f) => `${f.url} (${f.message})`).join('; ')}` : '',
    'Describe indexability SIGNALS only; indexing in Google is unknown.',
  ]
    .filter(Boolean)
    .join('\n');
  return { kind: 'ready', message: auditorMessage('SEO Auditor', { f1: env.f1, language: env.input.language }, { blocks, extra, topics: 'messaging' }) };
}

// ---- A9 Social Media Auditor -------------------------------------------------------------------------------------

const EXPORT_RE = /export|analytics|insights|audience|followers|statistics|statistika/i;
const NO_API: Record<string, string> = {
  instagram: 'No live adapter: Instagram data needs an authorized Meta Graph API app and an account token, which is not configured. The public profile page is not scraped.',
  facebook: 'No live adapter: Facebook Page data needs an authorized Meta Graph API app and a page token, which is not configured. The public page is not scraped.',
  linkedin: 'No live adapter: LinkedIn page analytics need an authorized LinkedIn app, which is not configured. The public page is not scraped.',
  x: 'No live adapter: the X API requires paid, authorized access, which is not configured. The public profile is not scraped.',
  tiktok: 'No live adapter: TikTok data needs an authorized developer app, which is not configured. The public profile is not scraped.',
  pinterest: 'No live adapter: Pinterest data needs an authorized API app, which is not configured. The public profile is not scraped.',
  reddit: 'No live adapter: Reddit data needs authorized API access, which is not configured. The public page is not scraped.',
  youtube: 'YouTube can be read through the official Data API, but YOUTUBE_API_KEY is not configured, so no live data was requested.',
};

export async function prepareSocial(env: F2Env, agent: PhaseAgent): Promise<F2Prep> {
  const fixture = env.settings.fixtureSources;
  const signal = agent.signal;
  const rows: SocialRow[] = [];
  const blocks: string[] = [];
  let material = 0;
  const gaps: { platform: string; sourceId: string; note: string }[] = [];

  for (const p of env.input.socialProfiles) {
    const parsed = parseSocialUrl(p.platform, p.url);
    const platform = parsed.declared;
    if (!parsed.valid) {
      const rec = addSource(env, agent, { kind: 'social_profile', label: `${platform}: ${p.url}`, url: p.url, status: 'failed', origin: 'user_provided', error: parsed.issues.join(' ') });
      rows.push({ platform, url: p.url, access: 'invalid', note: parsed.issues.join(' '), metrics: [] });
      gaps.push({ platform, sourceId: rec.id, note: parsed.issues.join(' ') });
      continue;
    }
    let row: SocialRow = { platform, url: p.url, access: 'unavailable', note: NO_API[platform] ?? 'No live adapter for this platform.', metrics: [] };
    let live = false;
    if (platform === 'youtube' && env.tools.youtube.configured && parsed.youtube) {
      const res = await env.tools.youtube.channel(parsed.youtube, signal);
      if (res.ok) {
        const rec = addSource(env, agent, { kind: 'social_profile', label: `youtube: ${res.title}`, url: p.url, status: 'retrieved', live: true, fixture, origin: apiOrigin(env), httpStatus: 200 }, describeYouTube(res));
        blocks.push(srcBlock(rec, env.store.text(rec.id)));
        row = {
          platform,
          url: p.url,
          access: fixture ? 'fixture' : 'live_api',
          note: fixture ? 'FIXTURE data from a test server, not a real channel.' : 'Official YouTube Data API v3, live request.',
          metrics: [
            { label: 'Subscribers', value: res.subscribersHidden ? 'hidden by the channel owner' : String(res.subscriberCount ?? 'unavailable') },
            { label: 'Total views', value: String(res.viewCount ?? 'unavailable') },
            { label: 'Videos', value: String(res.videoCount ?? 'unavailable') },
            { label: 'Uploads in the last 90 days (of the latest 10 returned)', value: String(res.uploadsInLast90Days ?? 'unavailable') },
          ],
        };
        live = true;
        material++;
      } else {
        row.note = res.message;
        const rec = addSource(env, agent, { kind: 'social_profile', label: `youtube: ${p.url}`, url: p.url, status: 'failed', live: true, fixture, origin: apiOrigin(env), error: res.message });
        gaps.push({ platform, sourceId: rec.id, note: res.message });
      }
    } else if (platform === 'youtube' && env.tools.youtube.configured) {
      row.note = 'This YouTube URL form (custom /c/ name) cannot be resolved with the official API. Use the @handle or /channel/ URL.';
    }
    if (!live && row.access === 'unavailable') {
      const rec = addSource(env, agent, { kind: 'social_profile', label: `${platform}: ${p.url}`, url: p.url, status: 'skipped', origin: 'user_provided', error: row.note }, `platform: ${platform}\nprofile_url: ${p.url}\nhandle: ${parsed.handle ?? 'unknown'}\naccess: unavailable. ${row.note}`);
      gaps.push({ platform, sourceId: rec.id, note: row.note });
    }
    rows.push(row);
  }

  // Details the user typed in (never verified)
  for (const d of env.input.socialDetails) {
    const platform = d.platform.trim().toLowerCase() === 'twitter' ? 'x' : d.platform.trim().toLowerCase();
    const lines = [
      `platform: ${platform}`,
      d.url && `profile_url: ${d.url}`,
      d.bio && `bio_stated_by_user: ${d.bio}`,
      d.followers != null && `followers_stated_by_user: ${d.followers}`,
      d.postsPerMonth != null && `posts_per_month_stated_by_user: ${d.postsPerMonth}`,
      d.notes && `notes_by_user: ${d.notes}`,
      'These values were typed in by the user. They were NOT retrieved from the platform and are not verified.',
    ].filter(Boolean) as string[];
    const rec = addSource(env, agent, { kind: 'social_profile', label: `${platform}: details provided by the user`, url: d.url ?? null, status: 'retrieved', origin: 'user_provided' }, lines.join('\n'));
    blocks.push(srcBlock(rec, lines.join('\n')));
    material++;
    let row = rows.find((r) => r.platform === platform);
    if (!row) {
      row = { platform, url: d.url ?? null, access: 'user_provided', note: '', metrics: [] };
      rows.push(row);
    }
    if (row.access === 'unavailable' || row.access === 'invalid') row.access = 'user_provided';
    row.note = `${row.note ? `${row.note} ` : ''}Profile details typed in by the user (not verified).`.trim();
    if (d.followers != null) row.metrics.push({ label: 'Followers (stated by the user)', value: String(d.followers) });
    if (d.postsPerMonth != null) row.metrics.push({ label: 'Posts per month (stated by the user)', value: String(d.postsPerMonth) });
  }

  // Exports (historical data) and screenshots supplied by the user
  const exportDocs = env.documents.filter((d) => EXPORT_RE.test(d.name));
  if (exportDocs.length) {
    for (const d of await env.tools.documents.extractAll(exportDocs, signal)) {
      if (d.status !== 'extracted') {
        addSource(env, agent, { kind: 'document', label: d.name, status: d.status === 'failed' ? 'failed' : 'skipped', origin: 'export', error: d.reason });
        continue;
      }
      const full = d.sections.map((s) => `[${s.locator}]\n${s.text}`).join('\n');
      const rec = addSource(env, agent, { kind: 'document', label: d.name, status: 'retrieved', origin: 'export', notes: ['Historical export supplied by the user. Not retrieved from the platform.'] }, full);
      blocks.push(srcBlock(rec, `file: ${d.name} (user-supplied export)\n${full.slice(0, 5000)}`));
      material++;
    }
  }
  const shots = env.images.filter((i) => i.kind === 'screenshot');
  let attached: { mediaType: string; base64: string }[] = [];
  if (shots.length) {
    const results = await env.tools.images.prepareAll(shots, signal);
    for (const r of results) {
      if (r.prepared) {
        const rec = addSource(env, agent, { kind: 'image', label: r.prepared.name, status: 'retrieved', origin: 'user_provided', notes: ['Screenshot supplied by the user. What it shows is an interpretation, not platform data.'] }, `${r.prepared.name}: user-supplied screenshot`);
        blocks.push(srcBlock(rec, `Screenshot "${r.prepared.name}" is attached to this message. It was supplied by the user; read only what is visible, never numbers you cannot see.`));
        attached.push({ mediaType: r.prepared.mimeType, base64: r.prepared.base64 });
        material++;
      } else addSource(env, agent, { kind: 'image', label: r.name, status: 'failed', origin: 'user_provided', error: r.reason });
    }
  }

  // Platforms that were not supplied at all
  const have = new Set(rows.map((r) => r.platform));
  for (const platform of SOCIAL_PLATFORMS) if (!have.has(platform)) rows.push({ platform, url: null, access: 'not_supplied', note: 'No profile URL was supplied for this platform. This does not mean the business has no presence there.', metrics: [] });
  env.facts.social = rows;

  if (!material) {
    const findings: LlmAuditFinding[] = gaps.slice(0, 6).map((g) => ({
      area: 'social',
      kind: 'gap',
      title: `${g.platform}: metrics could not be retrieved`,
      statement: `No data about the ${g.platform} profile could be obtained: ${g.note}`,
      classification: 'unknown',
      severity: 'info',
      sourceType: 'user_provided',
      sourceId: g.sourceId,
      locator: null,
      excerpt: null,
      recommendation: `To audit ${g.platform}, connect an authorized API or provide an analytics export or a screenshot of the profile.`,
      confidence: null,
    }));
    return {
      kind: 'direct',
      reason: 'No retrievable or user-provided social data: reported as unavailable without a model call.',
      output: { summary: 'No social metrics could be obtained: no official API access and no user-provided data. This is a limit of the audit, not a finding about the profiles.', findings, missingInformation: gaps.map((g) => `${g.platform}: ${g.note}`).slice(0, 8) },
    };
  }

  const facts = rows.filter((r) => r.access !== 'not_supplied').map((r) => ({ platform: r.platform, url: r.url, access: r.access, note: r.note, metrics: r.metrics }));
  const unavailable = gaps.map((g) => `${g.platform}: ${g.note}`);
  const extra = `Access per platform is listed in <audit_facts>. Live data exists ONLY where access is "live_api". ${unavailable.length ? `\nUnavailable (do not guess):\n- ${unavailable.join('\n- ')}` : ''}${fixture ? '\nFIXTURE MODE: API data below is demo data.' : ''}`;
  return { kind: 'ready', message: auditorMessage('Social Media Auditor', { f1: env.f1, language: env.input.language }, { blocks, facts, extra, topics: 'presence' }), images: attached.length ? attached : undefined };
}

// ---- A10 Brand Auditor -------------------------------------------------------------------------------------------

export async function prepareBrand(env: F2Env, agent: PhaseAgent): Promise<F2Prep> {
  const site = await ensureSite(env);
  const pages = (site?.home.ok ? site.pages : []).slice(0, 2);
  const blocks: string[] = [];
  for (const p of pages) {
    const b = block(env, p, 'brand');
    if (b) blocks.push(b);
  }
  if (env.input.styleNotes && env.input.styleNotes.trim().length >= 20) {
    const rec = addSource(env, agent, { kind: 'user_input', label: 'Brand/style description from the project intake', status: 'retrieved', origin: 'user_provided' }, `style_preference_stated_by_user: ${env.input.styleNotes}`);
    blocks.push(srcBlock(rec, env.store.text(rec.id)));
  }
  const f1Visual = env.f1.findings.filter((f) => f.agent === 'Visual Analyzer');
  const nonShots = env.images.filter((i) => i.kind !== 'screenshot');
  let attached: { mediaType: string; base64: string }[] = [];
  let imageNote = 'No new image analysis was necessary or possible.';
  if (nonShots.length && f1Visual.length === 0) {
    const results = await env.tools.images.prepareAll(nonShots, agent.signal);
    for (const r of results) {
      if (r.prepared) {
        addSource(env, agent, { kind: 'image', label: r.prepared.name, status: 'retrieved', origin: 'user_provided', notes: [`Resized ${r.prepared.originalWidth}x${r.prepared.originalHeight} to ${r.prepared.width}x${r.prepared.height}; metadata removed.`] }, `${r.prepared.name}: measured palette ${r.prepared.palette.map((c) => `${c.hex} ${Math.round(c.share * 100)}%`).join(', ')}`);
        attached.push({ mediaType: r.prepared.mimeType, base64: r.prepared.base64 });
      } else addSource(env, agent, { kind: 'image', label: r.name, status: r.status === 'skipped' ? 'skipped' : 'failed', origin: 'user_provided', error: r.reason });
    }
    if (attached.length) imageNote = `${attached.length} image(s) are attached: F1 had no visual analysis, so these are viewed now. Judge only what is visible.`;
  } else if (f1Visual.length) imageNote = `F1 already analyzed the images (see the f1_finding entries tagged Visual Analyzer). They are reused; no new image analysis is made.`;

  const hasMaterial = blocks.length > 0 || f1Visual.length > 0 || attached.length > 0 || !!env.f1.report.productManifest.brand;
  if (!hasMaterial) return { kind: 'skip', reason: 'No website branding, images, F1 visual analysis or brand description to audit.' };
  const extra = `${imageNote}\nThe user did not supply brand guidelines unless a source says so: do not invent rules.${site && !site.home.ok ? `\nThe website could not be read (${site.home.message}), so no website branding is available.` : ''}`;
  return { kind: 'ready', message: auditorMessage('Brand Auditor', { f1: env.f1, language: env.input.language }, { blocks, extra, topics: 'brand' }), images: attached.length ? attached : undefined };
}

// ---- A11 Messaging Auditor ---------------------------------------------------------------------------------------

export async function prepareMessaging(env: F2Env, _agent: PhaseAgent): Promise<F2Prep> {
  const site = await ensureSite(env);
  const blocks: string[] = [];
  for (const p of (site?.home.ok ? site.pages : []).slice(0, 3)) {
    const b = block(env, p, 'messaging');
    if (b) blocks.push(b);
  }
  const extra = blocks.length
    ? 'Compare what the website says with the F1 Product Manifest (value proposition, offering, audience).'
    : `No website text is available${env.input.websiteUrl ? ` (${site && !site.home.ok ? site.home.message : 'not retrieved'})` : ' (no website URL)'}. Audit only the product description in the F1 context and state clearly that website messaging was not examined.`;
  return { kind: 'ready', message: auditorMessage('Messaging Auditor', { f1: env.f1, language: env.input.language }, { blocks, extra, topics: 'messaging' }) };
}

// ---- A12 Presence Auditor ----------------------------------------------------------------------------------------

export async function preparePresence(env: F2Env, agent: PhaseAgent): Promise<F2Prep> {
  const site = await ensureSite(env);
  const pages = site?.home.ok ? site.pages : null;
  const facts = checkPresence({ productName: env.f1.report.productManifest.name, websiteUrl: env.input.websiteUrl, pages, socials: env.input.socialProfiles });
  env.facts.presence = facts;
  const text = describePresence(facts);
  const rec = addSource(env, agent, { kind: 'website', label: 'Cross-channel consistency check (computed)', status: 'retrieved', live: !!pages, fixture: env.settings.fixtureSources, origin: pages ? webOrigin(env) : 'user_provided', notes: ['Computed by LaunchPilot from the retrieved pages and the supplied URLs. No platform was visited.'] }, text);

  if (!env.input.websiteUrl && env.input.socialProfiles.length === 0) {
    return {
      kind: 'direct',
      reason: 'No website and no social profile was supplied: reported without a model call.',
      output: {
        summary: 'No official website and no social profile was supplied for this project, so cross-channel consistency cannot be audited.',
        findings: [
          {
            area: 'presence',
            kind: 'gap',
            title: 'No channels supplied',
            statement: 'No website URL and no social profile URL were supplied. This says nothing about whether the business has such channels.',
            classification: 'unknown',
            severity: 'info',
            sourceType: 'user_provided',
            sourceId: rec.id,
            locator: null,
            excerpt: null,
            recommendation: 'Add the official website and social profile URLs to the project so the presence can be audited.',
            confidence: null,
          },
        ],
        missingInformation: ['Official website URL', 'Social profile URLs'],
      },
    };
  }
  const blocks = [srcBlock(rec, text)];
  if (pages) {
    const b = block(env, pages[0], 'presence');
    if (b) blocks.push(b);
  }
  const extra = `Website: ${env.input.websiteUrl ? (pages ? 'retrieved' : `NOT retrieved (${site && !site.home.ok ? site.home.message : 'unavailable'})`) : 'not supplied'}. Social platforms were NOT visited: "live_check: not performed" means unverified, not absent.`;
  return { kind: 'ready', message: auditorMessage('Presence Auditor', { f1: env.f1, language: env.input.language }, { blocks, extra, topics: 'presence' }) };
}

export const PREPARE: Record<Exclude<AuditKey, 'synthesizer'>, (env: F2Env, agent: PhaseAgent) => Promise<F2Prep>> = {
  seo: prepareSeo,
  social: prepareSocial,
  brand: prepareBrand,
  messaging: prepareMessaging,
  presence: preparePresence,
};
