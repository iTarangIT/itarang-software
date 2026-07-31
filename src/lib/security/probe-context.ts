/**
 * The context handed to every probe, plus the Probe interface. Isolated here
 * (rather than in types.ts) so only probe code pulls the Playwright types.
 */
import type { APIRequestContext, Browser } from "@playwright/test";
import type { ProbeMeta, RawFinding, ScanMode, TargetEnv } from "./types";
import type { StorageState } from "./session";

export interface ProbeContext {
  baseUrl: string;
  targetEnv: TargetEnv;
  mode: ScanMode;
  browser: Browser;
  /** Request context with NO cookies — for testing unauthenticated access. */
  anon: APIRequestContext;
  /** role → authenticated request context (cookies from that role's session). */
  api: Map<string, APIRequestContext>;
  /** role → raw storage state, for probes that need a real browser page. */
  storage: Map<string, StorageState>;
  log: (m: string) => void;
}

export interface Probe extends ProbeMeta {
  run(ctx: ProbeContext): Promise<RawFinding[]>;
}

/** Absolute URL for a possibly-relative path against the scan base. */
export function abs(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}
