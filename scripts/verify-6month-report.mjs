// Verifies the merged 6-month report against its two sources.
//
// The only failure mode that really matters here is SILENT LOSS: a carried-over
// sheet that lost rows, lost its merged header bars, or lost a column width would
// still open fine in Excel and would still look plausible. So this asserts row
// count, first/last row values, column widths and merge count per sheet rather
// than just "the file exists".
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const DESKTOP = path.join(os.homedir(), "OneDrive", "Desktop");
const SRC_3M = path.join(DESKTOP, "Itarang_Work_Report_3_Months_2026-05-25(1)_with_WhatsApp.xlsx");
const SRC_UPD = path.join(DESKTOP, "Itarang_Work_Report_Update_2026-07-31.xlsx");
const OUT = path.join(os.homedir(), "Downloads", "Itarang_Work_Report_6_Months_2026-08-03.xlsx");

// Captured before the build ran.
const EXPECT_MD5 = {
    [SRC_3M]: "d620fa96581cba9999021ee4f91e2e43",
    [SRC_UPD]: "ca4cd0ca46d4cb30ee32899b8e8ea4ad",
};

let fails = 0;
const ok = (label, pass, detail = "") => {
    if (!pass) fails++;
    console.log(`${pass ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const md5 = (f) => createHash("md5").update(readFileSync(f)).digest("hex");
const rowVals = (ws, n) => JSON.stringify((ws.getRow(n).values || []).map((v) => (v == null ? "" : String(v))));
const widths = (ws) => JSON.stringify((ws.columns || []).map((c) => c.width ?? null));
const merges = (ws) => Object.keys(ws._merges || {}).length;

const PART_A = ["Dealer Onboarding", "Admin Dashboard", "Dealer Dashboard", "NBFC Onboarding", "NBFC Dashboard", "WhatsApp Onboarding", "Sheet1", "Sheet2"];
const PART_B = ["0. Summary", "1. WhatsApp End-to-End", "2. NBFC File Process", "3. Risk Engine & Sandbox", "4. IT Dashboard & Security", "5. Notification Engine", "6. CRM Workflow Changes"];

async function main() {
    console.log("1. Sources untouched");
    for (const [f, want] of Object.entries(EXPECT_MD5)) {
        ok(`${path.basename(f).slice(0, 44)}… byte-identical`, md5(f) === want, md5(f));
    }

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(OUT);
    const a = new ExcelJS.Workbook();
    await a.xlsx.readFile(SRC_3M);
    const b = new ExcelJS.Workbook();
    await b.xlsx.readFile(SRC_UPD);

    console.log("\n2. Structure");
    const names = out.worksheets.map((w) => w.name);
    ok("26 sheets", names.length === 26, `${names.length}`);
    ok("no duplicate sheet names", new Set(names).size === names.length);
    ok("Cover is first", names[0] === "Cover", names[0]);
    ok("Changes is last", names[names.length - 1] === "Changes", names[names.length - 1]);

    console.log("\n3. Part A carried over losslessly (vs the 3-month file)");
    ok("original Cover kept as 'Cover (3-Month)'", out.getWorksheet("Cover (3-Month)")?.rowCount === a.getWorksheet("Cover").rowCount);
    for (const n of PART_A) {
        const s = a.getWorksheet(n), d = out.getWorksheet(n);
        if (!d) { ok(`${n} present`, false); continue; }
        const same =
            s.rowCount === d.rowCount &&
            rowVals(s, 1) === rowVals(d, 1) &&
            rowVals(s, s.rowCount || 1) === rowVals(d, d.rowCount || 1) &&
            widths(s) === widths(d) &&
            merges(s) === merges(d);
        ok(`${n} identical`, same, `rows ${s.rowCount}/${d.rowCount} · merges ${merges(s)}/${merges(d)}`);
    }

    console.log("\n4. Part B carried over losslessly (vs the 31 Jul file)");
    for (const n of PART_B) {
        const s = b.getWorksheet(n), d = out.getWorksheet(n);
        if (!d) { ok(`${n} present`, false); continue; }
        const same =
            s.rowCount === d.rowCount &&
            rowVals(s, 1) === rowVals(d, 1) &&
            rowVals(s, s.rowCount) === rowVals(d, d.rowCount) &&
            widths(s) === widths(d) &&
            merges(s) === merges(d);
        ok(`${n} identical`, same, `rows ${s.rowCount}/${d.rowCount} · merges ${merges(s)}/${merges(d)}`);
    }

    console.log("\n5. Extended sheets keep their original rows and gained new ones");
    for (const [src, dest, added] of [["7. Migrations Shipped", "13. Migrations", 9], ["8. Work Log", "14. Work Log", 10]]) {
        const s = b.getWorksheet(src), d = out.getWorksheet(dest);
        ok(`${dest} = ${s.rowCount} original + ${added}`, d.rowCount === s.rowCount + added, `${d.rowCount}`);
        ok(`${dest} original first row intact`, rowVals(s, 1) === rowVals(d, 1));
        ok(`${dest} original last row intact`, rowVals(s, s.rowCount) === rowVals(d, s.rowCount));
    }

    console.log("\n6. New sheets are populated");
    for (const n of ["7. NBFC EMI Tracker", "8. Loan Product Flow", "9. Live Attack Protection", "10. Customer Leads & Dedupe", "11. NeoDove Integration", "12. Navprakruti Costing"]) {
        const d = out.getWorksheet(n);
        ok(`${n} has content`, !!d && d.rowCount > 15, d ? `${d.rowCount} rows` : "missing");
    }
    const ch = out.getWorksheet("Changes");
    ok("Changes has > 40 rows", ch.rowCount > 40, `${ch.rowCount}`);
    ok("Changes has an autofilter", !!ch.autoFilter);

    console.log("\n7. Cover table of contents resolves");
    const cover = out.getWorksheet("Cover");
    let toc = 0, missing = [];
    for (let r = 1; r <= cover.rowCount; r++) {
        const v = cover.getRow(r).getCell(2).value;
        if (typeof v === "string" && names.includes(v)) toc++;
        else if (typeof v === "string" && /^(\d+\.|Cover \(|Sheet\d)/.test(v)) missing.push(v);
    }
    ok("every ToC entry names a real sheet", missing.length === 0, missing.join(", ") || `${toc} entries resolved`);
    ok("ToC lists all 25 non-cover sheets", toc === 25, `${toc}`);

    console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : `${fails} CHECK(S) FAILED`}`);
    process.exitCode = fails === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
