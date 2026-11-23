/**
 * Read-only check of the E-391 NBFC routing rules (Battery Pool diagram 1 part 2).
 *
 *   node --import tsx --env-file=.env.local scripts/verify-nbfc-routing.ts [leadId…]
 *
 * Lists the active rules and, for the given leads (default: the 15 latest finance
 * leads), which rule fits and whether the BRE accepts it — using the real
 * resolveRoutingTarget. Writes nothing.
 */
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { activeRoutingRules, describeRuleScope, resolveRoutingTarget, ruleWeight } from "@/lib/leads/nbfc-routing";

async function main() {
  const rules = await activeRoutingRules();
  console.log(`Active routing rules: ${rules.length}`);
  for (const r of rules) console.log(`  #${r.id} [${ruleWeight(r)}] ${describeRuleScope(r)} → nbfc ${r.nbfc_id} / product ${r.loan_product_id}`);

  let ids = process.argv.slice(2);
  if (!ids.length) {
    const rows = await db
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.payment_method, "finance"))
      .orderBy(desc(leads.created_at))
      .limit(15);
    ids = rows.map((r) => r.id);
  }
  console.log("\nLeads:");
  for (const id of ids) {
    const t = await resolveRoutingTarget(id);
    console.log(`  ${id}: ${t.ok ? `→ ${t.nbfcName} / ${t.productName} (${t.rule ? `rule #${t.rule.id}, ${t.scope}` : t.scope})` : `no auto-route — ${t.why}`}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
