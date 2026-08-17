import ExcelJS from "exceljs";
import { withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { MAX_JOBS } from "@/lib/scraper/commandParser";

// E-241 — GET /api/scraper/batch/template.xlsx
//
// The template exists so the header row is never the thing that goes wrong. The
// parser accepts a spread of aliases (command/search/keyword for query,
// location/town for city, limit/count for max_results), but an operator
// building a sheet from scratch has no way to know that, and a file rejected
// for its header is the most frustrating possible failure — the data was fine.
//
// Ships with three example rows and an inline instructions sheet rather than a
// bare header, because the two non-obvious rules (a blank city means "let AI
// pick the cities", and every row is its own independent run) are exactly the
// ones that change what an operator puts in the file.

export const dynamic = "force-dynamic";

function styleHeader(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1A1A1A" },
    };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  row.height = 28;
}

export const GET = withErrorHandler(async () => {
  await requireRole(["sales_head", "ceo", "business_head"]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "iTarang CRM";

  const sheet = workbook.addWorksheet("Jobs");
  sheet.columns = [
    { header: "query", key: "query", width: 42 },
    { header: "city", key: "city", width: 22 },
    { header: "max_results", key: "max_results", width: 14 },
  ];
  styleHeader(sheet.getRow(1));

  sheet.addRow({ query: "lithium battery dealer", city: "prayagraj", max_results: 60 });
  sheet.addRow({ query: "e rickshaw battery", city: "lucknow", max_results: null });
  sheet.addRow({ query: "inverter battery shop", city: null, max_results: null });

  const help = workbook.addWorksheet("Instructions");
  help.columns = [
    { header: "Column", key: "col", width: 16 },
    { header: "Required", key: "req", width: 12 },
    { header: "What it means", key: "note", width: 96 },
  ];
  styleHeader(help.getRow(1));

  help.addRow({
    col: "query",
    req: "Yes",
    note: "One search command, e.g. \"lithium battery dealer\". 2-200 characters. Also accepted as a header: command, search, keyword, product.",
  });
  help.addRow({
    col: "city",
    req: "No",
    note: "The single city this row searches. LEAVE BLANK to let the AI pick cities for that query — the same behaviour as the single-query scraper. Also accepted: location, town, district.",
  });
  help.addRow({
    col: "max_results",
    req: "No",
    note: "Optional cap on results for that row, 1-200. Blank means use the scraper's defaults. Also accepted: limit, count, results.",
  });
  help.addRow({});
  help.addRow({
    col: "Rows",
    req: "",
    note: `Each row becomes its own independent scrape with its own entry in Run History. Jobs run STRICTLY ONE AT A TIME, in the order of this sheet. Maximum ${MAX_JOBS} rows per upload (100 when "Expand queries with AI" is on).`,
  });
  help.addRow({
    col: "Duplicates",
    req: "",
    note: "The same query + city twice is reported as an error rather than run twice — repeating a scrape costs money and returns the leads you already have.",
  });
  help.addRow({
    col: "Schedule",
    req: "",
    note: "Start/end times and single-run vs daily recurring are chosen on the upload screen, not in this file — they apply to the whole submission.",
  });
  help.getColumn("note").alignment = { wrapText: true, vertical: "top" };

  const buffer = await workbook.xlsx.writeBuffer();

  return new Response(Buffer.from(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="scraper_batch_template.xlsx"',
      "Content-Length": buffer.byteLength.toString(),
      "Cache-Control": "no-store",
    },
  });
});
