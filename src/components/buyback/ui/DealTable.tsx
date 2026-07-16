"use client";

import type { KeyboardEvent, ReactNode } from "react";

/**
 * Buyback list table — proto table() (iTarang Portal.dc.html:468-475). Dumb
 * by design: no useRouter, no fetch — callers own navigation via row.onClick.
 * "use client" because attaching onClick/onKeyDown to a <tr> is illegal from
 * a Server Component (event handlers can't be sent as part of the RSC
 * payload).
 */
export interface DealTableHead {
  label: string;
  align?: "left" | "right";
}

export interface DealTableRow {
  key: string;
  onClick?: () => void;
  /** Accessible name for the row when it's a click/Enter navigation target
   * (e.g. "Open BB-1024") — screen readers otherwise read a <tr> with no
   * label of its own. Optional: rows without onClick don't need one. */
  ariaLabel?: string;
  cells: ReactNode[];
}

/**
 * A row with `onClick` behaves as a navigation target (role="link", Enter/
 * Space activate it, like the rest of this kit's "row IS the link" pattern).
 * If any cell renders its OWN nested `<Link>`/`<a>` (kept for
 * middle-click/open-in-new-tab, e.g. the queue page's Request column), give
 * that nested link `tabIndex={-1}` — otherwise the row is reachable by
 * keyboard TWICE (once for the row, once for the inner link), which reads as
 * a broken/duplicated tab stop. The nested link's own onClick should still
 * `stopPropagation()` so a click on it doesn't ALSO fire the row's onClick.
 */

export default function DealTable({
  heads,
  rows,
  loading,
  empty,
}: {
  heads: DealTableHead[];
  rows: DealTableRow[];
  loading?: ReactNode;
  empty?: ReactNode;
}) {
  const onRowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, onClick?: () => void) => {
    if (!onClick) return;
    if (e.key === "Enter") onClick();
    // Space activates a link/button for keyboard users, but it ALSO scrolls
    // the page by default — preventDefault stops the scroll, matching how a
    // native <a>/<button> behaves.
    if (e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="bg-[#FAFBFC]">
            {heads.map((h, i) => (
              <th
                key={i}
                className={`whitespace-nowrap border-b border-[#EEF2F7] px-[18px] py-[10px] text-[11px] font-bold uppercase tracking-[.4px] text-slate-400 ${
                  h.align === "right" ? "text-right" : "text-left"
                }`}
              >
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td className="px-[18px] py-6 text-center text-slate-400" colSpan={heads.length}>
                {loading}
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td className="px-[18px] py-6 text-center text-slate-400" colSpan={heads.length}>
                {empty ?? "No records."}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr
                key={r.key}
                className={`border-b border-[#F4F6F9] hover:bg-slate-50 ${r.onClick ? "cursor-pointer" : ""}`}
                onClick={r.onClick}
                tabIndex={r.onClick ? 0 : undefined}
                role={r.onClick ? "link" : undefined}
                onKeyDown={(e) => onRowKeyDown(e, r.onClick)}
                aria-label={r.ariaLabel}
              >
                {r.cells.map((c, i) => (
                  <td key={i} className="px-[18px] py-3 align-middle">
                    {c}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
