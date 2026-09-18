/**
 * Pile B workpack (E-296 / E-297 / E-298) — READ-ONLY smoke check against the
 * DB in DATABASE_URL. Forces default_transaction_read_only=on on the
 * connection, so any accidental write fails instead of landing.
 *
 *   node --import tsx --env-file=.env.local scripts/_verify-pile-b.ts
 */
export {};

const base = process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL =
  base + (base.includes("?") ? "&" : "?") + "default_transaction_read_only=on";

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];
const pass = (name: string, detail = "") => {
  steps.push({ name, ok: true, detail });
  console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ""}`);
};
const fail = (name: string, detail = "") => {
  steps.push({ name, ok: false, detail });
  console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`);
};
const warn = (name: string, detail = "") => console.log(`  ⚠ ${name}${detail ? ` — ${detail}` : ""}`);
const msg = (e: unknown) => {
  const x = e as { message?: string; cause?: { message?: string } };
  return (x?.cause?.message ?? x?.message ?? String(e)).split("\n")[0];
};

async function main() {
  const { db } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");

  const ro = (await db.execute(sql`SHOW default_transaction_read_only`)) as unknown as {
    default_transaction_read_only: string;
  }[];
  if (ro[0]?.default_transaction_read_only !== "on") throw new Error("read-only guard not active — aborting");
  pass("connection is read-only");

  // ── Migration state ─────────────────────────────────────────────
  console.log("\nMigration state");
  const cols = (await db.execute(sql`
    SELECT table_name || '.' || column_name AS c FROM information_schema.columns
     WHERE (table_name='dealer_leads' AND column_name='business_type')
        OR (table_name='quotation_dispatches' AND column_name='cc_recipients')
        OR (table_name='loan_sanctions' AND column_name LIKE 'dealer_payment_%')
  `)) as unknown as { c: string }[];
  const have = new Set(cols.map((r) => r.c));
  const e296 = have.has("dealer_leads.business_type");
  const e297 = have.has("quotation_dispatches.cc_recipients");
  const e298 = have.has("loan_sanctions.dealer_payment_status");
  (e296 ? pass : warn)("E-296 dealer_leads.business_type", e296 ? "applied" : "NOT applied");
  (e297 ? pass : warn)("E-297 quotation_dispatches.cc_recipients", e297 ? "applied" : "NOT applied");
  (e298 ? pass : warn)("E-298 loan_sanctions.dealer_payment_*", e298 ? `applied (${[...have].filter((c) => c.startsWith("loan_sanctions")).length}/7 cols)` : "NOT applied");

  // ── Items 2/3/7: lead list, business type ──────────────────────
  console.log("\nLead list / business type (items 2, 3, 7)");
  const lq = await import("@/lib/leads/leadListQuery");
  const baseFilters = { page: 1, limit: 5 } as unknown as Parameters<typeof lq.fetchLeadListRows>[0];
  try {
    const rows = await lq.fetchLeadListRows(baseFilters, 1, 5);
    pass("fetchLeadListRows (no filter)", `${rows.length} rows`);
    const bt = await lq.fetchBusinessTypeForLeads(rows.map((r) => (r as { id: string }).id));
    pass("fetchBusinessTypeForLeads degrades/works", JSON.stringify(Object.values(bt).slice(0, 5)));
    const stats = await lq.fetchLeadListStats(baseFilters);
    pass("fetchLeadListStats", `total=${stats.total}`);
  } catch (e) {
    fail("lead list query", msg(e));
  }
  const counts = await lq.fetchBusinessTypeCounts(baseFilters);
  if (e296) (counts ? pass : fail)("fetchBusinessTypeCounts", JSON.stringify(counts));
  else (counts === null ? pass : fail)("fetchBusinessTypeCounts returns null without E-296 (chips hidden)");
  try {
    const rows = await lq.fetchLeadListRows({ ...baseFilters, businessType: "finance" } as typeof baseFilters, 1, 5);
    (e296 ? pass : fail)("business_type filter", `${rows.length} rows`);
  } catch (e) {
    (e296 ? fail : warn)("business_type filter", `${e296 ? "" : "expected without E-296: "}${msg(e)}`);
  }
  const { normalizeBusinessType } = await import("@/lib/leads/businessType");
  (normalizeBusinessType("Battery Sale") === "battery_sale" ? pass : fail)("normalizeBusinessType('Battery Sale')");

  // ── Item 1: quotation CC ───────────────────────────────────────
  console.log("\nQuotation CC (item 1)");
  const qc = await import("@/lib/leads/quotationCc");
  try {
    const s = await qc.getQuotationCcSettings();
    pass("getQuotationCcSettings", JSON.stringify(s));
  } catch (e) {
    fail("getQuotationCcSettings", msg(e));
  }
  const approved = (await db.execute(sql`
    SELECT c.commercial_id::text AS id, c.dealer_lead_id AS lead_id FROM dealer_lead_commercials c
     WHERE c.approved_by IS NOT NULL ORDER BY c.created_at DESC LIMIT 3
  `)) as unknown as { id: string; lead_id: string }[];
  if (!approved.length) warn("no approved quotations on this DB to resolve CC for");
  for (const q of approved) {
    const r = await qc.resolveQuotationCc(q.lead_id, q.id);
    pass(`resolveQuotationCc ${q.id.slice(0, 8)}`, JSON.stringify(r));
  }

  // ── Items 9/10: dealer WhatsApp messages ───────────────────────
  console.log("\nDealer WhatsApp status messages (items 9, 10)");
  const wa = await import("@/lib/notifications/whatsapp-dealer");
  const ctx = { greetName: "Dealer", customerName: "Ramesh", referenceId: "IT-TEST-1", data: { outcome: "passed" } } as unknown as Parameters<typeof wa.buildDealerWhatsAppMessage>[1];
  for (const t of Object.keys(wa.WHATSAPP_DEALER_TYPES)) {
    try {
      const m = wa.buildDealerWhatsAppMessage(t, ctx);
      (m ? pass : fail)(`message for ${t}`, m ? JSON.stringify(m).slice(0, 110) : "null");
    } catch (e) {
      fail(`message for ${t}`, msg(e));
    }
  }
  const overlap = wa.DIRECT_PUSH_TYPES.filter((t) => wa.isDealerWhatsAppType(t));
  (overlap.length === 0 ? pass : fail)("no double push (direct-push types excluded from map)", overlap.join(","));

  // ── Item 11: disbursement confirmation ─────────────────────────
  console.log("\nDealer payment confirmation (item 11)");
  const { loanSanctions } = await import("@/lib/db/schema");
  try {
    await db.select().from(loanSanctions).limit(1);
    pass("bare select().from(loanSanctions)");
  } catch (e) {
    fail("bare select().from(loanSanctions) — sanction/dispatch paths break until E-298 is applied", msg(e));
  }
  const dp = await import("@/lib/leads/dealer-payment-confirmation");
  const disbursed = (await db.execute(sql`
    SELECT lead_id::text AS lead_id FROM loan_sanctions WHERE status='disbursed' ORDER BY disbursed_at DESC NULLS LAST LIMIT 1
  `)) as unknown as { lead_id: string }[];
  if (disbursed[0]) {
    try {
      const r = await dp.pendingSanctionForLead(disbursed[0].lead_id);
      pass("pendingSanctionForLead", JSON.stringify(r));
    } catch (e) {
      (e298 ? fail : warn)("pendingSanctionForLead", msg(e));
    }
  } else warn("no disbursed sanctions on this DB");

  const bad = steps.filter((s) => !s.ok);
  console.log(`\n${bad.length ? `${bad.length} FAILURE(S)` : "ALL GREEN"} — ${steps.length} assertion(s)`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => {
  console.error("verify crashed:", e);
  process.exit(2);
});
