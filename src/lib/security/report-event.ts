/**
 * Edge-safe reporter: ships a detected event from the middleware (Edge runtime,
 * no DB access) to the Node ingest route that writes it to Postgres.
 *
 * Fetch-only, best-effort, never throws. Requires SECURITY_INTERNAL_SECRET —
 * without it the reporter is a no-op (the ingest route rejects unsigned posts),
 * which is the off switch for the whole live-detection feature.
 */

/** Path of the Node ingest route. Exported so the middleware can exempt it from
 *  its own detection — see ingestOrigin() and the guard in src/middleware.ts. */
export const SECURITY_INGEST_PATH = "/api/internal/security-events";

/**
 * Where to POST the event.
 *
 * NOT simply the request's own origin. Behind a TLS-terminating proxy that
 * doesn't set `X-Forwarded-Proto` (CloudPanel/nginx on the sandbox VPS),
 * `request.nextUrl.origin` comes out as `http://<host>` — nginx answers that
 * with a 301 to https, a 301 rewrites POST to GET, the ingest route has no GET
 * handler, and the event dies as a 405 that the catch below swallows. Symptom:
 * detection is demonstrably on, every probe is detected, and the Live Attacks
 * table stays empty forever.
 *
 * Resolution order:
 *   1. SECURITY_INGEST_ORIGIN — explicit override, wins always.
 *   2. http://127.0.0.1:$PORT — self-hosted (standalone server.js + pm2 sets
 *      PORT). Loopback skips TLS, nginx, DNS and any redirect, so it also fits
 *      comfortably inside the 2.5s abort below.
 *   3. The request origin — platforms with no fixed local port (e.g. Vercel),
 *      where the previous behaviour is correct.
 */
function ingestOrigin(requestOrigin: string): string {
  const override = process.env.SECURITY_INGEST_ORIGIN;
  if (override) return override.replace(/\/+$/, "");
  const port = process.env.PORT;
  if (port) return `http://127.0.0.1:${port}`;
  return requestOrigin;
}

export interface SecurityEventPayload {
  event_type: string;
  severity: string;
  action: "blocked" | "logged";
  ip: string | null;
  actor_user_id: string | null;
  actor_role: string | null;
  method: string;
  path: string;
  query: string | null;
  user_agent: string | null;
  matched_rule: string;
  /**
   * Marks the event as raised by the detector on a real request, as opposed to
   * hand-POSTed to the ingest route. The ingest route uses it to decide whether
   * `ip` is an OBSERVED address or merely a claimed one — see the provenance
   * block there. Only the middleware may set this.
   */
  reporter?: "middleware";
  evidence: Record<string, unknown>;
}

export async function postSecurityEvent(origin: string, payload: SecurityEventPayload): Promise<void> {
  const secret = process.env.SECURITY_INTERNAL_SECRET;
  if (!secret) return; // feature disabled until the secret is set
  try {
    await fetch(`${ingestOrigin(origin)}${SECURITY_INGEST_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify(payload),
      // Bound it: this is on the request path for a flagged request, and the
      // attacker is the one who waits, but we never hang the pipeline.
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    /* best effort — a dropped event must never affect the request */
  }
}
