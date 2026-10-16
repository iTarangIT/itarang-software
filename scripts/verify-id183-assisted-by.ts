/**
 * ID 183 — read-only check of "Assisted by (iTarang)" in the three places the
 * report asks for: the Customer loan files download, the KYC export and the
 * KYC review digest. Compares each with the ACTED_FOR_DEALER audit rows.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id183-assisted-by.ts [YYYY-MM-DD]
 *
 * The optional day is the digest day (IST); default today. Writes nothing.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { fetchKycExportRows } from "@/lib/admin/kycExport";
import { kycReviewDigest } from "@/lib/digests/kinds/kyc-review";
import { datasetById, type RunContext } from "@/lib/exports/datasets/registry";
import { ACTED_FOR_DEALER } from "@/lib/leads/actForDealer";

async function main() {
    const day = process.argv[2] ?? new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

    const acted = (await db.execute(sql`
        SELECT entity_id AS lead_id, COUNT(*)::int AS steps
          FROM audit_logs WHERE entity_type = 'lead' AND action = ${ACTED_FOR_DEALER}
         GROUP BY entity_id
    `)) as unknown as Array<{ lead_id: string; steps: number }>;
    const actedIds = new Set(acted.map((r) => r.lead_id));
    console.log(`leads with ACTED_FOR_DEALER rows: ${actedIds.size}`);

    const dataset = datasetById("customer_loan_files");
    if (!dataset) throw new Error("customer_loan_files dataset missing");
    const user = { id: "00000000-0000-0000-0000-000000000000", role: "admin", email: null, name: "verify" } as unknown as RunContext["user"];
    const [sheet] = await dataset.build({ params: new URLSearchParams({ from: "2000-01-01", to: "2100-12-31" }), user, ownOnly: false });
    const loanMarked = sheet.rows.filter((r) => r.assisted_by);
    const loanShould = sheet.rows.filter((r) => actedIds.has(String(r.file_id)));
    console.log(`loan files: ${sheet.rows.length}; assisted: ${loanMarked.length} (audit says ${loanShould.length})`);
    for (const r of loanMarked.slice(0, 5)) console.log(`  ${r.file_id}  ${r.assisted_by}`);

    const kyc = await fetchKycExportRows({}, 5000);
    const kycMarked = kyc.filter((r) => r.assisted_by);
    const kycShould = kyc.filter((r) => actedIds.has(r.lead_id));
    console.log(`KYC export rows: ${kyc.length}; assisted: ${kycMarked.length} (audit says ${kycShould.length})`);
    for (const r of kycMarked.slice(0, 5)) console.log(`  ${r.lead_id}  ${r.assisted_by}`);

    const detail = await kycReviewDigest.collectDetail?.(day);
    if (!detail?.ok) throw new Error(`digest detail failed: ${detail?.error ?? "no collectDetail"}`);
    const lines = Object.values(detail.detail).flat();
    console.log(`KYC digest ${day}: ${lines.length} detail rows; with "Assisted by": ${lines.filter((l) => l.subtitle?.includes("Assisted by")).length}`);

    const bad = loanMarked.length !== loanShould.length || kycMarked.length !== kycShould.length;
    console.log(bad ? "MISMATCH" : "OK");
    process.exit(bad ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
