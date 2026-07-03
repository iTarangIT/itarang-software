/**
 * Shared types for the perf-audit harness (scripts/perf-audit/).
 */

export type AuditRole = "ceo" | "dealer" | "sales_head" | "public";

export interface IdDiscovery {
  /** Same-origin API endpoint returning JSON that contains a usable record id. */
  api: string;
  /** Dot-path into the JSON body, numeric segments index arrays, e.g. "data.0.id". */
  jsonPath: string;
}

export interface PageEntry {
  /** App URL with dynamic segments normalised to ":param", e.g. "/leads/:id". */
  url: string;
  /** Source page.tsx path, repo-relative. */
  sourceFile: string;
  /** Which audit roles should measure this page. "public" = no auth. */
  roles: AuditRole[];
  /** True when the URL contains at least one ":param" segment. */
  dynamic: boolean;
  /** Optional explicit id lookup when link-harvesting can't find one. */
  idDiscovery?: IdDiscovery | null;
  /** Skip with a reason (e.g. signed-token flows that can't be fabricated). */
  skip?: string;
}

export interface ApiCallTiming {
  url: string;
  durationMs: number;
  status: number;
}

/** One measured navigation. */
export interface RunSample {
  ttfbMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  cls: number | null;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  networkIdleMs: number;
  transferBytes: number;
  jsBytes: number;
  requestCount: number;
  slowestApiCalls: ApiCallTiming[];
  consoleErrors: string[];
  pageErrors: string[];
  httpErrors: { url: string; status: number }[];
}

export interface PageResult {
  url: string;
  resolvedUrl: string;
  role: AuditRole;
  status: "ok" | "error" | "skipped";
  skipReason?: string;
  error?: string;
  /** Median across samples (JSON keeps every sample in `samples`). */
  median: RunSample | null;
  samples: RunSample[];
}

export interface RunReport {
  baseUrl: string;
  commit: string;
  startedAt: string;
  finishedAt: string;
  runsPerPage: number;
  roles: AuditRole[];
  results: PageResult[];
  skipped: { url: string; role: AuditRole; reason: string }[];
}
