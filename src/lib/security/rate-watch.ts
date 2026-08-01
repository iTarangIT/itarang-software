/**
 * Volumetric & behavioural attack detection (E-217).
 *
 * ./detect.ts inspects ONE request for a hostile payload. This module is its
 * complement: it watches the SHAPE of traffic from a single IP over time and
 * catches the attacks that carry no payload at all —
 *
 *   • rate_flood       application-layer DoS / DDoS (request volume)
 *   • path_enumeration directory or endpoint brute-forcing (many distinct paths)
 *   • auth_bruteforce  repeated hammering of the sign-in surface
 *
 * Edge-safe: plain JS + an in-memory Map. No Node APIs, no DB, no I/O.
 *
 * ── Two properties this MUST have ───────────────────────────────────────────
 *
 * 1. **Bounded memory.** One entry per active IP. Stale entries are pruned on
 *    write (no timers exist in the Edge runtime) and the map is hard-capped at
 *    MAX_TRACKED_IPS.
 *
 * 2. **Bounded event writes.** A flood is thousands of requests; writing one
 *    security_event per request would turn the detector itself into the DoS.
 *    Each IP emits at most one event per signal per EMIT_COOLDOWN_MS, and the
 *    evidence carries the observed counts so nothing is lost.
 *
 * ── Scope: visibility, not mitigation ───────────────────────────────────────
 *
 * Counters are per server process. Under PM2 cluster mode each worker keeps its
 * own, so the effective threshold is roughly THRESHOLD × workers; a process
 * restart resets them. That is acceptable because this layer exists to make
 * floods VISIBLE on /it/security/live. Actually absorbing a volumetric
 * attack has to happen upstream of the app — Cloudflare in front of the domain,
 * nginx limit_req on the VPS. By the time middleware runs, the connection has
 * already been accepted and the request parsed.
 */
import type { Severity } from "./severity";

export type RateThreatType = "rate_flood" | "path_enumeration" | "auth_bruteforce";

export interface RateSignal {
  event_type: RateThreatType;
  severity: Severity;
  matched_rule: string;
  action: "blocked" | "logged";
  evidence: Record<string, unknown>;
}

export interface RateInput {
  ip: string | null;
  path: string;
  method: string;
}

/** Counting window. All three thresholds are "per IP within this window". */
const WINDOW_MS = 60_000;
/** One event per IP per signal per this long, however loud the flood is. */
const EMIT_COOLDOWN_MS = 5 * 60_000;
/** Hard cap on tracked IPs, so a spoofed-source flood cannot grow the map without bound. */
const MAX_TRACKED_IPS = 20_000;
/** Cap the per-IP distinct-path set; enumeration is detected well below this. */
const MAX_PATHS_TRACKED = 256;

const DEFAULT_FLOOD = 300;
const DEFAULT_ENUM = 60;
const DEFAULT_AUTH = 15;

/**
 * The sign-in surface. Supabase sign-in happens browser→Supabase directly and
 * never reaches middleware, so this cannot see failed passwords — it sees
 * someone repeatedly loading or posting to the auth routes, which is the part of
 * a credential attack that IS visible here.
 */
const AUTH_PATH = /^\/(login|forgot-password|change-password)(\/|$)|^\/api\/auth\//i;

/** Never count the detector's own report traffic. */
const IGNORED_PATH = /^\/api\/internal\/security-events/;

interface Bucket {
  /** Start of the current counting window (ms). */
  start: number;
  total: number;
  auth: number;
  paths: Set<string>;
  /** Peak `total` seen in any window since this bucket was created. */
  peak: number;
  /** signal type -> last emit time (ms). Survives window rollover. */
  emitted: Partial<Record<RateThreatType, number>>;
}

const buckets = new Map<string, Bucket>();

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Drop entries whose window ended more than two windows ago. Called only when
 * the map exceeds its cap, so the common path stays O(1).
 */
function prune(now: number): void {
  const cutoff = now - WINDOW_MS * 2;
  for (const [ip, b] of buckets) {
    if (b.start < cutoff) buckets.delete(ip);
  }
  // Still over the cap => an active spoofed-source flood. Reset rather than let
  // the map grow; losing counters is strictly better than exhausting memory.
  if (buckets.size > MAX_TRACKED_IPS) buckets.clear();
}

/**
 * Record one request and return a signal if this IP just crossed a threshold
 * (and is not inside its per-signal cooldown). Call on EVERY request — the
 * counters are only meaningful if benign traffic is counted too.
 *
 * Requests with no resolvable IP are ignored: without a source there is nothing
 * to attribute a flood to, and the internal ingest fetch has no forwarded-for
 * header, so this also keeps the reporter from counting itself.
 */
export function trackRequest(input: RateInput): RateSignal | null {
  const ip = input.ip;
  if (!ip || IGNORED_PATH.test(input.path)) return null;

  const now = Date.now();
  let b = buckets.get(ip);

  if (!b) {
    if (buckets.size >= MAX_TRACKED_IPS) prune(now);
    b = { start: now, total: 0, auth: 0, paths: new Set(), peak: 0, emitted: {} };
    buckets.set(ip, b);
  } else if (now - b.start >= WINDOW_MS) {
    // Roll the window. `emitted` and `peak` deliberately carry over.
    b.start = now;
    b.total = 0;
    b.auth = 0;
    b.paths.clear();
  }

  b.total += 1;
  if (b.total > b.peak) b.peak = b.total;
  if (b.paths.size < MAX_PATHS_TRACKED) b.paths.add(input.path);
  if (AUTH_PATH.test(input.path)) b.auth += 1;

  const elapsedSec = Math.max(1, Math.round((now - b.start) / 1000));
  const blockFloods = process.env.SECURITY_RATE_BLOCK === "1";

  // Priority: volume first (the loudest signal), then credential attacks, then
  // enumeration. Only one event per request.
  const floodLimit = envInt("SECURITY_RATE_FLOOD_PER_MIN", DEFAULT_FLOOD);
  if (b.total >= floodLimit && canEmit(b, "rate_flood", now)) {
    return {
      event_type: "rate_flood",
      severity: "high",
      matched_rule: `rate-flood:${floodLimit}/min`,
      // Blocking is opt-in: a shared NAT (a dealer's office behind one IP) can
      // legitimately produce a lot of requests, and a 403 there is worse than a
      // log line. Upstream rate limiting is the real mitigation.
      action: blockFloods ? "blocked" : "logged",
      evidence: {
        requests: b.total,
        window_sec: elapsedSec,
        threshold_per_min: floodLimit,
        distinct_paths: b.paths.size,
        peak_in_window: b.peak,
        note: "Request volume from a single IP. Counters are per server process.",
      },
    };
  }

  const authLimit = envInt("SECURITY_RATE_AUTH_PER_MIN", DEFAULT_AUTH);
  if (b.auth >= authLimit && canEmit(b, "auth_bruteforce", now)) {
    return {
      event_type: "auth_bruteforce",
      severity: "high",
      matched_rule: `auth-bruteforce:${authLimit}/min`,
      action: "logged",
      evidence: {
        auth_requests: b.auth,
        window_sec: elapsedSec,
        threshold_per_min: authLimit,
        note: "Repeated hits on the sign-in surface. Supabase password checks happen browser→Supabase and are not visible here.",
      },
    };
  }

  const enumLimit = envInt("SECURITY_RATE_PATHS_PER_MIN", DEFAULT_ENUM);
  if (b.paths.size >= enumLimit && canEmit(b, "path_enumeration", now)) {
    return {
      event_type: "path_enumeration",
      severity: "medium",
      matched_rule: `path-enumeration:${enumLimit}/min`,
      action: "logged",
      evidence: {
        distinct_paths: b.paths.size,
        requests: b.total,
        window_sec: elapsedSec,
        threshold_per_min: enumLimit,
        sample_paths: Array.from(b.paths).slice(0, 15),
      },
    };
  }

  return null;
}

function canEmit(b: Bucket, type: RateThreatType, now: number): boolean {
  const last = b.emitted[type];
  if (last && now - last < EMIT_COOLDOWN_MS) return false;
  b.emitted[type] = now;
  return true;
}

/** Test seam — clears all counters. Not used by the middleware. */
export function __resetRateWatch(): void {
  buckets.clear();
}
