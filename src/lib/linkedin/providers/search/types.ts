/**
 * SearchProvider (doc §3.1). Search reads PUBLIC profile data and never touches
 * the LinkedIn account. Swapping the provider needs no change outside
 * providers/ (acceptance test 7): services import only this file and index.ts.
 */

export type SearchInput = {
  keywords: string;
  /** Optional narrowing, folded into the discovery query. */
  location?: string | null; // legacy free-text city / region (runs before the filter bar)
  company?: string | null;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  /** Current title / designation. */
  title?: string | null;
  industry?: string | null;
  /** Comma-separated words a profile must NOT mention. */
  exclude?: string | null;
  /** broad = search-engine relevance; strict = phrases quoted, and results that do not contain them are dropped. */
  match?: "broad" | "strict" | null;
  limit?: number;
  /** Where the provider should deliver results (webhook), if it supports it. */
  webhookUrl?: string | null;
  webhookSecret?: string | null;
};

/** One public profile, normalised. `profileUrl` is the dedupe key's source. */
export type ProfileRecord = {
  profileUrl: string;
  fullName: string | null;
  firstName: string | null;
  headline: string | null;
  company: string | null;
  city: string | null;
  raw: unknown;
};

export type SearchJob = {
  providerJobId: string;
  /** Some paths (discovery without enrichment) have results immediately. */
  immediate?: ProfileRecord[];
  /** The run still has results, but a step was skipped (shown on the run). */
  warning?: string;
};

export type JobStatus = "running" | "ready" | "failed";

export interface SearchProvider {
  readonly name: string;
  startSearch(input: SearchInput): Promise<SearchJob>;
  fetchResults(providerJobId: string): Promise<ProfileRecord[]>;
  jobStatus(providerJobId: string): Promise<{ status: JobStatus; error?: string }>;
  enrichProfiles(urls: string[], input?: Pick<SearchInput, "webhookUrl" | "webhookSecret">): Promise<SearchJob>;
  /** A webhook delivery body → records. */
  parseDelivery(body: unknown): ProfileRecord[];
  /** Remaining credits / balance, for the Accounts screen. null = unknown. */
  balance(): Promise<string | null>;
}

export class ProviderNotConfiguredError extends Error {
  readonly status = 503;
}
