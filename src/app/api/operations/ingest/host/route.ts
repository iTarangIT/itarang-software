/**
 * POST /api/operations/ingest/host — the ops-agent's endpoint.
 *
 * The CRM never SSHes into a box. Each VPS runs ops-agent/agent.js, which reads
 * its own vitals every 5 minutes and POSTs them here. This route is the only
 * write path for host.* and process.* metrics.
 *
 * IT DEFENDS ITSELF. src/middleware.ts returns early for every /api/* path
 * (session-cookie refresh only, no role resolution), so there is no gate in
 * front of this handler — every check below is the only one there is:
 *
 *   1. Authorization: Bearer <OPS_INGEST_SECRET>, compared with timingSafeEqual
 *   2. `host` must appear in the OPS_INGEST_HOSTS allowlist
 *   3. 512 KB body cap, checked before parsing
 *   4. zod-validated body; at most MAX_LOG_LINES log lines
 *   5. captured_at within ±10 minutes of server time
 *   6. per-host rate limit of one ACCEPTED post per minute
 *
 * Env: OPS_INGEST_SECRET, OPS_INGEST_HOSTS=prod,sandbox,iot
 *
 * Prod's shared/.env is rewritten from the PROD_ENV_FILE_B64 GitHub secret on
 * every deploy — both vars must be added to the box AND to that secret, or they
 * vanish on the next deploy. Sandbox's shared/.env is seeded once and edited on
 * the box; changing the GitHub secret does not propagate there.
 */

import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { opsLogEvents } from "@/lib/db/schema";
import { log } from "@/lib/log";
import {
  fingerprint,
  normaliseLevel,
  MAX_MESSAGE_CHARS,
} from "@/lib/operations/fingerprint";
// Validation lives in its own module so it can be unit-tested without a
// database — this route transitively imports `db` through the runner.
import {
  allowedHosts,
  bearerToken,
  checkClock,
  IngestBody,
  isHostAllowed,
  MAX_BODY_BYTES,
  MIN_POST_INTERVAL_MS,
  secretMatches,
  withinBodyCap,
  type IngestLogLine,
} from "@/lib/operations/ingest";
import { writeSamples } from "@/lib/operations/runner";
import type { CollectedSample } from "@/lib/operations/collectors/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(status: number, message: string) {
  return NextResponse.json({ success: false, error: { message } }, { status });
}

/**
 * Per-host throttle, in process memory.
 *
 * Deliberately not Redis: this guards against a misconfigured agent cron
 * hammering the endpoint, and a per-process limit is sufficient for that. It is
 * NOT a defence against a distributed attacker who already holds the bearer
 * secret — at that point the secret is the problem.
 */
const lastAcceptedAt = new Map<string, number>();

/**
 * Write forwarded log lines to ops_log_events.
 *
 * Returns how many landed. Never throws: see the call site for why a log
 * failure must not fail the whole ingest.
 *
 * Each line is truncated, level-normalised to error|warn|info, and fingerprinted
 * so the explorer can say "this error, 4,812 times" instead of rendering 4,812
 * rows — which is the difference between a usable page and the thing that
 * caused the 60 GB log incident src/lib/log.ts exists to prevent.
 */
async function persistLogs(
  host: string,
  lines: IngestLogLine[],
): Promise<number> {
  if (lines.length === 0) return 0;

  try {
    const now = Date.now();
    const rows = lines.map((line) => {
      const message = line.message.slice(0, MAX_MESSAGE_CHARS);
      const service = line.service.slice(0, 120);
      const level = normaliseLevel(line.level);

      // A line's own timestamp when it parses and is not absurd, else now.
      // A log line dated 1970 or next year would silently poison every "last
      // hour" count on the page.
      const parsed = line.ts ? Date.parse(line.ts) : NaN;
      const loggedAt =
        Number.isFinite(parsed) && Math.abs(now - parsed) < 7 * 86_400_000
          ? new Date(parsed)
          : new Date();

      return {
        host,
        service,
        level,
        message,
        logged_at: loggedAt,
        fingerprint: fingerprint(service, level, message),
        meta: line.ts && !Number.isFinite(parsed) ? { raw_ts: line.ts } : null,
      };
    });

    await db.insert(opsLogEvents).values(rows);
    return rows.length;
  } catch (e) {
    log.error("[ops:ingest] failed to write log events", e);
    return 0;
  }
}

export async function POST(request: NextRequest) {
  const expected = process.env.OPS_INGEST_SECRET;
  if (!expected) {
    // Refuse rather than accept unauthenticated pushes. An ingest endpoint that
    // silently opens up when a var is missing is worse than one that is down.
    log.error("[ops:ingest] OPS_INGEST_SECRET is not set — rejecting");
    return jsonError(503, "Ingest is not configured on this environment");
  }

  const presented = bearerToken(request.headers.get("authorization"));
  if (!secretMatches(presented, expected)) {
    return jsonError(401, "Unauthorized");
  }

  // Size check before reading the body into memory as an object.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return jsonError(413, "Payload too large");
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return jsonError(400, "Could not read body");
  }
  // content-length is client-supplied, so re-check what actually arrived.
  if (!withinBodyCap(text)) {
    return jsonError(413, "Payload too large");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return jsonError(400, "Body must be JSON");
  }

  const parsed = IngestBody.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return jsonError(
      422,
      `${issue?.path?.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
    );
  }
  const body = parsed.data;

  const host = body.host.trim().toLowerCase();
  const allow = allowedHosts();
  if (allow.size === 0) {
    log.error("[ops:ingest] OPS_INGEST_HOSTS is empty — rejecting");
    return jsonError(503, "Ingest is not configured on this environment");
  }
  // An unlisted host would create a whole column of metrics on the dashboard
  // for a box nobody agreed to monitor, so this is a 403 and not a warning.
  if (!isHostAllowed(host, allow)) {
    return jsonError(403, `Host not allowed: ${host}`);
  }

  const clock = checkClock(body.captured_at);
  if (!clock.capturedAt) {
    return jsonError(422, "captured_at is not a valid timestamp");
  }
  if (!clock.ok) {
    return jsonError(
      422,
      `captured_at is ${clock.skewMinutes} minutes from server time (max 10)`,
    );
  }

  const previous = lastAcceptedAt.get(host);
  if (previous != null && Date.now() - previous < MIN_POST_INTERVAL_MS) {
    return NextResponse.json(
      {
        success: false,
        error: { message: "Rate limited: one post per host per minute" },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(
            Math.ceil((MIN_POST_INTERVAL_MS - (Date.now() - previous)) / 1000),
          ),
        },
      },
    );
  }

  const source = `host:${host}`;
  const samples: CollectedSample[] = [];

  // Host vitals. Every field is optional — a box without swap, or an agent that
  // could not read the certificate, sends fewer keys rather than zeros. A zero
  // would render as a real reading and hide the gap.
  for (const [field, value] of Object.entries(body.metrics)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    samples.push({
      metric_key: `host.${field}`,
      source,
      value_num: value,
      captured_at: clock.capturedAt,
    });
  }

  // pm2 processes, one source per process per host, so the same three metrics
  // cover every process on every box without a registry entry each.
  for (const proc of body.processes) {
    const procSource = `proc:${host}:${proc.name}`.slice(0, 80);
    samples.push({
      metric_key: "process.online",
      source: procSource,
      value_num: proc.status.toLowerCase() === "online" ? 1 : 0,
      value_text: proc.status,
      captured_at: clock.capturedAt,
      meta: { host, process: proc.name, uptime_s: proc.uptime_s ?? null },
    });
    if (typeof proc.restarts === "number") {
      samples.push({
        metric_key: "process.restarts",
        source: procSource,
        value_num: proc.restarts,
        captured_at: clock.capturedAt,
        meta: { host, process: proc.name },
      });
    }
    if (typeof proc.mem_mb === "number") {
      samples.push({
        metric_key: "process.mem_mb",
        source: procSource,
        value_num: proc.mem_mb,
        captured_at: clock.capturedAt,
        meta: { host, process: proc.name, cpu_pct: proc.cpu_pct ?? null },
      });
    }
  }

  try {
    const written = await writeSamples(samples);
    // Stamp the throttle only on success, so a failed write does not lock the
    // host out for a minute while the agent is trying to tell us something.
    lastAcceptedAt.set(host, Date.now());

    // Logs are written AFTER the samples and in their own try. Metrics are the
    // load-bearing half of this payload — a malformed log line must not cost us
    // the CPU and disk readings, and the agent has already moved its byte
    // offset past these lines, so failing the whole request would not get them
    // back either.
    const logsPersisted = await persistLogs(host, body.logs);

    return NextResponse.json({
      success: true,
      data: {
        host,
        samples_written: written,
        logs_received: body.logs.length,
        logs_persisted: logsPersisted,
        server_time: new Date().toISOString(),
      },
    });
  } catch (e) {
    // Almost always "relation ops_metric_samples does not exist" — E-210 not
    // applied here. A 500 makes the agent retry on its next cycle, which is the
    // behaviour we want once the migration lands.
    log.error("[ops:ingest] failed to write samples", e);
    return jsonError(
      500,
      e instanceof Error ? e.message : "Failed to persist samples",
    );
  }
}
