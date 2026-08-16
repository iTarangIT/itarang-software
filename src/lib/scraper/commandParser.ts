import { normalizeQuery } from "./chunkedPipeline";

// E-241 — turning what the operator typed into the rows that go in
// scraper_job_queue.
//
// The scraper's single input has always been one free-text query. The batch
// form accepts a LIST in the same box, and the only sane separators for a
// person typing product phrasings and city names are the comma and the newline
// — which is also what pasting a spreadsheet column produces. Everything here
// is deliberately dumb string work with hard caps; the interesting decisions
// (window, AI expansion, ordering) live on the queue row, not in the parse.

// Caps. These are the ceiling on ONE submission, not on the queue as a whole —
// an operator can submit again while the first batch is still draining.
export const MAX_COMMANDS = 25;
export const MAX_CITIES = 50;
export const MAX_JOBS = 500;

// With AI expansion on, each job fans out to ~MAX_QUERY_VARIATIONS (15) chunks
// and every chunk is a billed QStash message. 500 jobs would be ~7,500 messages
// from one click, so the cap tightens to something an operator can be wrong
// about without it mattering.
export const MAX_JOBS_WITH_AI = 100;

export interface Pair {
  query: string;
  city: string | null;
  max_results: number | null;
}

// Splits on commas AND newlines, so all of these are the same submission:
//   "lithium battery, sukhi battery, port lithium battery"
//   three lines pasted out of Excel
//   a mixture of the two
// Trimmed, lowercased (the existing single-query route lowercases too, so batch
// and single normalise identically), 3w-rewritten, deduped, order preserved.
function splitList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\n\r]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function parseCommands(raw: string): string[] {
  return [
    ...new Set(splitList(raw).map((c) => normalizeQuery(c).toLowerCase())),
  ].slice(0, MAX_COMMANDS);
}

export function parseCities(raw: string): string[] {
  return splitList(raw).slice(0, MAX_CITIES);
}

// The cartesian product, in the operator's own order: every city of command 1,
// then every city of command 2. That ordering is what makes seq meaningful —
// a batch cancelled half way through has finished whole commands rather than a
// scattering of pairs.
//
// An EMPTY city list is not an error. It means "no city list supplied", one job
// per command with city = null, and startChunkedRun() then falls back to
// generateCitiesForQuery() — i.e. exactly the pre-E-241 single-query behaviour,
// which is the thing the Single/Batch toggle has to be able to reproduce.
export function buildPairs(
  commands: string[],
  cities: string[],
  maxResults: number | null = null,
): Pair[] {
  const pairs: Pair[] = [];
  for (const query of commands) {
    if (!cities.length) {
      pairs.push({ query, city: null, max_results: maxResults });
      continue;
    }
    for (const city of cities) {
      pairs.push({ query, city, max_results: maxResults });
    }
  }
  return pairs;
}

export function jobCap(expandWithAi: boolean): number {
  return expandWithAi ? MAX_JOBS_WITH_AI : MAX_JOBS;
}

// One place that decides whether a submission is too big, so the form's live
// preview and the API's rejection can never disagree about the number.
export function describeJobCount(
  pairs: Pair[],
  expandWithAi: boolean,
): { jobs: number; cap: number; overCap: boolean; estimatedChunks: number } {
  const cap = jobCap(expandWithAi);
  return {
    jobs: pairs.length,
    cap,
    overCap: pairs.length > cap,
    // ~15 is MAX_QUERY_VARIATIONS in chunkedPipeline. Without expansion it is
    // one chunk per job when a city was given, and however many cities the AI
    // picks when one wasn't — so this is a floor, and labelled as such in the UI.
    estimatedChunks: pairs.length * (expandWithAi ? 15 : 1),
  };
}
