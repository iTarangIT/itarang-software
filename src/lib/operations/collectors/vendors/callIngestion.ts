/**
 * How long since a provider call was last recorded.
 *
 * THE MONITOR THAT WOULD HAVE CAUGHT THE AUGUST 2026 OUTAGE ON DAY ONE.
 * Between 2026-06-22 and 2026-08-25, ElevenLabs handled 738 conversations in
 * August alone — billed, with 10,819 seconds of talk time — and ai_call_logs
 * received not one row. Nothing anywhere in the product said so. The Ops
 * Console reported ₹0 and 0 calls, which is indistinguishable from a quiet
 * month, and the credits tile kept working because it reads the vendor API
 * directly and never needed the table.
 *
 * DELIBERATELY ITS OWN COLLECTOR, not a metric bolted onto vendor.elevenlabs.
 * That one calls the vendor API and throws when the vendor is unreachable, and
 * the runner persists nothing from a run that threw. Folding this in would mean
 * a vendor outage also silenced the signal that says ingestion is broken —
 * which is precisely the coupling that let the failure hide. This reads one
 * local table and has no third-party dependency at all.
 *
 * Measured on ended_at rather than created_at: ended_at is the column every
 * date-bounded query on /operations/elevenlabs buckets by, so this reports the
 * freshness of the data the dashboard actually renders, not of row-writing in
 * the abstract.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { rootCauseMessage } from "@/lib/operations/errors";

import type { CollectedSample, OpsCollector } from "../types";
import { MINUTE } from "../types";

/** Providers that write ai_call_logs. One sample each, so they alert apart. */
const PROVIDERS = ["elevenlabs", "bolna"] as const;

const MS_PER_DAY = 86_400_000;

export const callIngestionCollector: OpsCollector = {
  id: "vendor.call_ingestion",
  label: "Call-log ingestion freshness",
  // Nothing here moves fast, and the failure it detects is measured in days.
  intervalMs: 30 * MINUTE,
  timeoutMs: 15_000,

  async run(): Promise<CollectedSample[]> {
    const samples: CollectedSample[] = [];

    for (const provider of PROVIDERS) {
      try {
        const rows = (await db.execute(sql`
          SELECT MAX(ended_at) AS last_ended
          FROM ai_call_logs
          WHERE provider = ${provider} AND ended_at IS NOT NULL
        `)) as unknown as Array<{ last_ended: string | Date | null }>;

        const raw = rows[0]?.last_ended;
        if (!raw) {
          // No call has EVER been recorded for this provider. That is a
          // deployment fact on a fresh database, not a stall, and reporting a
          // huge age for it would cry wolf on every new environment.
          continue;
        }

        const lastEnded = raw instanceof Date ? raw : new Date(raw);
        if (Number.isNaN(lastEnded.getTime())) continue;

        const ageDays = (Date.now() - lastEnded.getTime()) / MS_PER_DAY;
        samples.push({
          metric_key: "vendor.call_log_age_days",
          source: `vendor:${provider}`,
          // Never negative: a clock skew between the app and RDS should read as
          // "fresh", not as a nonsensical value that looks like a bug here.
          value_num: Math.max(0, Math.round(ageDays * 10) / 10),
          meta: { last_ended_at: lastEnded.toISOString(), provider },
        });
      } catch (err) {
        // One provider's probe failing must not cost the other's. Omitted
        // rather than zeroed — 0 days would read as perfectly fresh, the most
        // reassuring possible lie about a staleness metric.
        console.error(
          `[ops:call_ingestion] ${provider} probe failed:`,
          rootCauseMessage(err),
        );
      }
    }

    return samples;
  },
};
