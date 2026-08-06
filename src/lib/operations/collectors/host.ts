/**
 * Host agent liveness.
 *
 * The host vitals themselves are PUSHED — ops-agent/agent.js posts them to
 * /api/operations/ingest/host, which writes the samples. There is nothing for a
 * collector to pull.
 *
 * What a collector can do, and what this one does, is watch for the push not
 * arriving. `host.agent_age_min` is the metric that says every other number for
 * a host is stale. Without it, a dead agent looks exactly like a healthy box
 * whose numbers happen not to have changed — the dashboard keeps rendering the
 * last good CPU reading forever, in green.
 *
 * It emits a row for every host in OPS_INGEST_HOSTS rather than only for hosts
 * that have reported. A box that has never posted must appear on the page as a
 * problem, not as an absence.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import type { CollectedSample, OpsCollector } from "./types";
import { MINUTE } from "./types";

/**
 * The configured hosts. Same env var the ingest route validates against, so the
 * page cannot show a host the server would reject a push from.
 */
export function configuredHosts(): string[] {
  return (process.env.OPS_INGEST_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** Never reported at all. Distinct from "reported a long time ago". */
const NEVER_SEEN_MINUTES = 100_000;

export const hostCollector: OpsCollector = {
  id: "infra.host",
  label: "Host agent liveness",
  intervalMs: 5 * MINUTE,

  async run(): Promise<CollectedSample[]> {
    const hosts = configuredHosts();
    if (hosts.length === 0) {
      // Not an error: an environment with no agents deployed yet has nothing to
      // watch. Emitting nothing is honest; emitting zeros would not be.
      return [];
    }

    const sources = hosts.map((h) => `host:${h}`);

    // One query for every host. Bounded by the same 7-day window the samples
    // table is pruned well inside, so a host that vanished a month ago does not
    // make this scan history it will never find anything in.
    const rows = (await db.execute(sql`
      SELECT source, MAX(captured_at) AS last_at
      FROM ops_metric_samples
      WHERE source IN ${sources}
        AND captured_at > NOW() - INTERVAL '7 days'
      GROUP BY source
    `)) as unknown as Array<Record<string, unknown>>;

    const lastSeen = new Map<string, Date>();
    for (const r of rows) {
      if (r.last_at) {
        lastSeen.set(r.source as string, new Date(r.last_at as string));
      }
    }

    return hosts.map((host): CollectedSample => {
      const at = lastSeen.get(`host:${host}`);
      const minutes = at
        ? Math.max(0, Math.round((Date.now() - at.getTime()) / 60_000))
        : NEVER_SEEN_MINUTES;

      return {
        metric_key: "host.agent_age_min",
        source: `host:${host}`,
        value_num: minutes,
        value_text: at ? null : "never reported",
        meta: {
          host,
          last_seen_at: at?.toISOString() ?? null,
          // The agent posts every 5 minutes; the warn threshold is 15. Carried
          // in meta so the page can explain the number without re-deriving it.
          expected_interval_min: 5,
        },
      };
    });
  },
};
