/**
 * Billable third-party API volume, per vendor, over 30 days.
 *
 * COUNTS ONLY, never cost. We hold no rate card for these vendors, so a price
 * here would be invented. The count is still the useful half: paired with the
 * billed invoice on /operations/spend it answers "did the bill go up because we
 * used more, or because they charged more?" — which is the question a
 * reconciliation table exists to answer.
 *
 * One declarative probe list rather than one file per vendor. The plan's file
 * map sketched vendors/{razorpay,zoho,kyc,whatsapp,scraper}.ts, but each would
 * have been the same twenty lines around a different COUNT(*), and eight copies
 * of one query is eight places for the 30-day window to drift apart. This
 * mirrors the PROBES table in ../jobs.ts, which solved the same shape.
 *
 * Adding a vendor is still a one-line change — add a probe below and, if it is
 * a new name, an entry in ../../vendors.ts.
 *
 * Every probe is wrapped: these tables drift between environments, and an
 * unapplied migration must cost us one vendor's count, not the whole collector.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { unavailableText } from "@/lib/operations/errors";

import type { CollectedSample, OpsCollector } from "../types";
import { MINUTE } from "../types";

interface UsageProbe {
  /** Canonical vendor slug — must exist in ../../vendors.ts. */
  vendor: string;
  label: string;
  /** Must return one row shaped { n }. Counts the last 30 days. */
  query: ReturnType<typeof sql>;
}

const PROBES: UsageProbe[] = [
  {
    vendor: "decentro",
    label: "Decentro KYC calls",
    // api_provider carries the variant ("decentro", "decentro_digilocker",
    // "decentro_video_liveness"); all bill to the same vendor.
    query: sql`
      SELECT COUNT(*)::int AS n FROM kyc_verifications
      WHERE api_provider LIKE 'decentro%'
        AND created_at > NOW() - INTERVAL '30 days'
    `,
  },
  {
    vendor: "digio",
    label: "DigiO e-sign / KYC calls",
    query: sql`
      SELECT COUNT(*)::int AS n FROM kyc_verifications
      WHERE api_provider = 'digio'
        AND created_at > NOW() - INTERVAL '30 days'
    `,
  },
  {
    vendor: "meta",
    label: "WhatsApp messages",
    // Inbound and outbound both: Meta bills per conversation, and an inbound
    // message is what opens one.
    query: sql`
      SELECT COUNT(*)::int AS n FROM whatsapp_messages
      WHERE created_at > NOW() - INTERVAL '30 days'
    `,
  },
  {
    vendor: "razorpay",
    label: "Razorpay payment attempts",
    // Three surfaces, one gateway. UNION ALL then sum, so a missing table in
    // one of them is caught by the wrapper and costs only this probe.
    query: sql`
      SELECT COALESCE(SUM(n), 0)::int AS n FROM (
        SELECT COUNT(*)::int AS n FROM facilitation_payments
          WHERE created_at > NOW() - INTERVAL '30 days'
        UNION ALL
        SELECT COUNT(*)::int FROM emi_payment_attempts
          WHERE created_at > NOW() - INTERVAL '30 days'
        UNION ALL
        SELECT COUNT(*)::int FROM buyback_gateway_transactions
          WHERE created_at > NOW() - INTERVAL '30 days'
      ) t
    `,
  },
  {
    vendor: "zoho",
    label: "Zoho invoice syncs",
    query: sql`
      SELECT COUNT(*)::int AS n FROM zoho_invoices
      WHERE synced_at > NOW() - INTERVAL '30 days'
    `,
  },
  {
    vendor: "openai",
    label: "LLM runs (risk + security)",
    // Each table stamps its own column: risk_runs and security_scan_runs use
    // started_at, risk_card_runs uses run_at. Assuming a shared name here is
    // exactly the mistake that left ../jobs.ts probing a column risk_card_runs
    // does not have.
    query: sql`
      SELECT COALESCE(SUM(n), 0)::int AS n FROM (
        SELECT COUNT(*)::int AS n FROM risk_runs
          WHERE started_at > NOW() - INTERVAL '30 days'
        UNION ALL
        SELECT COUNT(*)::int FROM risk_card_runs
          WHERE run_at > NOW() - INTERVAL '30 days'
        UNION ALL
        SELECT COUNT(*)::int FROM security_scan_runs
          WHERE started_at > NOW() - INTERVAL '30 days'
      ) t
    `,
  },
  {
    vendor: "firecrawl",
    label: "Scraper runs",
    // scraper_runs counts RUNS, not per-source API calls. Firecrawl, Apify and
    // Google Places are all invoked inside a run and are not attributed
    // individually anywhere — §8.6 of the plan calls that out and defers the
    // call-site instrumentation. Filed under firecrawl as the dominant source;
    // treat it as "scraper activity", not a Firecrawl invoice line.
    query: sql`
      SELECT COUNT(*)::int AS n FROM scraper_runs
      WHERE started_at > NOW() - INTERVAL '30 days'
    `,
  },
];

export const vendorUsageCollector: OpsCollector = {
  id: "vendor.usage",
  label: "Vendor API volume (30d)",
  intervalMs: 60 * MINUTE,
  timeoutMs: 25_000,

  async run(): Promise<CollectedSample[]> {
    const samples: CollectedSample[] = [];

    for (const probe of PROBES) {
      try {
        const result = (await db.execute(probe.query)) as unknown as Array<
          Record<string, unknown>
        >;
        const n = Number(result?.[0]?.n ?? 0);
        samples.push({
          metric_key: "vendor.api_calls_30d",
          source: `vendor:${probe.vendor}`,
          value_num: Number.isFinite(n) ? n : 0,
          meta: { label: probe.label },
        });
      } catch (e) {
        // Almost always "relation does not exist" on an environment that has
        // not had that feature's migration. Record it as text so the page can
        // say "not present here" instead of showing a silent zero, which would
        // read as "we used this vendor zero times".
        samples.push({
          metric_key: "vendor.api_calls_30d",
          source: `vendor:${probe.vendor}`,
          value_num: null,
          value_text: unavailableText(e),
          meta: { label: probe.label, unavailable: true },
        });
      }
    }

    return samples;
  },
};
