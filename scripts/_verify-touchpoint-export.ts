/**
 * Read-only check of the bulk touchpoint export against the ACTIVE database
 * (prints the host first — DATABASE_URL flips between database-1 and -2).
 *
 * Picks the leads with the most touchpoints, builds the workbook the
 * /leads bulk bar builds, writes it to disk, reads it back the way Excel would,
 * and asserts the row counts match what the DB says. Creates and deletes
 * nothing; the only side effect is one .xlsx in the system temp directory.
 *
 *   node --import tsx --env-file=.env.local scripts/_verify-touchpoint-export.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import ExcelJS from "exceljs";

import { db } from "@/lib/db";
import { buildTouchpointWorkbook } from "@/lib/leads/touchpointWorkbook";

type Picked = { id: string; dealer_name: string | null; n: string };

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
    console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").match(/@([^/:]+)/)?.[1] ?? "unknown";
    console.log(`DB host: ${host}\n`);

    const picked = (await db.execute<Picked>(sql`
        SELECT dl.id, dl.dealer_name, COUNT(t.touchpoint_id)::text AS n
        FROM dealer_leads dl
        JOIN lead_touchpoints t ON t.dealer_lead_id = dl.id
        GROUP BY dl.id, dl.dealer_name
        ORDER BY COUNT(t.touchpoint_id) DESC
        LIMIT 3
    `)) as unknown as Picked[];

    if (picked.length === 0) {
        console.log("No leads with touchpoints on this database — nothing to check.");
        process.exit(0);
    }

    console.log("Leads selected:");
    picked.forEach((p) =>
        console.log(`  ${p.id}  ${p.dealer_name ?? "(no name)"}  ${p.n} touchpoints`),
    );

    const ids = picked.map((p) => p.id);
    const expectedTp = picked.reduce((s, p) => s + Number(p.n), 0);

    const [shCount] = (await db.execute<{ n: string }>(sql`
        SELECT COUNT(*)::text AS n
        FROM dealer_lead_status_history
        WHERE dealer_lead_id IN ${ids}
    `)) as unknown as { n: string }[];
    const expectedSh = Number(shCount?.n ?? 0);

    const t0 = Date.now();
    const wb = await buildTouchpointWorkbook(ids);
    const out = join(tmpdir(), "itarang_touchpoint_export_check.xlsx");
    await wb.xlsx.writeFile(out);
    console.log(`\nBuilt + written in ${Date.now() - t0}ms -> ${out}`);

    // Read it back the way Excel would.
    const rb = new ExcelJS.Workbook();
    await rb.xlsx.readFile(out);
    const names = rb.worksheets.map((w) => w.name);
    console.log(`\nSheets: ${names.join(" | ")}\n`);

    check(
        "three sheets, in order",
        JSON.stringify(names) === JSON.stringify(["Leads", "Touchpoints", "Status History"]),
        names.join(","),
    );

    for (const ws of rb.worksheets) {
        const dataRows = ws.rowCount - 1;
        console.log(`=== ${ws.name} === ${dataRows} data rows`);
        console.log(`  H: ${(ws.getRow(1).values as unknown[]).slice(1).join(" | ")}`);
        for (let r = 2; r <= Math.min(4, ws.rowCount); r++) {
            console.log(`  ${r}: ${(ws.getRow(r).values as unknown[]).slice(1).join(" | ")}`);
        }
        const header = ws.getRow(1);
        check(
            `${ws.name}: header frozen`,
            ws.views?.[0]?.state === "frozen" && ws.views[0].ySplit === 1,
        );
        check(
            `${ws.name}: header styled`,
            header.getCell(1).font?.bold === true &&
                (header.getCell(1).fill as ExcelJS.FillPattern)?.fgColor?.argb === "FF1A1A1A",
        );
        console.log("");
    }

    const leadSheet = rb.getWorksheet("Leads")!;
    const tpSheet = rb.getWorksheet("Touchpoints")!;
    const shSheet = rb.getWorksheet("Status History")!;

    check("Leads: one row per selected lead", leadSheet.rowCount - 1 === ids.length,
        `${leadSheet.rowCount - 1} vs ${ids.length}`);
    check("Touchpoints: row count matches DB", tpSheet.rowCount - 1 === expectedTp,
        `${tpSheet.rowCount - 1} vs ${expectedTp}`);
    check("Status History: row count matches DB", shSheet.rowCount - 1 === expectedSh,
        `${shSheet.rowCount - 1} vs ${expectedSh}`);

    // The per-lead count on the Leads sheet must agree with the flat sheet.
    const countCol = 12; // "Touchpoints"
    const summed = leadSheet
        .getColumn(countCol)
        .values.slice(2)
        .reduce((s: number, v) => s + Number(v ?? 0), 0);
    check("Leads: touchpoint counts sum to the flat sheet", summed === expectedTp,
        `${summed} vs ${expectedTp}`);

    // Every touchpoint row must be attributable to a lead.
    let unattributed = 0;
    for (let r = 2; r <= tpSheet.rowCount; r++) {
        const dealer = tpSheet.getRow(r).getCell(1).value;
        const phone = tpSheet.getRow(r).getCell(3).value;
        if (!dealer && !phone) unattributed++;
    }
    check("Touchpoints: every row carries lead identity", unattributed === 0,
        `${unattributed} rows without dealer or phone`);

    // Cross-check one lead against the single-lead export's query.
    const one = picked[0];
    const solo = await buildTouchpointWorkbook([one.id]);
    const soloRows = solo.getWorksheet("Touchpoints")!.rowCount - 1;
    check(`single-lead build matches its DB count (${one.id})`,
        soloRows === Number(one.n), `${soloRows} vs ${one.n}`);

    // Unknown id: must not throw, must still produce a valid 3-sheet workbook.
    const empty = await buildTouchpointWorkbook(["__no_such_lead__"]);
    check("unknown id -> empty but valid workbook",
        empty.worksheets.length === 3 &&
            empty.worksheets.every((w) => w.rowCount - 1 === 0));

    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
});
