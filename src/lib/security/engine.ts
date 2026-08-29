/**
 * The scan engine: guard → lock → sessions → run probes → persist findings.
 *
 * Standalone from the NBFC risk engine. In Step 4 a LangGraph agent wraps the
 * probe orchestration + LLM triage; this direct-run engine is what it calls into
 * (and what the CLI + the in-app trigger call today).
 */
import { createHash } from "node:crypto";
import { request as playwrightRequest, type APIRequestContext, type Browser } from "@playwright/test";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityFindings } from "@/lib/db/schema";
import { resolveMode, resolveTarget } from "./target";
import { beginScan, completeScan, failScan, type ScanTrigger, type ScanSummary } from "./scan-run";
import { launchBrowser, loginRoles, type ScanRole } from "./session";
import type { ProbeContext } from "./probe-context";
import { abs } from "./probe-context";
import { runSecurityGraph } from "./agent/graph";
import { SENSITIVE_UNAUTH_ROUTES, DEBUG_ROUTES, ADMIN_SURFACES, REFLECTED_PARAM_TARGETS } from "./crawl";
import type { RawFinding } from "./types";
import type { Severity } from "./severity";

/** Rough count of distinct surfaces the curated probes touch (for the run header). */
const CURATED_SURFACE_COUNT =
  SENSITIVE_UNAUTH_ROUTES.length +
  DEBUG_ROUTES.length +
  ADMIN_SURFACES.length +
  REFLECTED_PARAM_TARGETS.length;

export interface RunScanOptions {
  targetUrl?: string;
  mode?: string;
  trigger: ScanTrigger;
  actorUserId?: string | null;
  roles?: ScanRole[];
  log?: (m: string) => void;
}

export interface RunScanResult {
  runId: string;
  summary: ScanSummary;
  skippedRoles: Array<{ role: string; reason: string }>;
}

export async function runSecurityScan(opts: RunScanOptions): Promise<RunScanResult> {
  const log = opts.log ?? ((m: string) => console.log(`[security] ${m}`));
  const { baseUrl, env } = resolveTarget(opts.targetUrl);
  const mode = resolveMode(opts.mode);
  log(`target=${baseUrl} env=${env} mode=${mode}`);

  const runId = await beginScan({
    targetEnv: env,
    targetBaseUrl: baseUrl,
    mode,
    trigger: opts.trigger,
    actorUserId: opts.actorUserId ?? null,
  });
  log(`scan run ${runId} started`);

  let browser: Browser | null = null;
  const toDispose: APIRequestContext[] = [];

  try {
    browser = await launchBrowser();
    const { sessions, skipped } = await loginRoles(browser, baseUrl, opts.roles, log);
    if (skipped.length) log(`skipped roles: ${skipped.map((s) => `${s.role} (${s.reason})`).join(", ")}`);

    const anon = await playwrightRequest.newContext({ baseURL: baseUrl });
    toDispose.push(anon);

    const api = new Map<string, APIRequestContext>();
    for (const [role, state] of sessions) {
      const rc = await playwrightRequest.newContext({ baseURL: baseUrl, storageState: state });
      api.set(role, rc);
      toDispose.push(rc);
    }

    const ctx: ProbeContext = { baseUrl, targetEnv: env, mode, browser, anon, api, storage: sessions, log };

    // The LangGraph agent orchestrates planning → probes → LLM triage → persist.
    const graphResult = await runSecurityGraph({
      ctx,
      persist: (findings) => persistFindings(runId, baseUrl, findings),
    });
    const summary: ScanSummary = {
      ...graphResult.summary,
      prompt_tokens: graphResult.promptTokens,
      completion_tokens: graphResult.completionTokens,
    };
    await completeScan(runId, summary);
    log(`scan run ${runId} completed: ${summary.findings_total} finding(s)`);
    return { runId, summary, skippedRoles: skipped };
  } catch (e) {
    await failScan(runId, e);
    log(`scan run ${runId} failed: ${(e as Error).message}`);
    throw e;
  } finally {
    for (const rc of toDispose) await rc.dispose().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

/** Fingerprint = stable identity of a finding, so re-scans dedup instead of piling up. */
function fingerprint(f: RawFinding, path: string): string {
  return createHash("sha256")
    .update([f.check_slug, f.http_method ?? "", path, f.title].join("|"))
    .digest("hex")
    .slice(0, 64);
}

async function persistFindings(
  runId: string,
  baseUrl: string,
  raw: RawFinding[],
): Promise<ScanSummary> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const seen = new Set<string>();

  for (const f of raw) {
    const absoluteUrl = abs(baseUrl, f.target_url);
    let path: string;
    try {
      path = new URL(absoluteUrl).pathname;
    } catch {
      path = f.target_url;
    }
    const fp = fingerprint(f, path);
    if (seen.has(fp)) continue; // de-dup within this run
    seen.add(fp);
    counts[f.severity]++;

    await db
      .insert(securityFindings)
      .values({
        run_id: runId,
        check_slug: f.check_slug,
        category: f.category,
        severity: f.severity,
        title: f.title,
        summary: f.summary,
        target_url: absoluteUrl,
        http_method: f.http_method ?? null,
        evidence_json: f.evidence ?? null,
        reproduction: f.reproduction ?? null,
        remediation: f.remediation ?? null,
        owasp_ref: f.owasp_ref ?? null,
        cwe_ref: f.cwe_ref ?? null,
        confidence: f.confidence,
        fingerprint: fp,
      })
      .onConflictDoUpdate({
        target: securityFindings.fingerprint,
        targetWhere: sql`status <> 'resolved'`,
        // Refresh the finding under the latest run; DO NOT touch triage `status`.
        set: {
          run_id: runId,
          category: f.category,
          severity: f.severity,
          title: f.title,
          summary: f.summary,
          target_url: absoluteUrl,
          http_method: f.http_method ?? null,
          evidence_json: f.evidence ?? null,
          reproduction: f.reproduction ?? null,
          remediation: f.remediation ?? null,
          owasp_ref: f.owasp_ref ?? null,
          cwe_ref: f.cwe_ref ?? null,
          confidence: f.confidence,
        },
      });
  }

  const total = counts.critical + counts.high + counts.medium + counts.low + counts.info;
  return {
    surfaces_walked: CURATED_SURFACE_COUNT,
    findings_total: total,
    findings_critical: counts.critical,
    findings_high: counts.high,
    findings_medium: counts.medium,
    findings_low: counts.low,
    findings_info: counts.info,
    prompt_tokens: 0,
    completion_tokens: 0,
  };
}
