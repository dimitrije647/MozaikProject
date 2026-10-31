import { INPUT_FIELD_PATHS, inputCorpus, normalizeText, type DiscoveryInput } from './input';

// ---- Grounding: is a "claimed" fact really traceable to what the user supplied? ---------------

export function fieldValue(input: DiscoveryInput, path: string): string | null {
  const map: Record<string, string | null | undefined> = {
    'project.name': input.project.name,
    'project.description': input.project.description,
    'intake.productName': input.intake?.productName,
    'intake.shortDescription': input.intake?.shortDescription,
    'intake.targetMarket': input.intake?.targetMarket,
    'intake.targetAudience': input.intake?.targetAudience,
    'intake.marketingGoal': input.intake?.marketingGoal,
    'intake.campaignDuration': input.intake?.campaignDuration,
    'intake.stylePreference': input.intake?.stylePreference,
  };
  const note = /^notes\[(\d+)\]/.exec(path);
  if (note) {
    const n = input.notes[Number(note[1])];
    return n ? `${n.title} ${n.content}` : null;
  }
  return map[path] ?? null;
}

/**
 * A reference is grounded when it names a supplied, non-empty input field, or contains a quoted /
 * bare snippet that appears VERBATIM in the supplied text. Quotes stay in the input's language, so
 * the check works even when the report is written in a different language.
 */
export function isGroundedReference(ref: string | null | undefined, input: DiscoveryInput): boolean {
  if (!ref) return false;
  const paths = [...INPUT_FIELD_PATHS, ...input.notes.map((_, i) => `notes[${i}]`)];
  for (const p of paths) {
    if (ref.includes(p) && fieldValue(input, p)) return true;
  }
  const corpus = inputCorpus(input);
  const quoted = [...ref.matchAll(/["“„'«]([^"”“'»]{6,})["”'»]/g)].map((m) => m[1]);
  const candidates = quoted.length ? quoted : [ref];
  return candidates.some((q) => normalizeText(q).length >= 6 && corpus.includes(normalizeText(q)));
}

