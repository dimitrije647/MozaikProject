import { allocateImages, type ImageAllocation } from '../../../imagery/allocate';
import { analyzeImage, hammingDistance, NEAR_DUPLICATE_BITS } from '../../../imagery/analysis';
import { buildSearchIntents, keywordsOf, wordsOf, type IntentContext } from '../../../imagery/discovery';
import { exportEligibility, stockRights, uploadRights, type ImageRights } from '../../../imagery/rights';
import { imageNeedsOf, rankImages, scoreImage, textOfImage, type ScoreContext, type ScoreSubject } from '../../../imagery/scoring';
import type { DiscoveryResult, ImageCandidate } from '../../../imagery/types';
import type { ImageryBlock, LibraryImageRecord } from '../../../hybrid/records';
import { designBrandColors } from '../../../collections/design';
import { formatClassOf } from '../../../templates/schema';
import type { BrandImage, F4Env, LibraryImageInfo } from './env';

/**
 * NO AI HYBRID: THE PICTURES OF A CAMPAIGN, sourced by the Visual Researcher after the concepts exist and before any template is chosen.
 *
 *   1. the approved library of the project (uploads, approved website/repository pictures, licensed pictures the user added) is checked AGAIN
 *      against the rights gate: a picture that may not be exported never reaches a template, whatever the caller passed in
 *   2. in AUTOMATIC STOCK MODE, when the library is thinner than the campaign needs, licensed providers are searched with concept-aware queries and
 *      the best pictures whose license is CLEARED (never "needs a check") are fetched through the guarded downloader, with their provenance
 *   3. near-identical pictures are removed by perceptual hash; the rest are ranked by the deterministic scorer
 *   4. every planned creative is given a picture (a picture may serve several creatives, cropped differently)
 *
 * No model is called and no AI image is made. Nothing is invented: when no picture exists the creatives are text-first.
 */

export const AUTO_STOCK_MAX = 8;
const SEARCH_TIMEOUT_MS = 20_000;
const ACQUIRE_TIMEOUT_MS = 25_000;

export interface SourcingOutcome {
  imagery: ImageryBlock;
  allocation: ImageAllocation;
  /** the pictures that remain in the library (eligible, de-duplicated) */
  library: BrandImage[];
  summary: string;
  /** what the licensed search found (null when no search ran) */
  discovery: DiscoveryResult | null;
}

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

const defaultInfo = (img: BrandImage): LibraryImageInfo => ({ rights: uploadRights(), analysis: null, text: textOfImage({ fileName: img.name }), width: null, height: null, pageUrl: null, via: 'library' });

export async function sourceImages(env: F4Env, o: { refused: () => number }): Promise<SourcingOutcome> {
  const hs = env.settings.hybrid!;
  const hy = env.hybrid!;
  const plan = env.board.hybridPlan!;
  const notes: string[] = [];
  const providers: ImageryBlock['providers'] = [];
  let discovered = 0;
  let autoAdded = 0;
  let searched: DiscoveryResult | null = null;

  // ---- 1) the library, checked against the rights gate once more ------------------------------------------------------------------------------------
  const library: BrandImage[] = [];
  const dropped: string[] = [];
  for (const img of hy.brandImages) {
    const info = img.library ?? defaultInfo(img);
    const gate = exportEligibility(info.rights);
    if (!gate.eligible) {
      dropped.push(`${img.name}: ${gate.reason}`);
      continue;
    }
    const analysis = info.analysis ?? (await analyzeImage(img.data));
    library.push({ ...img, library: { ...info, analysis } });
  }
  for (const d of dropped.slice(0, 6)) notes.push(`Not used: ${d}`);

  // near-identical pictures: keep the first (the library is ordered by the caller), say which were removed
  const hashes: string[] = [];
  const unique: BrandImage[] = [];
  for (const img of library) {
    const h = img.library!.analysis?.phash;
    const twin = h ? hashes.findIndex((x) => hammingDistance(x, h) <= NEAR_DUPLICATE_BITS) : -1;
    if (twin >= 0) {
      notes.push(`${img.name} is nearly identical to ${unique[twin]?.name ?? 'another picture'} and was left out.`);
      continue;
    }
    if (h) hashes.push(h);
    unique.push(img);
  }

  const concepts = env.board.concepts;
  const businessWords = keywordsOf({ business: env.visualBrief.business || env.input.projectName, offering: env.visualBrief.offering, valueProposition: env.visualBrief.valueProposition }, 8);
  const collection = hy.collection;
  const needs = imageNeedsOf(collection?.id);
  const classes = [...new Set(plan.slots.map((s) => s.formatClass))];
  const palette = hy.design ? designBrandColors(hy.design.palette) : env.palette;
  const scoreCtx: ScoreContext = { businessWords, conceptWords: concepts.flatMap((c) => wordsOf(`${c.visualIdea} ${c.name}`)).slice(0, 12), collectionId: collection?.id ?? null, formatClasses: classes, palette, chosenHashes: [] };

  // ---- 2) automatic stock mode: top up from licensed providers, cleared licenses only ------------------------------------------------------------------
  const desired = Math.min(10, Math.max(concepts.length, Math.ceil(plan.slots.length / 2)));
  if (hs.imagery.autoStock) {
    if (unique.length >= desired) notes.push(`Automatic stock mode is on, but the library already holds ${unique.length} usable picture(s) (${desired} are enough for this campaign), so nothing was added.`);
    else if (!hy.discovery || !hy.acquire) notes.push('Automatic stock mode is on, but no licensed image provider is configured on this server, so no picture was added. Add PIXABAY_API_KEY (or enable Openverse) in the API environment, or upload your own pictures.');
    else {
      const intentCtx: IntentContext = {
        business: env.visualBrief.business || env.input.projectName,
        offering: env.visualBrief.offering,
        valueProposition: env.visualBrief.valueProposition,
        audience: env.visualBrief.audience.primary,
        objective: env.visualBrief.campaignGoal,
        imageSubjects: env.board.direction?.imageSubjects ?? [],
        mood: env.board.direction?.mood ?? [],
        formatClasses: classes,
        concepts: concepts.map((c) => ({ name: c.name, visualIdea: c.visualIdea, keyMessage: c.keyMessage })),
        collectionId: collection?.id,
        collectionNeeds: needs?.summary,
      };
      let result: DiscoveryResult | null = null;
      if (buildSearchIntents(intentCtx).length) {
        try {
          result = await withTimeout(hy.discovery(intentCtx), SEARCH_TIMEOUT_MS);
        } catch {
          result = null;
        }
      }
      if (!result) notes.push('The licensed image search did not answer in time; no picture was added.');
      else {
        searched = result;
        for (const p of result.providers) providers.push({ id: p.id, label: p.label, status: p.status, message: p.message, count: p.count });
        discovered += result.licensed.length;
        notes.push(...result.notes.slice(0, 2));
        // only a CLEARED license is chosen without a human check; a picture that needs a check (people, Creative Commons) is left for the gallery
        const eligible = result.licensed.filter((c) => c.license.status === 'cleared' && !!c.downloadUrl);
        const skippedReview = result.licensed.length - eligible.length;
        if (skippedReview > 0) notes.push(`${skippedReview} licensed result(s) need a license check at the source (for example pictures of people); automatic mode never uses those. Review them in the image gallery.`);
        const subjects = eligible.map((c: ImageCandidate): ScoreSubject => ({ id: `${c.provider}:${c.id}`, text: textOfImage({ title: c.title, tags: c.tags }), width: c.width, height: c.height, source: 'stock', rights: stockRights(c.license, { userApproved: true }) }));
        const byKey = new Map(eligible.map((c) => [`${c.provider}:${c.id}`, c]));
        const ranked = rankImages(subjects, scoreCtx, { stage: 'selection' }).ranked;
        // at most one picture per creator per pass, so the library is not ten pictures of one photographer
        const seenCreator = new Set<string>();
        const pick: ImageCandidate[] = [];
        for (const r of ranked) {
          const c = byKey.get(r.id)!;
          const who = `${c.provider}|${c.creator ?? c.id}`;
          if (seenCreator.has(who)) continue;
          seenCreator.add(who);
          pick.push(c);
          if (pick.length >= Math.min(AUTO_STOCK_MAX, desired - unique.length)) break;
        }
        for (const c of pick) {
          if (unique.length >= desired) break;
          let got: Awaited<ReturnType<NonNullable<typeof hy.acquire>>> | null = null;
          try {
            got = await withTimeout(hy.acquire!(c), ACQUIRE_TIMEOUT_MS);
          } catch {
            got = null;
          }
          if (!got || !got.ok) {
            notes.push(`A licensed picture could not be added: ${got && !got.ok ? got.message : 'the download did not finish in time'}.`);
            continue;
          }
          const img = got.image;
          const info = img.library ?? { ...defaultInfo(img), rights: stockRights(c.license, { userApproved: true }), via: 'auto_stock' as const };
          const gate = exportEligibility(info.rights);
          if (!gate.eligible) {
            notes.push(`A licensed picture was not used: ${gate.reason}`);
            continue;
          }
          const analysis = info.analysis ?? (await analyzeImage(img.data));
          const h = analysis?.phash;
          if (h && hashes.some((x) => hammingDistance(x, h) <= NEAR_DUPLICATE_BITS)) {
            notes.push('A licensed picture was nearly identical to one already in the library and was not added again.');
            continue;
          }
          if (h) hashes.push(h);
          const added: BrandImage = { ...img, library: { ...info, analysis, via: 'auto_stock' } };
          unique.push(added);
          autoAdded++;
        }
        if (autoAdded) notes.push(`${autoAdded} licensed picture(s) were added automatically (cleared licenses only); their credits are in CREDITS.txt.`);
      }
    }
  } else if (unique.length < desired) {
    notes.push(`The library holds ${unique.length} approved picture(s); ${desired} would give the campaign more variety. Add pictures in the image gallery, or switch on automatic stock mode.`);
  }

  // ---- 3) rank and allocate ---------------------------------------------------------------------------------------------------------------------------------
  const subjects: ScoreSubject[] = unique.map((img) => {
    const i = img.library!;
    return { id: img.id, text: i.text, width: i.analysis?.width ?? i.width, height: i.analysis?.height ?? i.height, source: i.rights.source, rights: i.rights, analysis: i.analysis, prominence: 0.5 };
  });
  const rank = rankImages(subjects, { ...scoreCtx, chosenHashes: [] }, { stage: 'selection' });
  const rankedIds = rank.ranked.map((r) => r.id);
  const finalLibrary = rankedIds.map((id) => unique.find((u) => u.id === id)!).filter(Boolean);
  const allocation = allocateImages({
    concepts: concepts.map((c) => ({ id: c.id, words: wordsOf(`${c.visualIdea} ${c.keyMessage} ${c.name}`) })),
    slots: plan.slots.map((s) => ({ slotId: s.slotId, conceptId: s.conceptId, index: s.index, formatClass: s.formatClass ?? formatClassOf(s.width, s.height) })),
    images: rank.ranked.map((r) => ({ id: r.id, score: r.score, text: r.subject.text, width: r.subject.width, height: r.subject.height, analysis: r.subject.analysis })),
    maxPerConcept: hs.imagery.maxSourcesPerConcept,
  });
  notes.push(...allocation.warnings);

  const usedBy = new Map<string, string[]>();
  for (const s of allocation.slots) if (s.imageId) (usedBy.get(s.imageId) ?? usedBy.set(s.imageId, []).get(s.imageId)!).push(s.slotId);
  const library_: LibraryImageRecord[] = finalLibrary.map((img) => {
    const i = img.library!;
    const sc = rank.ranked.find((r) => r.id === img.id);
    return {
      id: img.id,
      name: img.name.slice(0, 120),
      source: i.rights.source,
      kind: i.rights.kind,
      license: i.rights.license,
      verification: i.rights.verification,
      attribution: i.rights.attribution,
      attributionRequired: i.rights.attributionRequired,
      redistributeOriginal: i.rights.redistributeOriginal,
      pageUrl: i.pageUrl,
      width: i.analysis?.width ?? i.width,
      height: i.analysis?.height ?? i.height,
      score: sc?.score ?? 0,
      reasons: (sc?.reasons ?? []).slice(0, 4),
      via: i.via,
      usedBySlots: usedBy.get(img.id) ?? [],
    };
  });
  const noPictureSlots = allocation.slots.filter((s) => !s.imageId).length;
  const summary = finalLibrary.length
    ? `${finalLibrary.length} approved picture(s) for ${plan.slots.length} planned creative(s)${autoAdded ? `, ${autoAdded} added automatically from licensed stock` : ''}; ${noPictureSlots} creative(s) are text-first.`
    : `No approved picture exists: all ${plan.slots.length} planned creative(s) are text-first.`;
  const imagery: ImageryBlock = {
    mode: 'no_ai_hybrid',
    aiImagesGenerated: 0,
    imageRequests: 0,
    refusedAttempts: o.refused(),
    discovered: discovered + hy.discoveredBefore,
    approved: finalLibrary.length,
    autoAdded,
    library: library_,
    perConcept: allocation.perConcept,
    blockedSlots: [],
    providers,
    notes: notes.slice(0, 12),
  };
  return { imagery, allocation, library: finalLibrary, summary, discovery: searched };
}

/** Exposed for tests: how one library picture scores for this campaign. */
export const scoreLibraryImage = scoreImage;
export type { ImageRights };
