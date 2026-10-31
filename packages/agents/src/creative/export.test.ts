import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import { InMemoryAssetStore } from './assets';
import { buildCampaignZip, safeName, zipFileName } from './export';
import { CAMPAIGN_SCHEMA_VERSION, CampaignPackage, type AssetRecord } from './schemas';
import { makePng } from '../testing/fixtures';

// The ZIP export: real binaries, deterministic safe names, a manifest with hashes, no secrets. FIXTURE data only.

async function fixture() {
  const store = new InMemoryAssetStore();
  const base = await store.save({ kind: 'image', conceptId: 'K1', channel: null, format: null, version: 1, parentAssetId: null, mimeType: 'image/png', width: 64, height: 64, source: 'ai_image', model: 'gpt-image-test', quality: 'low', requestedSize: '1024x1024', status: 'generated', flags: [], altText: 'A calm scene', promptMetadata: { promptChars: 420, directionSummary: 'calm scene' }, usage: { input: 10, output: 20, total: 30 }, data: await makePng(64, 64, '#2b6f8f') });
  const old = await store.save({ kind: 'layout', conceptId: 'K1', channel: 'instagram', format: 'instagram_square', version: 1, parentAssetId: base.id, mimeType: 'image/png', width: 1080, height: 1080, source: 'ai_image', model: 'gpt-image-test', quality: 'low', requestedSize: null, status: 'superseded', flags: ['low_contrast_3.1'], altText: 'Headline', promptMetadata: null, usage: null, data: await makePng(1080, 1080, '#ff0000') });
  const layout = await store.save({ kind: 'layout', conceptId: 'K1', channel: 'instagram', format: 'instagram_square', version: 2, parentAssetId: base.id, mimeType: 'image/png', width: 1080, height: 1080, source: 'ai_image', model: 'gpt-image-test', quality: 'low', requestedSize: null, status: 'rendered', flags: [], altText: 'Headline', promptMetadata: null, usage: null, data: await makePng(1080, 1080, '#00ff00') });
  const assets: AssetRecord[] = [base, old, layout];
  const pkg: CampaignPackage = CampaignPackage.parse({
    id: 'cmp_1',
    projectId: 'proj_1',
    runId: 'run_1',
    f1ReportId: 'f1-1',
    f2ReportId: 'f2-1',
    f3StrategyId: 'f3-1',
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    campaignName: 'Deep Diving School — creative campaign <test> & "quotes"',
    language: 'en',
    concepts: [{ id: 'K1', name: 'Start with confidence', angle: 'a', keyMessage: 'k', audience: 'beginners', ctaType: 'learn_more', ctaText: 'Learn more', visualIdea: 'calm sea' }],
    copyVariants: [{ id: 'V1', conceptId: 'K1', channel: 'instagram', placement: 'paid_ad', length: 'short', headline: 'Take the first step <b>calmly</b>', body: 'Learn to dive safely.', description: null, ctaText: 'Learn more', ctaType: 'learn_more', hashtags: ['#dive'], claims: [{ text: 'certified instructors', support: 'f1', ref: null }], version: 2, history: [{ version: 1, headline: 'Old', body: 'Guaranteed results', ctaText: 'Go', reason: 'unsupported promise' }] }],
    imageAssets: assets,
    channelLayouts: [{ id: 'layout-1', conceptId: 'K1', variantId: 'V1', assetId: layout.id, baseAssetId: base.id, format: 'instagram_square', channel: 'instagram', headline: 'Take the first step calmly', ctaText: 'Learn more', flags: [] }],
    skippedLayouts: [{ conceptId: 'K1', format: 'promo_16x9', channel: 'youtube', reason: 'would enlarge 1.9x' }],
    landingContent: { seoTitle: 'Learn to dive', metaDescription: 'd', hero: { headline: 'Learn to dive <script>alert(1)</script>', description: 'x', ctaText: 'Go' }, valueProposition: 'v', benefits: [], sections: [], howItWorks: [], faq: [], trustSignals: [], ctas: [{ objective: 'learn_more', text: 'Go' }], ctaObjective: 'learn_more', mobileHierarchy: [] },
    reviewFindings: [{ id: 'Q1', round: 1, kind: 'unsupported_claim', severity: 'blocker', assetRef: 'V1', finding: 'Guaranteed results is unsupported', evidence: 'e', suggestedCorrection: 'remove', responsibleAgent: 'copywriter', source: 'deterministic', status: 'fixed', resolvedInRound: 2 }],
    revisions: [{ id: 'R1', round: 1, findingId: 'Q1', operation: 'revise_copy', owner: 'Copywriter', status: 'applied', before: 'Guaranteed results', after: 'Learn to dive safely.', note: '1 variant revised' }],
    approval: { status: 'approved', rounds: 1, unresolvedFindingIds: [], note: 'ok' },
    usage: { text: { calls: 5, inputTokens: 100, outputTokens: 50, totalTokens: 150, perAgent: { Copywriter: { calls: 2, totalTokens: 80 } } }, images: { model: 'gpt-image-test', quality: 'low', size: '1024x1024', requested: 1, generated: 1, failed: 0, regenerations: 0, limits: { maxImages: 1, maxRegenerations: 0 }, providerReportedTokens: { input: 10, output: 20, total: 30 } }, layouts: { rendered: 1, skipped: 1 } },
    limitations: ['FIXTURE'],
    createdAt: '2026-06-15T12:00:00.000Z',
  });
  return { store, pkg, base, old, layout };
}

describe('Campaign ZIP export', () => {
  it('contains the real image binaries, JSON, copy, landing, review and a manifest with hashes; names are deterministic and safe', async () => {
    const { store, pkg, base, old, layout } = await fixture();
    const { zip, manifest } = await buildCampaignZip(pkg, store, { palette: ['#0a5c8c'] });
    const z = await JSZip.loadAsync(zip);
    const names = Object.keys(z.files).filter((n) => !z.files[n].dir).sort();
    assert.ok(names.includes('campaign.json') && names.includes('README.md') && names.includes('summary.html') && names.includes('manifest.json'));
    assert.ok(names.includes('landing/landing-content.json') && names.includes('landing/landing-preview.html'));
    assert.ok(names.includes('review/findings.json') && names.includes('review/revisions.json'));
    assert.ok(names.some((n) => n.startsWith('copy/start-with-confidence-instagram-paid_ad-v1')));
    const basePath = manifest.files.find((f) => f.assetId === base.id)!.path;
    const layoutPath = manifest.files.find((f) => f.assetId === layout.id)!.path;
    const oldPath = manifest.files.find((f) => f.assetId === old.id)!.path;
    assert.match(basePath, /^images\/base\/start-with-confidence-k1-v1-ast_[a-z0-9]+\.png$/);
    assert.match(layoutPath, /^images\/layouts\/start-with-confidence-k1\/instagram_square-instagram-v2-ast_[a-z0-9]+\.png$/);
    assert.match(oldPath, /^images\/superseded\/layouts\//, 'the original of a repaired asset is kept, clearly separated');
    for (const n of names) assert.match(n, /^[A-Za-z0-9._\/-]+$/, `unsafe name ${n}`);
    // the bytes are the stored binaries, verifiably
    const stored = await store.load(layout.id);
    const inZip = await z.file(layoutPath)!.async('nodebuffer');
    assert.ok(stored.equals(inZip));
    const m = await sharp(inZip).metadata();
    assert.deepEqual([m.width, m.height], [1080, 1080]);
    const entry = manifest.files.find((f) => f.path === layoutPath)!;
    assert.equal(entry.bytes, stored.length);
    assert.equal(entry.sha256, layout.sha256);
    // JSON round-trips as the validated package
    const json = JSON.parse(await z.file('campaign.json')!.async('string'));
    assert.ok(CampaignPackage.safeParse(json).success);
    // the markdown names the chain and the repair history
    const md = await z.file('README.md')!.async('string');
    assert.match(md, /F1 report f1-1, F2 audit f2-1, F3 strategy f3-1/);
    assert.match(md, /Earlier versions: v1 "Old"/);
    // the HTML summary escapes untrusted text and links the exported files
    const html = await z.file('summary.html')!.async('string');
    assert.ok(!html.includes('<b>calmly</b>') && html.includes('&lt;b&gt;calmly&lt;/b&gt;'));
    assert.ok(html.includes(layoutPath));
    const landing = await z.file('landing/landing-preview.html')!.async('string');
    assert.ok(!landing.includes('<script>alert(1)</script>'));
    // nothing credential-shaped, no image prompt text
    const all = (await Promise.all(names.filter((n) => !n.endsWith('.png')).map((n) => z.file(n)!.async('string')))).join('\n');
    assert.doesNotMatch(all, /sk-[A-Za-z0-9]{10,}/);
    assert.ok(!all.includes('Strict rules'));
    assert.equal(manifest.assetsMissing.length, 0);
    assert.equal(zipFileName(pkg), 'deep-diving-school-creative-campaign-test-quotes-cmp_1.zip');
  });

  it('is byte-for-byte deterministic for the same package', async () => {
    const { store, pkg } = await fixture();
    const a = await buildCampaignZip(pkg, store);
    const b = await buildCampaignZip(pkg, store);
    assert.ok(a.zip.equals(b.zip));
  });

  it('reports a missing binary instead of failing the whole export', async () => {
    const { store, pkg, old } = await fixture();
    store.files.delete(old.id);
    const { zip, manifest } = await buildCampaignZip(pkg, store);
    assert.deepEqual(manifest.assetsMissing, [old.id]);
    assert.ok(zip.length > 1000);
  });

  it('safeName strips everything but [a-z0-9._-]', () => {
    assert.equal(safeName('Škola Ronjenja / "Deep" <Diving>!'), 'skola-ronjenja-deep-diving');
    assert.equal(safeName('../../etc/passwd'), 'etc-passwd');
    assert.equal(safeName(''), 'file');
  });
});
