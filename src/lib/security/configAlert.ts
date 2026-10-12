// Tracker ID 130 — tell Admin when a protection is missing its secret.
//
// A webhook with no secret configured is accepted unverified (or refused under
// WEBHOOK_AUTH_STRICT), and a cron route with no CRON_SECRET refuses every
// call. Either way the fix is an env var on the server, and a log line nobody
// reads is how these stayed open for months. So: one bell notification to every
// admin, at most once an hour per route per process.
//
// The DB is imported lazily so webhookAuth.ts / cron-auth.ts stay
// dependency-free for their unit tests, and nothing is sent under vitest.
// Best-effort: never throws, never awaited by the caller.

const ONE_HOUR = 60 * 60_000;
const lastAlerted = new Map<string, number>();

export function alertMissingSecret(route: string, what: string): void {
  if (process.env.NODE_ENV === "test") return;
  const now = Date.now();
  if (now - (lastAlerted.get(route) ?? 0) < ONE_HOUR) return;
  lastAlerted.set(route, now);

  void import("@/lib/notifications/notify")
    .then(({ notifyRoles }) =>
      notifyRoles(["admin"], {
        type: "security.secret_missing",
        title: `Security setting missing: ${route}`,
        message: what,
        data: { route },
      }),
    )
    .catch((e) => console.error("[security] could not alert admins:", e instanceof Error ? e.message : e));
}
