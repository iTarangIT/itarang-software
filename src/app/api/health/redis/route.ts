import { NextResponse } from "next/server";
import { quotaCircuit } from "@/lib/queue/connection";

/**
 * GET /api/health/redis — pull-only health probe for Upstash + worker state.
 *
 * Returns the in-process `quotaCircuit` state (cheap, no Redis cost) and,
 * when Upstash REST credentials are present, the current daily usage vs
 * limit from their control-plane API. `upstash: null` is a valid state for
 * operators who haven't provisioned the REST token.
 *
 * Gated behind CRON_SECRET to match /api/bolna/call-scheduler. Not called
 * on a schedule — this endpoint is pull-only, meant for humans/uptime
 * monitors hitting it on demand.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Refresh circuit state so a stale open flag auto-closes once the
  // cooldown window passes.
  const circuitOpen = quotaCircuit.tick();

  const upstash = await fetchUpstashUsage().catch((err) => {
    return { error: (err as Error).message } as const;
  });

  const worker = {
    enabled: process.env.ENABLE_CALL_WORKER === "1",
  };

  return NextResponse.json({
    circuit: {
      open: circuitOpen,
      reopenAt: quotaCircuit.reopenAt || null,
    },
    upstash,
    worker,
    now: new Date().toISOString(),
  });
}

type UpstashUsage = {
  usedToday: number;
  limit: number;
  percent: number;
} | null;

async function fetchUpstashUsage(): Promise<UpstashUsage | { error: string }> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  // Upstash REST surface for usage counters varies by region/plan. This is a
  // best-effort probe — if the endpoint shape changes, the route still
  // returns the in-process circuit state, which is the primary signal.
  const infoUrl = `${url.replace(/\/$/, "")}/info`;
  const res = await fetch(infoUrl, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    return { error: `upstash /info returned ${res.status}` };
  }
  const body = (await res.json()) as unknown;
  // The public Upstash plan data isn't exposed via /info on every plan;
  // callers should treat null as "unknown" rather than "healthy".
  const bodyRec = (body ?? {}) as Record<string, unknown>;
  const used = numericFrom(bodyRec, ["usedRequests", "used_today", "dailyRequests"]);
  const limit = numericFrom(bodyRec, ["dailyLimit", "maxRequests", "limit"]);
  if (used == null || limit == null || limit === 0) return null;
  return {
    usedToday: used,
    limit,
    percent: Math.round((used / limit) * 1000) / 10,
  };
}

function numericFrom(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}
