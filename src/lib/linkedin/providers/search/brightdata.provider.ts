/**
 * Bright Data Web Scraper API (Datasets v3) — LinkedIn people profiles.
 *
 *   POST /datasets/v3/trigger?dataset_id=…&include_errors=true[&endpoint=…&auth_header=…]
 *        body [{ url }]                                   → { snapshot_id }
 *   GET  /datasets/v3/progress/{snapshot_id}              → { status: running | ready | failed }
 *   GET  /datasets/v3/snapshot/{snapshot_id}?format=json  → records[]
 *   GET  /customer/balance                                → { balance, pending_balance }
 *
 * Bright Data people search takes profile URLs (or names), not keywords, so
 * startSearch is the two-step path: web discovery for URLs, then enrich. When
 * no Bright Data token is configured the discovered profiles are returned as
 * they are (name / headline / company from the search title) so search still
 * works on the CRM's existing keys; enrichment fills company + city later.
 */
import { getSecret } from "../../credentials";
import { normaliseProfileUrl } from "../../lib/profile-url";
import { firstNameOf } from "../../lib/render-template";
import { discoverProfiles } from "./discovery";
import {
  ProviderNotConfiguredError,
  type JobStatus,
  type ProfileRecord,
  type SearchInput,
  type SearchJob,
  type SearchProvider,
} from "./types";

const BASE = "https://api.brightdata.com";
/** Bright Data's public "LinkedIn people profiles" dataset. Override in Accounts if it changes. */
export const DEFAULT_PEOPLE_DATASET = "gd_l1viktl72bvl7bjuj0";
/** Job id for a discovery-only run (no Bright Data token): results are immediate. */
export const IMMEDIATE_JOB = "immediate";

/** A Bright Data failure → one line the Sales Head can act on. */
export function enrichWarning(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lead = "Saved without full profile details — Bright Data";
  if (/customer is not active/i.test(msg)) return `${lead} account is not active (finish sign-up / add billing in the Bright Data dashboard).`;
  if (/\b401\b|\b403\b|unauthori[sz]ed|invalid token/i.test(msg)) return `${lead} token was refused (check it on LinkedIn › Accounts).`;
  if (/\b402\b|balance|insufficient/i.test(msg)) return `${lead} balance is too low.`;
  return `${lead} failed: ${msg.slice(0, 200)}`;
}

type BdRecord = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** One Bright Data record → ProfileRecord. Pure; exported for tests. */
export function mapBrightDataRecord(r: BdRecord): ProfileRecord | null {
  if (r.error || r.warning_code === "dead_page") return null;
  const key = normaliseProfileUrl(str(r.url) ?? str(r.input_url) ?? (str(r.id) ? `linkedin.com/in/${r.id}` : null));
  if (!key) return null;
  const company =
    str((r.current_company as BdRecord | undefined)?.name) ??
    str(r.current_company_name) ??
    (Array.isArray(r.experience) ? str((r.experience[0] as BdRecord | undefined)?.company) : null);
  const fullName = str(r.name) ?? ([str(r.first_name), str(r.last_name)].filter(Boolean).join(" ") || null);
  return {
    profileUrl: key.publicUrl,
    fullName,
    firstName: str(r.first_name) ?? firstNameOf(fullName),
    headline: str(r.position) ?? str(r.headline),
    company,
    city: str(r.city) ?? str(r.location),
    raw: r,
  };
}

export class BrightDataProvider implements SearchProvider {
  readonly name = "brightdata";

  private async token(): Promise<string | null> {
    return getSecret("brightdata:api_token");
  }

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.token();
    if (!token) throw new ProviderNotConfiguredError("Bright Data API token is not configured (LinkedIn › Accounts).");
    return fetch(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(60_000),
    });
  }

  async startSearch(input: SearchInput): Promise<SearchJob> {
    const discovered = await discoverProfiles(input);
    if (!(await this.token()) || discovered.length === 0) {
      return { providerJobId: IMMEDIATE_JOB, immediate: discovered };
    }
    try {
      const job = await this.enrichProfiles(
        discovered.map((d) => d.profileUrl),
        input,
      );
      // Keep the discovered rows too: saved now, enriched when the snapshot lands.
      return { ...job, immediate: discovered };
    } catch (err) {
      // Enrichment is optional: keep what discovery found rather than fail the run.
      return { providerJobId: IMMEDIATE_JOB, immediate: discovered, warning: enrichWarning(err) };
    }
  }

  async enrichProfiles(urls: string[], input?: Pick<SearchInput, "webhookUrl" | "webhookSecret">): Promise<SearchJob> {
    const dataset = (await getSecret("brightdata:dataset_id")) || DEFAULT_PEOPLE_DATASET;
    const qs = new URLSearchParams({ dataset_id: dataset, include_errors: "true", format: "json" });
    if (input?.webhookUrl) {
      qs.set("endpoint", input.webhookUrl);
      qs.set("uncompressed_webhook", "true");
      if (input.webhookSecret) qs.set("auth_header", `Bearer ${input.webhookSecret}`);
    }
    const res = await this.req(`/datasets/v3/trigger?${qs}`, {
      method: "POST",
      body: JSON.stringify(urls.map((url) => ({ url }))),
    });
    if (!res.ok) throw new Error(`Bright Data trigger ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { snapshot_id?: string };
    if (!body.snapshot_id) throw new Error("Bright Data trigger returned no snapshot_id");
    return { providerJobId: body.snapshot_id };
  }

  async jobStatus(providerJobId: string): Promise<{ status: JobStatus; error?: string }> {
    if (providerJobId === IMMEDIATE_JOB) return { status: "ready" };
    const res = await this.req(`/datasets/v3/progress/${encodeURIComponent(providerJobId)}`);
    if (!res.ok) return { status: "failed", error: `progress ${res.status}` };
    const body = (await res.json()) as { status?: string; error?: string };
    if (body.status === "ready") return { status: "ready" };
    if (body.status === "failed") return { status: "failed", error: body.error ?? "snapshot failed" };
    return { status: "running" };
  }

  async fetchResults(providerJobId: string): Promise<ProfileRecord[]> {
    if (providerJobId === IMMEDIATE_JOB) return [];
    const res = await this.req(`/datasets/v3/snapshot/${encodeURIComponent(providerJobId)}?format=json`);
    if (res.status === 202) return []; // not ready yet
    if (!res.ok) throw new Error(`Bright Data snapshot ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as BdRecord[] | BdRecord;
    return parseBrightDataPayload(body);
  }

  parseDelivery(body: unknown): ProfileRecord[] {
    return parseBrightDataPayload(body);
  }

  async balance(): Promise<string | null> {
    if (!(await this.token())) return null;
    try {
      const res = await this.req("/customer/balance", { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const b = (await res.json()) as { balance?: number; pending_balance?: number };
      return typeof b.balance === "number" ? `$${b.balance.toFixed(2)}${b.pending_balance ? ` (pending $${b.pending_balance.toFixed(2)})` : ""}` : null;
    } catch {
      return null;
    }
  }
}

/** Webhook / snapshot body → records. Accepts an array or a single record. */
export function parseBrightDataPayload(body: unknown): ProfileRecord[] {
  const list = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : [];
  return list.map((r) => mapBrightDataRecord(r as BdRecord)).filter((r): r is ProfileRecord => r !== null);
}
