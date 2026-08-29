/**
 * GET /api/operations/logs/export.xlsx
 *
 * The log explorer's current view as a spreadsheet. Two sheets:
 *
 *   "Lines"  — every matching row, newest first, up to EXPORT_LIMIT.
 *   "Groups" — the same rows collapsed by fingerprint with counts, which is
 *              usually the sheet someone actually wanted.
 *
 * Takes the SAME query parameters as the page, through the same parseFilters(),
 * so the export is the view you were looking at. An export that quietly returns
 * a different set from the table it was launched from is worse than no export.
 */

import ExcelJS from "exceljs";

import {
  getLogLinesForExport,
  parseFilters,
  type LogLine,
} from "@/lib/operations/logs";
import { requireOperationsAdmin } from "@/lib/operations/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Ten thousand rows through ExcelJS is comfortably past the default budget.
export const maxDuration = 60;

/** Well under Excel's row ceiling, and bounded memory for the buffer. */
const EXPORT_LIMIT = 10_000;

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

function ist(date: Date | string | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

interface Group {
  fingerprint: string;
  level: string;
  service: string;
  hosts: Set<string>;
  count: number;
  first: Date;
  last: Date;
  sample: string;
}

/**
 * Collapse in memory rather than with a second grouped query.
 *
 * The rows are already here and already capped, so a round trip would only add
 * a way for the two sheets to disagree about the same window.
 */
function groupLines(lines: LogLine[]): Group[] {
  const groups = new Map<string, Group>();

  for (const line of lines) {
    const at = new Date(line.logged_at);
    const existing = groups.get(line.fingerprint);

    if (!existing) {
      groups.set(line.fingerprint, {
        fingerprint: line.fingerprint,
        level: line.level,
        service: line.service,
        hosts: new Set([line.host]),
        count: 1,
        first: at,
        last: at,
        // Rows arrive newest-first, so the first one seen is the newest and
        // stays the sample.
        sample: line.message,
      });
      continue;
    }

    existing.count += 1;
    existing.hosts.add(line.host);
    if (at < existing.first) existing.first = at;
    if (at > existing.last) existing.last = at;
  }

  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export async function GET(request: Request) {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  const filters = parseFilters(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );

  let lines: LogLine[];
  try {
    lines = await getLogLinesForExport(filters, EXPORT_LIMIT);
  } catch (e) {
    return Response.json(
      {
        success: false,
        error: {
          message: e instanceof Error ? e.message : "Failed to read log events",
          hint: "If this says a relation does not exist, apply drizzle/E-210_ops_monitoring.sql to this database.",
        },
      },
      { status: 500 },
    );
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "iTarang Ops Console";
  workbook.created = new Date();

  // ── Lines ────────────────────────────────────────────────────────────────
  const linesSheet = workbook.addWorksheet("Lines", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  linesSheet.columns = [
    { header: "Logged At (IST)", key: "logged_at", width: 22 },
    { header: "Level", key: "level", width: 10 },
    { header: "Host", key: "host", width: 12 },
    { header: "Service", key: "service", width: 24 },
    { header: "Message", key: "message", width: 100 },
    { header: "Fingerprint", key: "fingerprint", width: 20 },
  ];
  styleHeader(linesSheet.getRow(1));

  for (const line of lines) {
    linesSheet.addRow({
      logged_at: ist(line.logged_at),
      level: line.level,
      host: line.host,
      service: line.service,
      message: line.message,
      // First 12 chars: enough to match a row against the Groups sheet without
      // making the column unreadable.
      fingerprint: line.fingerprint.slice(0, 12),
    });
  }

  if (lines.length > 0) {
    linesSheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: linesSheet.columns.length },
    };
  }

  // ── Groups ───────────────────────────────────────────────────────────────
  const groupsSheet = workbook.addWorksheet("Groups", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  groupsSheet.columns = [
    { header: "Count", key: "count", width: 10 },
    { header: "Level", key: "level", width: 10 },
    { header: "Service", key: "service", width: 24 },
    { header: "Hosts", key: "hosts", width: 20 },
    { header: "First Seen (IST)", key: "first", width: 22 },
    { header: "Last Seen (IST)", key: "last", width: 22 },
    { header: "Sample Message", key: "sample", width: 100 },
    { header: "Fingerprint", key: "fingerprint", width: 20 },
  ];
  styleHeader(groupsSheet.getRow(1));

  for (const group of groupLines(lines)) {
    groupsSheet.addRow({
      count: group.count,
      level: group.level,
      service: group.service,
      hosts: [...group.hosts].sort().join(", "),
      first: ist(group.first),
      last: ist(group.last),
      sample: group.sample,
      fingerprint: group.fingerprint.slice(0, 12),
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const scope = [filters.host, filters.level].filter(Boolean).join("_");
  const filename = `ops_logs_${scope ? `${scope}_` : ""}${stamp}.xlsx`;

  return new Response(Buffer.from(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": buffer.byteLength.toString(),
      "Cache-Control": "no-store",
    },
  });
}
