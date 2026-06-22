/**
 * Test harness for the "ACTIVE LOANS" KPI card (and the whole command centre).
 *
 * Run from the VS Code terminal:
 *   node --import tsx --env-file=.env.local scripts/test-active-loans.ts
 *
 * Optionally pass a different tenant id as the first argument:
 *   node --import tsx --env-file=.env.local scripts/test-active-loans.ts <TENANT_ID>
 */

import "dotenv/config";
import { computePortfolioSummary } from "@/lib/nbfc/portfolio-summary";
import { computeCommandCentre } from "@/lib/nbfc/command-centre";

// Default = iTarang Finance
const TENANT = process.argv[2] ?? "02bda647-c164-4e81-809b-01cfe159cdb6";

async function main() {
  console.log("Tenant:", TENANT, "\n");

  // 1. The raw value the card shows (step 7 in the flow)
  const summary = await computePortfolioSummary(TENANT);
  console.log("computePortfolioSummary().total_active_loans =", summary.total_active_loans);

  // 2. The full command-centre payload (what the API returns)
  const cc = await computeCommandCentre(TENANT);
  console.log("\nACTIVE LOANS card =", cc.kpis.active_loans);
  console.log("\nAll 4 KPI cards:");
  console.dir(cc.kpis, { depth: null });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
