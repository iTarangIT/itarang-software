/**
 * Rate-limited console logger.
 *
 * Context: on 2026-04-23 the sandbox worker printed the same Redis rate-limit
 * stack trace ~200 times/second for hours, producing a 60 GB log file and
 * filling the VPS disk. The structural defence is to dedupe by message
 * signature so a single bug can never amplify into unbounded stderr volume.
 *
 * Shape: `log.info/warn/error(msg, meta?)`. First occurrence of each `msg`
 * signature emits immediately. Subsequent occurrences within `WINDOW_MS`
 * increment a counter silently. When the window closes a single summary
 * line is emitted: `[dedupe] "<msg>" ×N more in last 30s`.
 *
 * `meta` is printed verbatim on the first occurrence and ignored for keying —
 * we explicitly want `log.error("X", {attempt: 1})` and `log.error("X", {attempt: 2})`
 * to dedupe together; that is the scenario that produced 60 GB.
 */

type Level = "info" | "warn" | "error";

const WINDOW_MS = 30_000;
const MAX_ENTRIES = 200;

type Entry = { level: Level; count: number; firstAt: number; timer: NodeJS.Timeout };

const buckets = new Map<string, Entry>();

function flush(msg: string) {
  const entry = buckets.get(msg);
  if (!entry) return;
  buckets.delete(msg);
  if (entry.count > 1) {
    console[entry.level](`[dedupe] "${msg}" ×${entry.count - 1} more in last ${Math.round(WINDOW_MS / 1000)}s`);
  }
}

function evictIfFull() {
  if (buckets.size < MAX_ENTRIES) return;
  // LRU-ish — evict the oldest-firstAt entry so a hostile key cannot leak memory.
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [k, v] of buckets) {
    if (v.firstAt < oldestAt) {
      oldestAt = v.firstAt;
      oldestKey = k;
    }
  }
  if (oldestKey) {
    const entry = buckets.get(oldestKey)!;
    clearTimeout(entry.timer);
    flush(oldestKey);
  }
}

function emit(level: Level, msg: string, meta?: unknown) {
  const existing = buckets.get(msg);
  if (existing) {
    existing.count += 1;
    return;
  }
  evictIfFull();
  if (meta !== undefined) console[level](msg, meta);
  else console[level](msg);
  const timer = setTimeout(() => flush(msg), WINDOW_MS);
  // Don't hold the event loop open just for the summary timer.
  if (typeof timer.unref === "function") timer.unref();
  buckets.set(msg, { level, count: 1, firstAt: Date.now(), timer });
}

export const log = {
  info(msg: string, meta?: unknown) {
    emit("info", msg, meta);
  },
  warn(msg: string, meta?: unknown) {
    emit("warn", msg, meta);
  },
  error(msg: string, meta?: unknown) {
    emit("error", msg, meta);
  },
  /** Test-only — clear all buckets. Not exported as part of the public surface. */
  _reset() {
    for (const entry of buckets.values()) clearTimeout(entry.timer);
    buckets.clear();
  },
};
