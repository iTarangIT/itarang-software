/**
 * Auto-block: stop an attacker instead of only recording them.
 *
 * ./detect.ts already refuses the ONE request that carried a hostile payload —
 * but the attacker's next request, with the payload rewritten to slip past the
 * regex, is served normally. That is the gap this closes: once an IP has proven
 * hostile, every subsequent request from it is refused for a while, whatever it
 * contains.
 *
 * ── Strike accounting ───────────────────────────────────────────────────────
 * Only HIGH-CONFIDENCE events count as strikes — the rules that already decided
 * to block (`action: "blocked"`). Soft signals (`sensitive_unauth`,
 * `open_redirect`, a request flood from a shared NAT) never ban anyone; those
 * fire on legitimate traffic often enough that banning on them would lock out
 * real dealers. A `critical` event (JNDI/Log4Shell) bans on the first hit —
 * that payload has no innocent explanation.
 *
 * Repeat offenders escalate: each fresh ban for the same IP doubles the previous
 * duration, up to MAX_BAN_MS.
 *
 * ── Two safety properties ───────────────────────────────────────────────────
 *
 * 1. **Only public addresses are ever banned.** If nginx stops setting
 *    X-Real-IP, every request resolves to the same loopback address; banning it
 *    would take the entire CRM offline for every user simultaneously. isPublicIp()
 *    makes that outcome unreachable, and SECURITY_BLOCK_ALLOWLIST covers the
 *    office / known-good addresses on top.
 *
 * 2. **Bounded memory.** One entry per banned IP, pruned on write, hard-capped.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * State is per server process and in-memory (the Edge runtime has no timers and
 * no shared store), same as ./rate-watch.ts. A PM2 restart clears it, and under
 * cluster mode each worker counts separately. For an application-layer defence
 * that is the right trade: it costs one Map lookup per request and needs no
 * infrastructure. Absorbing a real distributed attack still belongs upstream at
 * nginx/Cloudflare — this stops the single determined prober, which is the
 * threat that actually reaches this app.
 */
import { isPublicIp } from "./fingerprint";
import type { Severity } from "./severity";

export interface BlockRecord {
  /** Epoch ms when the ban lifts. */
  until: number;
  /** Human-readable reason, shown in the event evidence and the UI. */
  reason: string;
  /** Blockable events seen from this IP in the current window. */
  strikes: number;
  /** How many times this IP has been banned (drives the escalating duration). */
  bans: number;
  /** Event types that earned the strikes, for the evidence trail. */
  types: string[];
}

interface Entry extends BlockRecord {
  /** Start of the current strike window (epoch ms). */
  windowStart: number;
  /** Last time we emitted an `ip_blocked` event for this IP, so a banned
   *  attacker hammering us doesn't write one row per request. */
  lastEmit: number;
}

const STRIKE_WINDOW_MS = 10 * 60_000;
const MAX_BAN_MS = 24 * 60 * 60_000;
/** One `ip_blocked` event per IP per this long while the ban is active. */
const EMIT_COOLDOWN_MS = 5 * 60_000;
const MAX_TRACKED = 10_000;

const entries = new Map<string, Entry>();

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Blocking is ON by default once detection is enabled — a detector that watches
 * an attack without stopping it is only half the feature. `SECURITY_AUTO_BLOCK=0`
 * is the escape hatch if a false positive ever locks someone out.
 */
export function autoBlockEnabled(): boolean {
  return process.env.SECURITY_AUTO_BLOCK !== "0";
}

/** Addresses that must never be banned, whatever they send (office egress, monitoring). */
function allowlisted(ip: string): boolean {
  const raw = process.env.SECURITY_BLOCK_ALLOWLIST;
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((entry) => ip === entry || (entry.endsWith(".") && ip.startsWith(entry)));
}

function prune(now: number): void {
  for (const [ip, e] of entries) {
    // Keep a lapsed ban around for one strike window so the escalation counter
    // survives an attacker who pauses and comes back.
    if (e.until < now && now - e.windowStart > STRIKE_WINDOW_MS * 3) entries.delete(ip);
  }
  if (entries.size > MAX_TRACKED) entries.clear();
}

/**
 * Is this IP currently banned? Called on EVERY request, so it is one Map lookup
 * and nothing else.
 */
export function checkBlocked(ip: string | null): BlockRecord | null {
  if (!ip || !autoBlockEnabled()) return null;
  const e = entries.get(ip);
  if (!e) return null;
  if (e.until <= Date.now()) return null;
  return { until: e.until, reason: e.reason, strikes: e.strikes, bans: e.bans, types: e.types };
}

/**
 * Should we write an `ip_blocked` event for this refused request? True at most
 * once per IP per EMIT_COOLDOWN_MS — the ban itself is the defence, the event is
 * just the record of it.
 */
export function shouldEmitBlockEvent(ip: string): boolean {
  const e = entries.get(ip);
  if (!e) return false;
  const now = Date.now();
  if (now - e.lastEmit < EMIT_COOLDOWN_MS) return false;
  e.lastEmit = now;
  return true;
}

/**
 * Record one hostile event against an IP and ban it if it has now crossed the
 * threshold. Returns the ban record when THIS call is what triggered the ban
 * (so the caller can attach it to the event evidence), otherwise null.
 *
 * Call only for events the detector already chose to block, or critical ones.
 */
export function recordStrike(
  ip: string | null,
  eventType: string,
  severity: Severity,
): BlockRecord | null {
  if (!ip || !autoBlockEnabled()) return null;
  // Never ban our own proxy, a health check, or a known-good address. See the
  // safety note in the module header — this is the guard that keeps a
  // misconfigured nginx from taking the whole CRM down.
  if (!isPublicIp(ip) || allowlisted(ip)) return null;

  const now = Date.now();
  let e = entries.get(ip);
  if (!e) {
    if (entries.size >= MAX_TRACKED) prune(now);
    e = { until: 0, reason: "", strikes: 0, bans: 0, types: [], windowStart: now, lastEmit: 0 };
    entries.set(ip, e);
  } else if (now - e.windowStart > STRIKE_WINDOW_MS && e.until <= now) {
    // Window expired and no ban is running — start counting again, but keep
    // `bans` so a returning offender still escalates.
    e.windowStart = now;
    e.strikes = 0;
    e.types = [];
  }

  e.strikes += 1;
  if (!e.types.includes(eventType)) e.types.push(eventType);

  // Log4Shell and friends: one is enough.
  const threshold = severity === "critical" ? 1 : envInt("SECURITY_AUTO_BLOCK_STRIKES", 3);
  if (e.strikes < threshold) return null;

  // Already serving a ban — extend nothing, the existing one stands.
  if (e.until > now) return null;

  const baseMin = envInt("SECURITY_AUTO_BLOCK_MINUTES", 30);
  const duration = Math.min(baseMin * 60_000 * Math.pow(2, e.bans), MAX_BAN_MS);
  e.bans += 1;
  e.until = now + duration;
  e.reason =
    severity === "critical"
      ? `Critical attack (${eventType}) — banned immediately on first hit.`
      : `${e.strikes} blocked attack${e.strikes === 1 ? "" : "s"} from this IP within ${Math.round(STRIKE_WINDOW_MS / 60_000)} minutes (${e.types.join(", ")}).`;
  // Let the ban itself be reported straight away.
  e.lastEmit = 0;

  return { until: e.until, reason: e.reason, strikes: e.strikes, bans: e.bans, types: e.types };
}

/** Test seam — clears all bans. Not used by the middleware. */
export function __resetBlocklist(): void {
  entries.clear();
}
