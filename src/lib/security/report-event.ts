/**
 * Edge-safe reporter: ships a detected event from the middleware (Edge runtime,
 * no DB access) to the Node ingest route that writes it to Postgres.
 *
 * Fetch-only, best-effort, never throws. Requires SECURITY_INTERNAL_SECRET —
 * without it the reporter is a no-op (the ingest route rejects unsigned posts),
 * which is the off switch for the whole live-detection feature.
 */
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
  evidence: Record<string, unknown>;
}

export async function postSecurityEvent(origin: string, payload: SecurityEventPayload): Promise<void> {
  const secret = process.env.SECURITY_INTERNAL_SECRET;
  if (!secret) return; // feature disabled until the secret is set
  try {
    await fetch(`${origin}/api/internal/security-events`, {
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
