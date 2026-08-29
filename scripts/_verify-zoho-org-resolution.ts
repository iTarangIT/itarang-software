// Regression check for "CEO dashboard shows only ITG invoices".
//
// Prod symptom: shared/.env is rewritten from PROD_ENV_FILE_B64 on every deploy,
// so the ZOHO_ORGANIZATION_IDS added by hand for E-171 vanished. getOrganizationIds()
// silently fell back to the single ZOHO_ORGANIZATION_ID (ITG) and the Delhi org
// (ITD) stopped syncing on 2026-06-29 — with no error recorded anywhere.
//
// This reproduces that env and asserts the sync still resolves BOTH orgs.
// The local ZOHO_REFRESH_TOKEN is dead, so the /organizations lookup fails here
// exactly as it would on a token whose scope doesn't cover it — which makes this
// a check of the token-independent path (orgs remembered in zoho_invoices), the
// one that actually rescues prod.
//
// Run: node --import tsx --env-file=.env.local scripts/_verify-zoho-org-resolution.ts

const ITG = "60060919257";
const ITD = "60064046518";

// Must happen before the Zoho client module loads — it reads env at import time.
delete process.env.ZOHO_ORGANIZATION_IDS;

async function main() {
  const { resolveSyncOrganizationIds } = await import("@/lib/zoho/sync");
  const { getOrganizationIds } = await import("@/lib/zoho/client");

  console.log("env after simulated deploy-reset:");
  console.log("  ZOHO_ORGANIZATION_ID :", process.env.ZOHO_ORGANIZATION_ID);
  console.log("  ZOHO_ORGANIZATION_IDS:", process.env.ZOHO_ORGANIZATION_IDS ?? "(unset — as on prod)");
  console.log("  env-only resolution  :", getOrganizationIds(), "  <- what prod was iterating");

  const resolved = await resolveSyncOrganizationIds();
  console.log("  sync resolution      :", resolved.ids);
  console.log("  sources              :", resolved.sources);

  const missing = [ITG, ITD].filter((id) => !resolved.ids.includes(id));
  if (missing.length) {
    console.error(`\nFAIL: sync would skip org(s) ${missing.join(", ")} — invoices for them go stale silently.`);
    process.exit(1);
  }
  console.log("\nPASS: both ITG and ITD resolved despite ZOHO_ORGANIZATION_IDS being absent.");

  // --run-sync additionally drives the real sync under the same broken env, to
  // prove invoices for BOTH orgs actually land (resolution alone isn't proof).
  // Full re-pull + upsert, so it is idempotent — but it does write.
  if (process.argv.includes("--run-sync")) {
    const { syncInvoicesSinceLastRun } = await import("@/lib/zoho/sync");
    const r = await syncInvoicesSinceLastRun();
    console.log("\nsync run:", {
      status: r.status,
      upserted: r.upserted,
      organizationIds: r.organizationIds,
      organizationSources: r.organizationSources,
      errors: r.errors,
    });

    const { db } = await import("@/lib/db");
    const { zohoInvoices } = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const rows = await db
      .select({
        organization_id: zohoInvoices.organization_id,
        n: sql<number>`COUNT(*)::int`,
        last_invoice: sql<string>`MAX(${zohoInvoices.invoice_date})`,
        last_synced: sql<string>`MAX(${zohoInvoices.synced_at})`,
      })
      .from(zohoInvoices)
      .groupBy(zohoInvoices.organization_id);
    console.table(rows);

    const itd = rows.find((x) => x.organization_id === ITD);
    const itg = rows.find((x) => x.organization_id === ITG);
    const fresh = (v: string | null) =>
      !!v && Date.now() - new Date(v).getTime() < 10 * 60_000;
    if (!fresh(itd?.last_synced ?? null) || !fresh(itg?.last_synced ?? null)) {
      console.error("\nFAIL: an org was not refreshed by this run.");
      process.exit(1);
    }
    console.log("\nPASS: both orgs re-synced just now.");
  }

  process.exit(0);
}

main();
