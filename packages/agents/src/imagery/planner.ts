import { IMAGE_SOURCING_MODES, type ImageSourcingMode } from '../collections/design';
import type { ImageSourceKind } from './types';

/**
 * THE SOURCE SELECTION PLANNER (deterministic, free). It tells the user, before anything is paid for, where the pictures of the campaign come
 * from and how many paid image requests the plan makes. It never changes the number of AI images the user asked for: when a different number
 * would make sense it OFFERS it as a suggestion that only the user's own click applies.
 *
 *   prefer_existing   existing pictures first (the user's, then licensed ones already added to the project), AI images where none exist
 *   balanced          AI originals as requested; existing pictures fill the concepts that have no AI original
 *   prefer_ai         AI originals as requested; existing pictures only where a concept has no AI original
 */

export { IMAGE_SOURCING_MODES };

export interface SourcePlanInput {
  mode: ImageSourcingMode;
  /** the number of original AI images the user asked for (authoritative) */
  originalsRequested: number;
  /** false = no image model is selected: no AI image can be made */
  imageModelOn: boolean;
  concepts: number;
  /** pictures the user uploaded to the project */
  userImages: number;
  /** licensed pictures already added to the project (with provenance) */
  licensedImages: number;
  /** licensed candidates found but not added: they are NOT used until the user adds them */
  licensedCandidates: number;
  /** estimated dollars of one image request; null = not known */
  imageUsd: number | null;
  /** upper bound the system allows */
  hardMax?: number;
}

export interface ConceptSource {
  concept: number;
  picture: ImageSourceKind | 'NONE';
  reason: string;
}

export interface SourceSuggestion {
  id: string;
  message: string;
  /** what applying it sets; never applied automatically */
  set: { originals: number };
  fewerRequests: number;
  savesUsd: number | null;
}

export interface SourcePlan {
  mode: ImageSourcingMode;
  /** the paid image requests this plan makes (first attempts; a regeneration is separate and bounded by the budget) */
  paidImageRequests: number;
  perConcept: ConceptSource[];
  totals: Record<'AI_GENERATED' | 'USER_PROVIDED' | 'LICENSED_STOCK' | 'NONE', number>;
  suggestions: SourceSuggestion[];
  warnings: string[];
  summary: string;
}

export function planImageSources(input: SourcePlanInput): SourcePlan {
  const hardMax = input.hardMax ?? 40;
  const concepts = Math.max(1, Math.min(5, Math.floor(input.concepts) || 1));
  const asked = Math.max(0, Math.min(hardMax, Math.floor(input.originalsRequested)));
  const ai = input.imageModelOn ? asked : 0;
  const warnings: string[] = [];
  if (!input.imageModelOn && asked > 0) warnings.push(`${asked} original AI image(s) are requested but no image model is selected, so none will be made.`);
  const existing: ('USER_PROVIDED' | 'LICENSED_STOCK')[] = [...Array(Math.max(0, input.userImages)).fill('USER_PROVIDED'), ...Array(Math.max(0, input.licensedImages)).fill('LICENSED_STOCK')];

  // which concepts get an AI original: the allocation planner gives every concept an even share first, so the first `ai` concepts get one
  const aiConcepts = Math.min(concepts, ai);
  const perConcept: ConceptSource[] = [];
  for (let i = 0; i < concepts; i++) {
    if (i < aiConcepts) {
      perConcept.push({ concept: i + 1, picture: 'AI_GENERATED', reason: ai > concepts ? 'an original AI image (more than one is planned for this concept)' : 'an original AI image' });
      continue;
    }
    const ex = existing.length ? existing[(i - aiConcepts) % existing.length] : null;
    perConcept.push(ex ? { concept: i + 1, picture: ex, reason: ex === 'USER_PROVIDED' ? 'a picture you uploaded' : 'a licensed picture you added, with its credit' } : { concept: i + 1, picture: 'NONE', reason: 'no picture: a typographic or pattern template is used' });
  }

  const suggestions: SourceSuggestion[] = [];
  if (input.imageModelOn && existing.length > 0 && input.mode !== 'prefer_ai') {
    // every existing picture could stand in for one concept; the AI images beyond what the remaining concepts need could be skipped
    const needed = Math.max(0, concepts - Math.min(concepts, existing.length));
    const target = input.mode === 'prefer_existing' ? needed : Math.max(needed, Math.min(asked, concepts - Math.min(concepts, Math.floor(existing.length / 2))));
    if (target < asked) {
      const fewer = asked - target;
      suggestions.push({
        id: 'use-existing-pictures',
        message: `You have ${existing.length} usable picture${existing.length === 1 ? '' : 's'} of your own or licensed. Requesting ${target} original AI image${target === 1 ? '' : 's'} instead of ${asked} would use them for ${Math.min(existing.length, concepts)} concept${Math.min(existing.length, concepts) === 1 ? '' : 's'}.${input.mode === 'prefer_existing' ? '' : ' (Shown because you chose a balanced plan.)'}`,
        set: { originals: target },
        fewerRequests: fewer,
        savesUsd: input.imageUsd === null ? null : Number((fewer * input.imageUsd).toFixed(2)),
      });
    }
  }
  if (input.mode === 'prefer_existing' && existing.length === 0 && asked > 0) {
    warnings.push(input.licensedCandidates > 0 ? `Existing pictures are preferred, but none is in the project yet. ${input.licensedCandidates} licensed candidate${input.licensedCandidates === 1 ? ' was' : 's were'} found: add the ones you like to the project, then review the plan again. Until then ${asked} original AI image${asked === 1 ? '' : 's'} will be made as requested.` : `Existing pictures are preferred, but the project has none and none were found. ${asked} original AI image${asked === 1 ? '' : 's'} will be made as requested.`);
  }
  if (input.mode === 'prefer_existing' && ai === 0) {
    const without = perConcept.filter((c) => c.picture === 'NONE').length;
    warnings.push(without ? `No AI images are requested and ${without} of ${concepts} concept${concepts === 1 ? '' : 's'} have no existing picture: those use typographic templates without a photograph.` : 'No AI images are requested: every concept uses a picture you provided or licensed.');
  }
  if (ai > 0 && input.licensedCandidates > 0 && input.licensedImages === 0) warnings.push(`${input.licensedCandidates} licensed picture candidate${input.licensedCandidates === 1 ? '' : 's'} were found and are NOT used until you add them to the project.`);

  const count = (k: ConceptSource['picture']) => perConcept.filter((c) => c.picture === k).length;
  const totals = { AI_GENERATED: count('AI_GENERATED'), USER_PROVIDED: count('USER_PROVIDED'), LICENSED_STOCK: count('LICENSED_STOCK'), NONE: count('NONE') };
  const parts = [`${ai} paid image request${ai === 1 ? '' : 's'} for original AI images`, ...(totals.USER_PROVIDED ? [`${totals.USER_PROVIDED} concept${totals.USER_PROVIDED === 1 ? '' : 's'} with your pictures`] : []), ...(totals.LICENSED_STOCK ? [`${totals.LICENSED_STOCK} with licensed pictures`] : []), ...(totals.NONE ? [`${totals.NONE} without a picture`] : [])];
  return { mode: input.mode, paidImageRequests: ai, perConcept, totals, suggestions, warnings, summary: parts.join(', ') };
}
