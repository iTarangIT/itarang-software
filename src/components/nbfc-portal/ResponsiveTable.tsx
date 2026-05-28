"use client";

/**
 * ResponsiveTable — the canonical data-table primitive for the NBFC portal.
 *
 * NBFC screens carry dense tables (Leads 9 cols, Batteries 12 cols, Audit 6).
 * On phones a horizontal-scroll table is unreadable, so this component renders
 * two ways from a single column config:
 *  - ≥ md (768px): a real <table>.
 *  - < md: a stacked card list — `primary` columns form the card header, the
 *    rest render as label/value pairs.
 *
 * Used by Lead Intelligence, Battery Monitoring, Audit Log, the immobilisation
 * list and auction settlements.
 */
import type { ReactNode } from "react";

export type ResponsiveColumn<T> = {
  /** Stable identifier for the column. */
  key: string;
  /** Column header text. */
  header: string;
  /** Cell renderer. */
  render: (row: T) => ReactNode;
  /** Desktop cell alignment. */
  align?: "left" | "right" | "center";
  /**
   * Mobile placement:
   *  - "primary": rendered in the card header row (name left / badge right).
   *  - "hidden": omitted on mobile (detail lives in a drawer).
   *  - undefined: rendered as a label/value pair in the card body.
   */
  mobile?: "primary" | "hidden";
  /** When true, the label/value pair spans the full card width on mobile. */
  mobileFullWidth?: boolean;
  headerClassName?: string;
  cellClassName?: string;
};

const alignClass = (a?: string) =>
  a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";

export default function ResponsiveTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyMessage = "No records found.",
  caption,
}: {
  columns: ResponsiveColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  caption?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="card-iTarang p-8 text-center text-sm text-[color:var(--color-ink-muted)]">
        {emptyMessage}
      </div>
    );
  }

  const primary = columns.filter((c) => c.mobile === "primary");
  const bodyCols = columns.filter(
    (c) => c.mobile !== "primary" && c.mobile !== "hidden",
  );

  return (
    <>
      {/* Desktop / tablet: real table */}
      <div className="hidden md:block card-iTarang overflow-x-auto">
        <table className="w-full text-sm text-[color:var(--color-ink)]">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead>
            <tr className="border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)]">
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={`px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-muted)] ${alignClass(
                    col.align,
                  )} ${col.headerClassName ?? ""}`}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={rowKey(row, i)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                role={onRowClick ? "button" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                className={`border-b border-[color:var(--color-border)] last:border-none transition-colors ${
                  onRowClick
                    ? "cursor-pointer hover:bg-[color:var(--brand-sky-soft)]"
                    : ""
                }`}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-3 py-2.5 align-middle ${alignClass(
                      col.align,
                    )} ${col.cellClassName ?? ""}`}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: card stack */}
      <div className="md:hidden space-y-3">
        {rows.map((row, i) => {
          const interactive = Boolean(onRowClick);
          return (
            <div
              key={rowKey(row, i)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              role={interactive ? "button" : undefined}
              tabIndex={interactive ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
              className={`card-iTarang p-4 ${
                interactive
                  ? "cursor-pointer transition-colors active:bg-[color:var(--brand-sky-soft)]"
                  : ""
              }`}
            >
              {primary.length > 0 ? (
                <div className="flex items-start justify-between gap-3 mb-3">
                  {primary.map((col) => (
                    <div key={col.key} className="min-w-0">
                      {col.render(row)}
                    </div>
                  ))}
                </div>
              ) : null}
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                {bodyCols.map((col) => (
                  <div
                    key={col.key}
                    className={`min-w-0 ${col.mobileFullWidth ? "col-span-2" : ""}`}
                  >
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-muted)]">
                      {col.header}
                    </dt>
                    <dd className="mt-0.5 break-words text-sm text-[color:var(--color-ink)]">
                      {col.render(row)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
      </div>
    </>
  );
}
