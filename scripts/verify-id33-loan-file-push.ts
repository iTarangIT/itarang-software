/**
 * ID 33 — read-only check of the "Pushed by iTarang (date)" columns on the
 * Customer loan files download. Builds the real dataset (every date, as an
 * Admin would) and compares the rows marked as pushed with the files the house
 * dealer pushed out according to the audit trail.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id33-loan-file-push.ts
 *
 * Writes nothing.
 */
import { datasetById, type RunContext } from "@/lib/exports/datasets/registry";
import { houseDealerCode } from "@/lib/leads/dealerByMobile";
import { houseOriginatedLeadIds } from "@/lib/leads/pushGuards";

async function main() {
    const dataset = datasetById("customer_loan_files");
    if (!dataset) throw new Error("customer_loan_files dataset missing");
    const user = { id: "00000000-0000-0000-0000-000000000000", role: "admin", email: null, name: "verify" } as unknown as RunContext["user"];
    const params = new URLSearchParams({ from: "2000-01-01", to: "2100-12-31" });
    const [sheet] = await dataset.build({ params, user, ownOnly: false });

    const house = await houseDealerCode();
    const pushedIds = house ? await houseOriginatedLeadIds(house, sheet.rows.map((r) => String(r.file_id))) : new Set<string>();
    const marked = sheet.rows.filter((r) => r.pushed_by_itarang_on != null);

    console.log(`house dealer: ${house ?? "(none)"}`);
    console.log(`files in download: ${sheet.rows.length}`);
    console.log(`marked pushed by iTarang: ${marked.length}; house pushes in audit trail: ${pushedIds.size}`);
    for (const r of marked.slice(0, 10)) {
        console.log(`  ${r.file_id}  on ${String(r.pushed_by_itarang_on)}  by ${r.pushed_by ?? "?"}  to ${r.pushed_to ?? "?"}  (now with ${r.dealer ?? "?"})`);
    }
    const missing = [...pushedIds].filter((id) => !marked.some((r) => r.file_id === id));
    if (missing.length) {
        console.error(`MISMATCH: pushed in the audit trail but not marked: ${missing.join(", ")}`);
        process.exit(1);
    }
    console.log("OK");
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
