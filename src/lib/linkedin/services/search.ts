/**
 * Search runs (R1, R2). The route creates a run and returns; the work runs
 * after the response (and is retried by the search ticker). Results arrive
 * either immediately (web discovery), by Bright Data webhook, or by the ticker
 * polling the snapshot — all three paths go through ingestResults(), which is
 * idempotent.
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { crmBaseUrl } from "@/lib/assistant/config";
import { db } from "@/lib/db";
import { liProspects, liSearchResults, liSearchRuns } from "@/lib/db/schema";

import { scoreProfiles } from "../agent/scoring";
import { webhookSecret } from "../credentials";
import { searchProvider } from "../providers";
import type { ProfileRecord } from "../providers/search/types";
import { logAction } from "./actionLog";
import { contactedMap, stripRaw, upsertProfiles } from "./prospects";

export type SearchFilters = { location?: string | null; company?: string | null; limit?: number };

export async function createSearchRun(args: {
  keywords: string;
  filters: SearchFilters;
  accountId: string | null;
  actorId: string | null;
}) {
  const [run] = await db
    .insert(liSearchRuns)
    .values({
      keywords: args.keywords.trim(),
      filters: args.filters,
      account_id: args.accountId,
      provider: searchProvider().name,
      triggered_by: args.actorId,
    })
    .returning();
  return run;
}

/** Start the provider job. Safe to call again for a still-queued run. */
export async function startSearchRun(runId: string): Promise<void> {
  const [claimed] = await db
    .update(liSearchRuns)
    .set({ status: "running", started_at: new Date() })
    .where(and(eq(liSearchRuns.id, runId), eq(liSearchRuns.status, "queued")))
    .returning();
  if (!claimed) return;
  const filters = (claimed.filters ?? {}) as SearchFilters;
  try {
    const secret = await webhookSecret();
    const job = await searchProvider().startSearch({
      keywords: claimed.keywords,
      location: filters.location,
      company: filters.company,
      limit: filters.limit ?? 25,
      webhookUrl: `${crmBaseUrl()}/api/webhooks/linkedin/search?run=${claimed.id}`,
      webhookSecret: secret,
    });
    await db.update(liSearchRuns).set({ provider_job_id: job.providerJobId }).where(eq(liSearchRuns.id, runId));
    if (job.immediate?.length) await ingestResults(runId, job.immediate, { finish: job.providerJobId === "immediate" });
    else if (job.providerJobId === "immediate") await finishRun(runId);
    // A skipped step (e.g. enrichment) is noted on the run without failing it.
    if (job.warning) await db.update(liSearchRuns).set({ error: job.warning.slice(0, 1000) }).where(eq(liSearchRuns.id, runId));
    await logAction({ action: "search", ok: true, detail: `run ${runId}: ${claimed.keywords}`, actorId: claimed.triggered_by });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(liSearchRuns)
      .set({ status: "failed", error: msg.slice(0, 1000), finished_at: new Date() })
      .where(eq(liSearchRuns.id, runId));
    await logAction({ action: "search", ok: false, detail: `run ${runId}: ${msg}`, actorId: claimed.triggered_by });
  }
}

/** Save records against a run, then score the run's unscored prospects. Idempotent. */
export async function ingestResults(runId: string, records: ProfileRecord[], opts: { finish?: boolean } = {}) {
  const ids = await upsertProfiles(records, "brightdata");
  if (ids.length) {
    await db
      .insert(liSearchResults)
      .values(ids.map((prospect_id) => ({ run_id: runId, prospect_id })))
      .onConflictDoNothing();
  }
  await scoreRun(runId);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(liSearchResults)
    .where(eq(liSearchResults.run_id, runId));
  await db.update(liSearchRuns).set({ result_count: Number(n) }).where(eq(liSearchRuns.id, runId));
  if (opts.finish) await finishRun(runId);
  return ids.length;
}

export async function finishRun(runId: string, error?: string) {
  await db
    .update(liSearchRuns)
    .set({ status: error ? "failed" : "done", error: error ?? null, finished_at: new Date() })
    .where(eq(liSearchRuns.id, runId));
}

async function scoreRun(runId: string) {
  const [run] = await db.select().from(liSearchRuns).where(eq(liSearchRuns.id, runId)).limit(1);
  if (!run) return;
  const unscored = await db
    .select({
      id: liProspects.id,
      full_name: liProspects.full_name,
      headline: liProspects.headline,
      company: liProspects.company,
      city: liProspects.city,
    })
    .from(liSearchResults)
    .innerJoin(liProspects, eq(liProspects.id, liSearchResults.prospect_id))
    .where(and(eq(liSearchResults.run_id, runId), sql`${liSearchResults.fit_score} IS NULL`));
  if (!unscored.length) return;
  try {
    const scores = await scoreProfiles(run.keywords, unscored);
    for (const s of scores) {
      await db
        .update(liSearchResults)
        .set({ fit_score: s.score, fit_reason: s.reason })
        .where(and(eq(liSearchResults.run_id, runId), eq(liSearchResults.prospect_id, s.id)));
    }
  } catch (err) {
    console.warn("[linkedin] scoring skipped:", err instanceof Error ? err.message : err);
  }
}

/** Ticker / manual refresh: poll a running provider job. */
export async function refreshRun(runId: string): Promise<void> {
  const [run] = await db.select().from(liSearchRuns).where(eq(liSearchRuns.id, runId)).limit(1);
  if (!run || run.status !== "running" || !run.provider_job_id) return;
  const p = searchProvider();
  const st = await p.jobStatus(run.provider_job_id);
  if (st.status === "running") return;
  if (st.status === "failed") {
    // Discovery rows are already saved; the run is usable, enrichment failed.
    await finishRun(runId, run.result_count > 0 ? undefined : `Enrichment failed: ${st.error ?? "unknown"}`);
    return;
  }
  const records = await p.fetchResults(run.provider_job_id);
  await ingestResults(runId, records, { finish: true });
}

export async function listRuns(limit = 30) {
  return db.select().from(liSearchRuns).orderBy(desc(liSearchRuns.created_at)).limit(limit);
}

/** Run status + shortlist (best fit first) with the "already contacted" flag. */
export async function getRun(runId: string) {
  const [run] = await db.select().from(liSearchRuns).where(eq(liSearchRuns.id, runId)).limit(1);
  if (!run) return null;
  const rows = await db
    .select({ p: liProspects, fit_score: liSearchResults.fit_score, fit_reason: liSearchResults.fit_reason })
    .from(liSearchResults)
    .innerJoin(liProspects, eq(liProspects.id, liSearchResults.prospect_id))
    .where(eq(liSearchResults.run_id, runId))
    .orderBy(sql`${liSearchResults.fit_score} DESC NULLS LAST`, liProspects.full_name);
  const contacted = await contactedMap(rows.map((r) => r.p.id));
  return {
    run,
    results: rows.map((r) => ({
      ...stripRaw(r.p),
      fit_score: r.fit_score,
      fit_reason: r.fit_reason,
      campaigns: contacted.get(r.p.id) ?? [],
    })),
  };
}

export async function runningRunIds(): Promise<string[]> {
  const rows = await db
    .select({ id: liSearchRuns.id })
    .from(liSearchRuns)
    .where(inArray(liSearchRuns.status, ["running"]));
  return rows.map((r) => r.id);
}

export async function queuedRunIds(olderThanMs = 60_000): Promise<string[]> {
  const rows = await db
    .select({ id: liSearchRuns.id })
    .from(liSearchRuns)
    .where(
      and(eq(liSearchRuns.status, "queued"), lt(liSearchRuns.created_at, new Date(Date.now() - olderThanMs))),
    );
  return rows.map((r) => r.id);
}
