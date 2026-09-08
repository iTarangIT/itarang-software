/**
 * E-280 — the browser half of a Drive "Scan now" button.
 *
 * Two jobs, both learned from the same incident: a CEO pressed Scan Drive and
 * got `Unexpected token '<', "<html> <h"... is not valid JSON` — while the scan
 * behind it had actually imported two invoices before the app was restarted
 * under the open request by a deploy.
 *
 *  1. NEVER call `.json()` on a response without knowing it is JSON. nginx
 *     answers with its own HTML page when the app is restarting or unreachable,
 *     and a raw parse error tells the person nothing about which of the two
 *     happened, or whether their scan ran.
 *  2. Follow a scan that reports itself as `started` by polling, so the button
 *     does not have to hold a multi-minute connection open to learn the answer.
 *     A scan endpoint that still answers synchronously (the expense side) needs
 *     no `statusEndpoint` and behaves exactly as before.
 *
 * Client-only: no server imports, so a "use client" component can pull it in.
 */

/**
 * A scan's outcome as the UI needs it. Union of what a finished run reports and
 * the two in-between states — `started` from the POST, `running` from a poll.
 */
export interface ScanRunResult {
  run_id?: string | null;
  status: "success" | "failed" | "skipped" | "started" | "running";
  folders_scanned?: number;
  files_seen: number;
  files_new: number;
  imported: number;
  skipped_duplicate: number;
  needs_attention: number;
  unsupported?: number;
  failed: number;
  duration_ms?: number;
  error?: string;
  skipped_reason?: string;
}

/** Poll cadence. One tiny indexed read per tick; the scan itself is minutes. */
const POLL_INTERVAL_MS = 4_000;

/**
 * Give up after this long WITHOUT the counters moving.
 *
 * Deliberately idle time, not wall-clock. A draining scan runs until the folder
 * is finished — far past any fixed ceiling — and the old wall-clock limit would
 * have declared a healthy 20-minute drain "interrupted" at minute ten, in front
 * of the person watching it work. What actually signals a dead run is silence:
 * the scanner flushes its counters every few files, so nothing moving for ten
 * minutes means nothing is running.
 */
const POLL_IDLE_CEILING_MS = 10 * 60_000;

/** Absolute backstop, so a stuck-but-chatty run cannot poll for ever. */
const POLL_ABSOLUTE_CEILING_MS = 3 * 60 * 60_000;

/** Counters as one string: if this changes, the run is alive. */
function progressFingerprint(r: ScanRunResult): string {
  return [
    r.files_seen,
    r.files_new,
    r.imported,
    r.skipped_duplicate,
    r.needs_attention,
    r.unsupported ?? 0,
    r.failed,
  ].join("|");
}

/** Consecutive failed polls tolerated before giving up. */
const POLL_FAILURES_ALLOWED = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Why the server sent a page instead of data. The status code is the only thing
 * that distinguishes "we are mid-deploy" from "you have been signed out", and
 * it is exactly what the raw JSON parse error threw away.
 */
function describeNonJson(status: number): string {
  if (status === 502 || status === 503) {
    return `The app restarted while it was answering (HTTP ${status}) — a deploy usually causes this. Anything already imported was kept; press the button again in a minute.`;
  }
  if (status === 504) {
    return "The server took too long to answer (HTTP 504). The scan may still be running in the background.";
  }
  if (status === 401 || status === 403) {
    return "Your session is no longer valid — sign in again.";
  }
  if (status === 413) return "That request was too large for the server.";
  if (status >= 500) return `The server returned an error page (HTTP ${status}).`;
  return `The server sent a page instead of data (HTTP ${status}).`;
}

/**
 * Read a JSON API response, or throw an error a person can act on.
 *
 * Takes the body as text first: `.json()` on an HTML error page throws a
 * SyntaxError quoting the first few characters of the markup, which is how
 * `Unexpected token '<'` ends up in front of a CEO.
 */
export async function readJsonBody<T = unknown>(
  r: Response,
  fallbackMessage: string,
): Promise<T> {
  const text = await r.text();

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(describeNonJson(r.status));
  }

  const body = json as { success?: boolean; error?: { message?: string } };
  if (!r.ok || body?.success === false) {
    throw new Error(body?.error?.message || fallbackMessage);
  }
  return json as T;
}

/** The same, for the routes that wrap their payload in `{ success, data }`. */
export async function readJsonData<T = unknown>(
  r: Response,
  fallbackMessage: string,
): Promise<T> {
  const body = await readJsonBody<{ data: T }>(r, fallbackMessage);
  return body.data;
}

/**
 * Press "Scan now" and come back with what happened.
 *
 * Resolves when the scan has finished, was refused (nothing configured, one
 * already running), or stopped reporting. Never resolves with `started`: that
 * is an internal state, and a caller asking "what happened" deserves an answer.
 */
export async function startScanAndWait(opts: {
  scanEndpoint: string;
  /** Same route, GET ?run_id=. Omit for an endpoint that answers synchronously. */
  statusEndpoint?: string;
  body?: Record<string, unknown>;
  /** Called on every poll, so a caller can show progress rather than a spinner. */
  onProgress?: (result: ScanRunResult) => void;
}): Promise<ScanRunResult> {
  const r = await fetch(opts.scanEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts.body ?? {}),
  });
  const first = await readJsonData<ScanRunResult>(r, "Scan failed");

  if (first.status !== "started" || !opts.statusEndpoint) return first;

  const runId = first.run_id;
  if (!runId) return first;

  const url = `${opts.statusEndpoint}${opts.statusEndpoint.includes("?") ? "&" : "?"}run_id=${encodeURIComponent(runId)}`;
  const absoluteDeadline = Date.now() + POLL_ABSOLUTE_CEILING_MS;
  let idleDeadline = Date.now() + POLL_IDLE_CEILING_MS;
  let consecutiveFailures = 0;
  let last: ScanRunResult = { ...first, status: "running" };
  let fingerprint = progressFingerprint(last);

  while (Date.now() < idleDeadline && Date.now() < absoluteDeadline) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const res = await fetch(url, { cache: "no-store" });
      const run = await readJsonData<ScanRunResult>(res, "Could not read the scan's progress");
      consecutiveFailures = 0;
      last = run;

      // Any counter moving proves the scan is alive, however long it has been
      // going — that is what lets a drain outlive the idle ceiling.
      const next = progressFingerprint(run);
      if (next !== fingerprint) {
        fingerprint = next;
        idleDeadline = Date.now() + POLL_IDLE_CEILING_MS;
      }

      opts.onProgress?.(run);
      if (run.status !== "running") return run;
    } catch {
      // A restart mid-scan breaks the polls too. One bad read is not an answer;
      // several in a row is, and the run row will say so once a later scan
      // closes it out as abandoned.
      consecutiveFailures += 1;
      if (consecutiveFailures >= POLL_FAILURES_ALLOWED) {
        return {
          ...last,
          status: "failed",
          error:
            "Lost contact with the server while the scan was running — it was probably restarted. Anything already imported was kept; press the button again to carry on from there.",
        };
      }
    }
  }

  return {
    ...last,
    status: "failed",
    error:
      Date.now() >= absoluteDeadline
        ? "The scan has been running for over three hours, so this page stopped following it. It may still be working — reload to see where it got to."
        : "The scan has made no progress for 10 minutes, so it was most likely interrupted. Anything already imported was kept; press the button again to carry on from there.",
  };
}
