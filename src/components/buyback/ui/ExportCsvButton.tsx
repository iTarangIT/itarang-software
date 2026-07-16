"use client";

/**
 * Client-side CSV export atom (U6). Builds a CSV in the browser from rows
 * the caller has ALREADY loaded and filtered, and triggers a download — no
 * server round trip, so what downloads is exactly what is on screen right
 * now (unlike the Ledger page, which keeps its own server-side `?format=csv`
 * export — untouched by this).
 *
 * RFC-4180 quoting: every field is wrapped in double quotes, with any
 * literal `"` doubled to `""`. Unconditional — not "only when the value
 * contains a comma" — so there is no detection logic to get wrong, and a
 * value that itself contains a `","` sequence (comma immediately followed by
 * a quote) still round-trips correctly: e.g. the raw value `Acme, "Battery"
 * Co.` becomes `"Acme, ""Battery"" Co."`, which Excel/Sheets/`Papa.parse`
 * all read back as the original single field, comma and quotes intact.
 *
 * A UTF-8 BOM is prepended: without it, Excel guesses the file's encoding
 * from OS locale rather than reading it as UTF-8, and mangles a ₹ symbol or
 * an em dash into replacement characters on a non-UTF-8-default machine.
 */

const GHOST_BUTTON_CLASS =
  "rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-[12.5px] font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

/** RFC-4180: wrap every field in quotes, doubling any quote inside it. */
function csvField(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function buildCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  // The header comes from the FIRST row's keys — callers pass a flat,
  // human-readable mapper (see each page's own `toCsvRow`-style function),
  // so every row is expected to carry the same key set in the same order.
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.map(csvField).join(","),
    ...rows.map((r) => headers.map((h) => csvField(r[h])).join(",")),
  ];
  // UTF-8 BOM — spelled via fromCharCode rather than a literal character in
  // the source, which would be an invisible/ambiguous byte in a diff. Without
  // it, Excel guesses the file's encoding from OS locale rather than reading
  // it as UTF-8, and mangles a ₹ symbol or an em dash.
  const BOM = String.fromCharCode(0xfeff);
  return BOM + lines.join("\r\n");
}

export default function ExportCsvButton({
  filename,
  rows,
  disabled,
}: {
  /** e.g. "buyback-queue.csv" — passed straight to the download's filename. */
  filename: string;
  /** Already-loaded, already-filtered, flat rows — exactly what's on screen. */
  rows: Array<Record<string, unknown>>;
  disabled?: boolean;
}) {
  const onClick = () => {
    const csv = buildCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      // Nothing to export is not an error, but a download of a header-only
      // (or literally empty) file reads as broken — disable rather than let
      // that happen silently.
      disabled={disabled || rows.length === 0}
      className={GHOST_BUTTON_CLASS}
      title="Export the currently loaded rows as CSV"
    >
      ⬇ Export CSV
    </button>
  );
}
