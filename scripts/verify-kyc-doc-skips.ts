/**
 * Read-only check of E-392 (Battery Pool diagram 1 part 3): the sales head's
 * customer KYC document list and per-lead skips.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-kyc-doc-skips.ts [leadId…]
 *
 * Prints the asked list and, per lead (default: the 10 latest finance leads),
 * uploaded / skipped (with reason) / outstanding — using the real
 * leadDocStatus. Writes nothing.
 */
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { askedDocs, getCustomerDocConfig, leadDocStatus } from "@/lib/kyc/customer-doc-config";

async function main() {
  const config = await getCustomerDocConfig();
  console.log("Asked:", askedDocs(config).join(", "));
  let ids = process.argv.slice(2);
  if (!ids.length) {
    const rows = await db.select({ id: leads.id }).from(leads).where(eq(leads.payment_method, "finance")).orderBy(desc(leads.created_at)).limit(10);
    ids = rows.map((r) => r.id);
  }
  for (const id of ids) {
    const s = await leadDocStatus(id);
    console.log(
      `\n${id}\n  uploaded: ${[...new Set(s.uploaded)].join(", ") || "—"}\n  skipped: ${
        s.skips.map((k) => `${k.docType} ("${k.reason}", ${k.channel})`).join("; ") || "—"
      }\n  outstanding: ${s.outstanding.join(", ") || "none"}`,
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
