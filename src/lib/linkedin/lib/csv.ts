// CSV writer for LinkedIn exports (E-398). Pure.

export type Column = { key: string; header: string; width?: number };
export type Table = { name: string; columns: Column[]; rows: Record<string, unknown>[] };

const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  // Neutralise spreadsheet formulas in user-sourced text (=, +, -, @).
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** One table → CSV text (BOM so Excel reads UTF-8 names). Pure; exported for tests. */
export function toCsv(t: Table): string {
  const lines = [t.columns.map((c) => csvCell(c.header)).join(",")];
  for (const r of t.rows) lines.push(t.columns.map((c) => csvCell(r[c.key])).join(","));
  return "﻿" + lines.join("\r\n");
}
