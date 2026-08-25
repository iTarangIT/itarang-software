import { config } from "dotenv";
config({ path: ".env.local" });
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { leads } from "../src/lib/db/schema";
import { loadSectionGOptions } from "../src/lib/leads/section-g";
import { productLines, rowTitle, rowDescription, ROW_DESC_MAX } from "../src/lib/whatsapp/scheme-format";
import { schemeName } from "../src/lib/whatsapp/scheme-name";

async function main() {
  const leadId = process.argv.includes("--lead")
    ? process.argv[process.argv.indexOf("--lead") + 1]
    : "LEAD-20260825-edd97bdf";
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) throw new Error("no lead");
  console.log(`lead resident_status = ${lead.resident_status ?? "(null)"}\n`);
  const opts = await loadSectionGOptions(lead);
  console.log("RAW first product:", JSON.stringify(opts[0]?.activeLoanProducts[0], null, 2));
  console.log("\n───────── rendered card ─────────");
  console.log("🏦 *Choose your lending partner*\n");
  console.log(
    opts.map((o, i) => `*${schemeName(i)}*\n${o.activeLoanProducts.map((p, j) => productLines(p, j)).join("\n\n")}`).join("\n\n"),
  );
  console.log("\nTap *Choose* below and pick a scheme.");
  console.log("───────── list rows ─────────");
  opts.forEach((o, i) =>
    o.activeLoanProducts.forEach((p, j) => {
      const d = rowDescription(p);
      console.log(`  [${rowTitle(i, j)}] ${d}  (${d.length}/${ROW_DESC_MAX})`);
    }),
  );
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
