// Reading a band out of a Google Sheet reviewer's free-text cell.
//
// Its own module, separate from the importer that uses it, for one reason: the
// importer runs main() at load and talks to Postgres and the Sheets API, so it
// cannot be imported by a test. This function decides which cells become
// permanent GROUND TRUTH in intent_score_feedback, which makes it exactly the
// part that needs tests.
//
// It is asymmetric on purpose. A false negative costs one training example. A
// false positive plants a verdict nobody expressed into the golden set, where
// it trains the model and skews the accuracy number for good. Every ambiguous
// case therefore returns null.

export type Band = "Qualified" | "Warm" | "Cold" | "Disqualified";

/**
 * Try to read a band out of a reviewer's free-text cell.
 *
 * Deliberately CONSERVATIVE — it returns null far more often than it guesses.
 * A wrong label is worse than no label here: a note misread as a correction
 * becomes permanent fake ground truth that both the accuracy number and the
 * calibration examples are computed from.
 *
 * Rules:
 *   · the verdict must appear as a whole word, so "coldly" or "not warm" do
 *     not match;
 *   · a cell naming TWO different bands is ambiguous and yields null rather
 *     than picking the first;
 *   · negations ("not cold", "isn't qualified") disqualify that word.
 */
export function parseBandFromReview(text: string): Band | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9\s']/g, " ")} `;

  const synonyms: Array<[Band, string[]]> = [
    ["Qualified", ["qualified", "hot", "interested"]],
    ["Warm", ["warm"]],
    ["Cold", ["cold"]],
    ["Disqualified", ["disqualified", "disqualify", "junk", "irrelevant", "wrong number"]],
  ];

  const found = new Set<Band>();

  for (const [band, words] of synonyms) {
    for (const w of words) {
      const re = new RegExp(`(^|\\s)((not|non|isn't|isnt|no)\\s+)?${w}(\\s|$)`);
      const m = t.match(re);
      if (!m) continue;
      // A negated mention is not an assertion of that band, and it is also not
      // an assertion of any other — skip the word entirely.
      if (m[2]) continue;
      found.add(band);
    }
  }

  if (found.size !== 1) return null;
  return [...found][0];
}
