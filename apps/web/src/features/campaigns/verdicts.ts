/**
 * Which verdicts to offer next, given the ones already chosen.
 *
 * The catalogue's templates each carry a small, mutually exclusive set of verdicts — the way
 * a real campaign's are — and those sets are the best guide to what belongs beside what.
 * Once "already paid" is on the list, the sets that contain it say "will pay", "cannot pay"
 * and "disputes" come next; with nothing chosen, the verdicts most templates share are the
 * ones to start from.
 *
 * Ranking: a candidate scores once per set it shares with the chosen verdicts, weighted by
 * how many of the chosen ones that set holds, plus a small tie-break for how many sets it
 * appears in at all. Pure, so the page can pass in the sets and the control need not import
 * seventy-three templates into the client bundle.
 */
export const suggestVerdicts = (
  chosen: readonly string[],
  sets: readonly (readonly string[])[],
  limit = 8,
): readonly string[] => {
  const have = new Set(chosen.map((verdict) => verdict.trim().toLowerCase()));
  const score = new Map<string, number>();
  const frequency = new Map<string, number>();

  for (const set of sets) {
    const overlap = set.filter((verdict) => have.has(verdict.toLowerCase())).length;
    for (const verdict of set) {
      if (have.has(verdict.toLowerCase())) continue;
      frequency.set(verdict, (frequency.get(verdict) ?? 0) + 1);
      if (overlap > 0) score.set(verdict, (score.get(verdict) ?? 0) + overlap);
    }
  }

  const candidates = [...frequency.keys()];
  candidates.sort((a, b) => {
    const byScore = (score.get(b) ?? 0) - (score.get(a) ?? 0);
    if (byScore !== 0) return byScore;
    const byFrequency = (frequency.get(b) ?? 0) - (frequency.get(a) ?? 0);
    if (byFrequency !== 0) return byFrequency;
    return a.localeCompare(b);
  });
  return candidates.slice(0, limit);
};
