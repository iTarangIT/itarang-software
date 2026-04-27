/**
 * GET /api/health
 *
 * Aggregated liveness + readiness probe used by:
 *   - deploy-{sandbox,production}.yml as the post-deploy gate
 *   - external uptime monitors (UptimeRobot, etc.)
 *
 * Returns 200 with per-dependency status when ALL critical deps are reachable;
 * 503 if any critical dep is down. The deploy script polls this for ~60s
 * after pm2 reload and rolls back on persistent 503.
 *
 * Critical deps (rollback-triggering):
 *   - CRM Postgres (primary DB)
 *
 * Soft deps (logged but don't fail health):
 *   - IoT bridge (VPS Postgres) — degraded NBFC dashboard, but rest of CRM works
 *   - Redis — affects BullMQ workers, not request path
 *   - Risk sandbox — only affects "Re-run analysis" button
 *
 * Includes commit SHA from build-time GITHUB_SHA env var so deploy logs can
 * confirm the right build is serving requests.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 1.5s per dep — total worst-case ~6s
const CHECK_TIMEOUT_MS = 1500;

interface DepStatus {
  ok: boolean;
  ms: number;
  error?: string;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

async function checkCrmDb(): Promise<DepStatus> {
  const t0 = Date.now();
  try {
    await withTimeout(db.execute(sql`SELECT 1`), CHECK_TIMEOUT_MS);
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

async function checkIotBridge(): Promise<DepStatus> {
  const t0 = Date.now();
  if (!process.env.IOT_DATABASE_URL) {
    return { ok: false, ms: 0, error: "IOT_DATABASE_URL not set" };
  }
  try {
    // Lazy import — don't load the IoT client unless we have to.
    const { iotSql } = await import("@/lib/db/iot");
    await withTimeout(iotSql`SELECT 1` as unknown as Promise<unknown>, CHECK_TIMEOUT_MS);
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

async function checkSandbox(): Promise<DepStatus> {
  const t0 = Date.now();
  const url = process.env.NBFC_SANDBOX_URL;
  if (!url) return { ok: false, ms: 0, error: "NBFC_SANDBOX_URL not set" };
  try {
    const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    return r.ok
      ? { ok: true, ms: Date.now() - t0 }
      : { ok: false, ms: Date.now() - t0, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET() {
  const t0 = Date.now();
  const [crmDb, iotBridge, sandbox] = await Promise.all([
    checkCrmDb(),
    checkIotBridge(),
    checkSandbox(),
  ]);

  // Only crmDb gates health (rollback-trigger). The others are reported but
  // don't fail the probe — they're soft deps.
  const allCriticalOk = crmDb.ok;

  const body = {
    ok: allCriticalOk,
    commit: process.env.GITHUB_SHA?.slice(0, 12) ?? "unknown",
    env: process.env.NODE_ENV,
    deps: {
      crm_db: crmDb, // critical
      iot_bridge: iotBridge, // soft
      sandbox: sandbox, // soft
    },
    elapsed_ms: Date.now() - t0,
  };

  return NextResponse.json(body, { status: allCriticalOk ? 200 : 503 });
}
