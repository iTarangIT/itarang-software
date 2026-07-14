import { db } from "@/lib/db";
import { nbfcTenants } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { runRiskWorkflow } from "@/lib/ai/langgraph/risk-hypothesis-graph";

(async () => {
  const [t] = await db.select().from(nbfcTenants).where(eq(nbfcTenants.slug, "nbfc-lryx1chs")).limit(1);
  const tenant = { id: t!.id, slug: t!.slug, display_name: t!.display_name, contact_email: t!.contact_email, aum_inr: t!.aum_inr, active_loans: t!.active_loans, via: "dev_env" as const };
  const r = await runRiskWorkflow(tenant, { trigger: "manual" });
  console.log("RUN:", JSON.stringify(r, null, 2));
  process.exit(0);
})();
