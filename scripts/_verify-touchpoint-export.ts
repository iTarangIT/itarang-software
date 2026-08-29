/**
 * Read-only check of the bulk touchpoint export against the ACTIVE database
 * (prints the host first — DATABASE_URL flips between database-1 and -2).
 *
 * Picks the leads with the most touchpoints, builds the workbook the
 * /leads bulk bar builds, writes it to disk, reads it back the way Excel would,
 * and asserts the single "History" sheet carries one row per event (or one
 * placeholder row for a lead with none). Creates and deletes nothing; the only
 * side effect is one .xlsx in the system temp directory.
 *
 *   node --import tsx --env-file=.env.local scripts/_verify-touchpoint-export.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import ExcelJS from "exceljs";

import { db } from "@/lib/db";
import {
    HISTORY_COLUMNS,
    HISTORY_LEAD_COLUMN_COUNT,
    HISTORY_SHEET_NAME,
    buildTouchpointWorkbook,
} from "@/lib/leads/touchpointWorkbook";

type Picked = { id: string; dealer_name: string | null; n: string; sh: string };

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
    console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").match(/@([^/:]+)/)?.[1] ?? "unknown";
    console.log(`DB host: ${host}\n`);

    const picked = (await db.execute<Picked>(sql`
        SELECT dl.id, dl.dealer_name,
               COUNT(t.touchpoint_id)::text AS n,
               (SELECT COUNT(*) FROM dealer_lead_status_history h
                 WHERE h.dealer_lead_id = dl.id)::text AS sh
        FROM dealer_leads dl
        JOIN lead_touchpoints t ON t.dealer_lead_id = dl.id
        GROUP BY dl.id, dl.dealer_name
        ORDER BY COUNT(t.touchpoint_id) DESC
        LIMIT 3
    `)) as unknown as Picked[];

    // Plus one lead with NO touchpoints, to prove it still gets a row.
    const [quiet] = (await db.execute<{ id: string }>(sql`
        SELECT dl.id FROM dealer_leads dl
        WHERE NOT EXISTS (SELECT 1 FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id)
          AND NOT EXISTS (SELECT 1 FROM dealer_lead_status_history h WHERE h.dealer_lead_id = dl.id)
        LIMIT 1
    `)) as unknown as { id: string }[];

    if (picked.length === 0) {
        console.log("No leads with touchpoints on this database — nothing to check.");
        process.exit(0);
    }

    console.log("Leads selected:");
    picked.forEach((p) =>
        console.log(`  ${p.id}  ${p.dealer_name ?? "(no name)"}  ${p.n} touchpoints, ${p.sh} status changes`),
    );
    if (quiet) console.log(`  ${quiet.id}  (no events — placeholder-row case)`);

    const ids = [...picked.map((p) => p.id), ...(quiet ? [quiet.id] : [])];
    const expectedTp = picked.reduce((s, p) => s + Number(p.n), 0);
    const expectedRows =
        picked.reduce((s, p) => s + Math.max(1, Number(p.n) + Number(p.sh)), 0) +
        (quiet ? 1 : 0);

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

    check("exactly one sheet, named History", JSON.stringify(names) === JSON.stringify([HISTORY_SHEET_NAME]), names.join(","));

    const ws = rb.getWorksheet(HISTORY_SHEET_NAME)!;
    const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
    console.log(`  H: ${header.join(" | ")}`);
    for (let r = 2; r <= Math.min(5, ws.rowCount); r++) {
        console.log(`  ${r}: ${(ws.getRow(r).values as unknown[]).slice(1).join(" | ")}`);
    }
    console.log("");

    check("header matches HISTORY_COLUMNS", JSON.stringify(header) === JSON.stringify(HISTORY_COLUMNS));
    check(
        "header + first 3 columns frozen",
        ws.views?.[0]?.state === "frozen" && ws.views[0].ySplit === 1 && ws.views[0].xSplit === 3,
    );
    check(
        "header styled",
        ws.getRow(1).getCell(1).font?.bold === true &&
            (ws.getRow(1).getCell(1).fill as ExcelJS.FillPattern)?.fgColor?.argb === "FF1A1A1A",
    );

    const dataRows = ws.rowCount - 1;
    check("one row per event (placeholder for a quiet lead)", dataRows === expectedRows, `${dataRows} vs ${expectedRows}`);

    // Lead columns are filled on EVERY row, and the touchpoint count per lead
    // agrees with the number of Touchpoint event rows for that lead.
    const dealerCol = 1, phoneCol = 3, countCol = 12, eventCol = HISTORY_LEAD_COLUMN_COUNT + 1;
    let unattributed = 0;
    let tpEventRows = 0;
    const countByKey = new Map<string, number>();
    for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const dealer = row.getCell(dealerCol).value;
        const phone = row.getCell(phoneCol).value;
        if (!dealer && !phone) unattributed++;
        if (row.getCell(eventCol).value === "Touchpoint") tpEventRows++;
        countByKey.set(`${dealer}|${phone}`, Number(row.getCell(countCol).value ?? 0));
    }
    check("every row carries lead identity", unattributed === 0, `${unattributed} rows without dealer or phone`);
    check("Touchpoint event rows match DB", tpEventRows === expectedTp, `${tpEventRows} vs ${expectedTp}`);
    const summed = [...countByKey.values()].reduce((s, v) => s + v, 0);
    check("Touchpoints column sums to the touchpoint rows", summed === expectedTp, `${summed} vs ${expectedTp}`);

    // Unknown id: must not throw, must still produce a valid, empty workbook.
    const empty = await buildTouchpointWorkbook(["__no_such_lead__"]);
    check(
        "unknown id -> empty but valid workbook",
        empty.worksheets.length === 1 && empty.worksheets[0].rowCount - 1 === 0,
    );

    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
});
