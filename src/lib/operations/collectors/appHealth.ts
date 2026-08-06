/**
 * The application's own vital signs.
 *
 * Deliberately does NOT fetch /api/health over HTTP. Three reasons: an
 * in-process collector has no reliable base URL on a pm2 box behind nginx; a
 * self-request goes out through nginx and back, so a failure could mean the
 * proxy rather than the app; and the checks themselves are four lines. This
 * runs the SAME probes /api/health runs, against the same clients, so the
 * numbers agree with the deploy gate by construction.
 *
 * Keep this in step with src/app/api/health/route.ts — if a dependency is
 * added there it belongs here too.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import type { CollectedSample, OpsCollector } from "./types";
import { MINUTE } from "./types";

/** Matches CHECK_TIMEOUT_MS in /api/health, so latency is comparable. */
const CHECK_TIMEOUT_MS = 1500;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}

interface DepStatus {
  ok: boolean;
  ms: number;
  error?: string;
}

async function timed(fn: () => Promise<unknown>): Promise<DepStatus> {
  const t0 = Date.now();
  try {
    await withTimeout(fn(), CHECK_TIMEOUT_MS);
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function checkCrmDb(): Promise<DepStatus> {
  return timed(() => db.execute(sql`SELECT 1`));
}

async function checkIotBridge(): Promise<DepStatus> {
  if (!process.env.IOT_DATABASE_URL) {
    return { ok: false, ms: 0, error: "IOT_DATABASE_URL not set" };
  }
  return timed(async () => {
    // Lazy import — don't load the IoT client unless we have to.
    const { getIotSql } = await import("@/lib/db/iot");
    return getIotSql()`SELECT 1` as unknown as Promise<unknown>;
  });
}

async function checkSandbox(): Promise<DepStatus> {
  const url = process.env.NBFC_SANDBOX_URL;
  if (!url) return { ok: false, ms: 0, error: "NBFC_SANDBOX_URL not set" };
  return timed(async () => {
    const r = await fetch(`${url}/healthz`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  });
}

/**
 * The Upstash quota circuit breaker. Read in-process rather than through
 * /api/health/redis, which is CRON_SECRET-gated — and the circuit state lives
 * in this process's memory anyway, so an HTTP hop would tell us about whichever
 * process answered rather than about this one.
 */
async function readRedisCircuit(): Promise<{
  open: boolean;
  reopenAt: number | null;
} | null> {
  try {
    const mod = await import("@/lib/queue/connection");
    const circuit = (mod as { quotaCircuit?: { open?: boolean; reopenAt?: number | null } })
      .quotaCircuit;
    if (!circuit) return null;
    return { open: !!circuit.open, reopenAt: circuit.reopenAt ?? null };
  } catch {
    // No Redis configured in this environment. Not an error worth failing the
    // whole collector over — the metric is simply absent.
    return null;
  }
}

export const appHealthCollector: OpsCollector = {
  id: "system.app_health",
  label: "App health & dependencies",
  intervalMs: 2 * MINUTE,
  timeoutMs: 15_000,

  async run(): Promise<CollectedSample[]> {
    const [crmDb, iotBridge, sandbox, circuit] = await Promise.all([
      checkCrmDb(),
      checkIotBridge(),
      checkSandbox(),
      readRedisCircuit(),
    ]);

    const samples: CollectedSample[] = [
      {
        metric_key: "app.uptime_s",
        source: "app:web",
        value_num: Math.round(process.uptime()),
        meta: {
          commit: process.env.GITHUB_SHA?.slice(0, 12) ?? "unknown",
          node_env: process.env.NODE_ENV,
          pid: process.pid,
        },
      },
      // Only the CRM DB gates health, matching /api/health — the IoT bridge and
      // the risk sandbox are soft deps there and must not raise a crit here.
      {
        metric_key: "app.health_ok",
        source: "app:web",
        value_num: crmDb.ok ? 1 : 0,
        value_text: crmDb.ok ? "ok" : (crmDb.error ?? "down"),
      },
      {
        metric_key: "app.health_latency_ms",
        source: "app:web",
        value_num: crmDb.ms,
      },
    ];

    for (const [name, dep] of Object.entries({
      crm_db: crmDb,
      iot_bridge: iotBridge,
      sandbox,
    })) {
      samples.push({
        metric_key: "app.dep_ok",
        source: `dep:${name}`,
        value_num: dep.ok ? 1 : 0,
        value_text: dep.ok ? "ok" : (dep.error?.slice(0, 500) ?? "down"),
      });
      samples.push({
        metric_key: "app.dep_latency_ms",
        source: `dep:${name}`,
        value_num: dep.ms,
      });
    }

    if (circuit) {
      samples.push({
        metric_key: "app.redis_circuit_open",
        source: "dep:upstash",
        value_num: circuit.open ? 1 : 0,
        meta: {
          reopen_at: circuit.reopenAt,
          worker_enabled: process.env.ENABLE_CALL_WORKER === "1",
        },
      });
    }

    return samples;
  },
};
