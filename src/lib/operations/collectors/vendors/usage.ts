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
];

/**
 * THREE PROBES WERE REMOVED HERE, DELIBERATELY. They are recorded rather than
 * deleted silently, because "why doesn't the console track OpenAI?" is a
 * question somebody will ask.
 *
 *   zoho      — counted rows in `zoho_invoices` where synced_at was recent.
 *               That is OUR sync activity, not Zoho API billing. The number
 *               moved when our cron ran, not when Zoho charged us.
 *   openai    — counted risk_runs + risk_card_runs + security_scan_runs. Those
 *               are LLM runs in general, and this codebase's LLM work is
 *               largely Anthropic. It attributed Anthropic's usage to OpenAI
 *               and rendered it beside OpenAI's invoice as a reconciliation.
 *   firecrawl — counted scraper_runs. The comment shipped with it said to
 *               "treat it as scraper activity, not a Firecrawl invoice line",
 *               which is an accurate description of a number that should not
 *               have been in a billing reconciliation table.
 *
 * Each produced a plausible-looking row in Metered vs Billed that could not be
 * reconciled against anything, which is worse than an absent row: an absent row
 * says "not measured", and a wrong one says "measured, and it disagrees".
 *
 * Restoring any of them needs real per-call attribution at the call site
 * (§8.6 of the plan), not a proxy count.
 */

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
