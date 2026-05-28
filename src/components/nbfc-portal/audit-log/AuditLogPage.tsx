"use client";

/**
 * NBFC Portal — Audit Log page (BRD §6.3.5).
 *
 * Unified single-table view. Replaces the old Risk Runs / Borrower Actions
 * tabs with one filterable feed merging:
 *   - nbfc_audit_log
 *   - nbfc_borrower_actions
 *   - nbfc_immobilisation_actions
 *
 * Fintech-grade layout: sticky filter bar, status pills, dense rows,
 * monospaced timestamps, side-drawer detail view, CSV export with purpose
 * declaration.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import {
  AuditLogFiltersState,
  AuditLogResponse,
  AuditLogRow,
  AuditLogUser,
  EMPTY_FILTERS,
  ACTION_LABELS,
  buildQueryString,
} from "./types";
import AuditLogFilters from "./AuditLogFilters";
import AuditLogRowItem from "./AuditLogRow";
import AuditLogDetailDrawer from "./AuditLogDetailDrawer";
import ExportPurposeModal from "./ExportPurposeModal";

interface Props {
  tenantName: string;
  initialEntityId?: string;
}

export function AuditLogPage({ tenantName, initialEntityId }: Props) {
  const [filters, setFilters] = useState<AuditLogFiltersState>({
    ...EMPTY_FILTERS,
    entityId: initialEntityId ?? "",
  });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AuditLogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditLogRow | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const reqIdRef = useRef(0);

  const fetchData = useCallback(
    async (
      f: AuditLogFiltersState,
      p: number,
      opts: { silent?: boolean } = {},
    ) => {
      const myId = ++reqIdRef.current;
      if (!opts.silent) setLoading(true);
      setError(null);
      try {
        const qs = buildQueryString(f, { page: p, limit: 50 });
        const res = await fetch(`/api/nbfc/audit-log?${qs}`, {
          cache: "no-store",
        });
        const body: AuditLogResponse | { ok: false; error: string } =
          await res.json();
        if (reqIdRef.current !== myId) return;
        if (!res.ok || !("items" in body)) {
          setError(
            "error" in body && typeof body.error === "string"
              ? body.error
              : `HTTP ${res.status}`,
          );
          return;
        }
        setData(body);
      } catch (e) {
        if (reqIdRef.current !== myId) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (reqIdRef.current === myId && !opts.silent) setLoading(false);
      }
    },
    [],
  );

  // Initial load + reload on filter / page change. We debounce the entityId
  // text input (300ms) so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => fetchData(filters, page), 300);
    return () => clearTimeout(t);
  }, [filters, page, fetchData]);

  const requesters: AuditLogUser[] = data?.requesters ?? [];
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.page_size ?? 50;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  const filtersSummary = useMemo(() => {
    const parts: string[] = [];
    if (filters.from || filters.to) {
      parts.push(`${filters.from || "…"} → ${filters.to || "now"}`);
    }
    if (filters.action) parts.push(ACTION_LABELS[filters.action] ?? filters.action);
    if (filters.status) parts.push(filters.status.replace(/_/g, " "));
    if (filters.requestedBy) parts.push(`user: ${filters.requestedBy.slice(0, 8)}…`);
    if (filters.entityId) parts.push(`entity contains "${filters.entityId}"`);
    return parts.length ? parts.join(" · ") : "No filters applied";
  }, [filters]);

  async function downloadCsv(purpose: string) {
    const qs = buildQueryString(filters, { format: "csv", purpose });
    const url = `/api/nbfc/audit-log?${qs}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        typeof body?.error === "string" ? body.error : `HTTP ${res.status}`,
      );
    }
    const blob = await res.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    const disp = res.headers.get("Content-Disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disp);
    link.download = match?.[1] ?? "nbfc-audit-log.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    // Refresh so the export's own audit row appears.
    fetchData(filters, page, { silent: true });
  }

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
            Compliance · BRD §6.3.5
          </p>
          <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)]">
            Audit Log
          </h1>
          <p className="text-sm text-[color:var(--color-ink-muted)]">
            Every privileged action across {tenantName} — immutable, timestamped, filterable.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fetchData(filters, page)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-1.5 text-xs font-semibold text-[color:var(--color-ink)] hover:bg-slate-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
        </div>
      </header>

      <AuditLogFilters
        value={filters}
        onChange={(next) => {
          setFilters(next);
          setPage(1);
        }}
        requesters={requesters}
        resultCount={total}
      />

      <div className="overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-sm">
            <thead className="bg-[color:var(--color-bg)] text-[10px] uppercase tracking-widest text-[color:var(--color-ink-muted)]">
              <tr>
                <Th>Timestamp</Th>
                <Th>Entity</Th>
                <Th>Action</Th>
                <Th>Reason</Th>
                <Th>Requested by</Th>
                <Th>Approved by</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {error ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-red-600">
                    Error: {error}
                  </td>
                </tr>
              ) : loading && items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-[color:var(--color-ink-muted)]">
                    Loading audit events…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-[color:var(--color-ink-muted)]">
                    No audit events match these filters.
                  </td>
                </tr>
              ) : (
                items.map((row) => (
                  <AuditLogRowItem
                    key={row.id}
                    row={row}
                    onClick={() => setSelected(row)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        <footer className="flex items-center justify-between border-t border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-4 py-2 text-xs text-[color:var(--color-ink-muted)]">
          <span className="tabular-nums">
            {items.length === 0
              ? "0 of 0"
              : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total.toLocaleString("en-IN")}`}
          </span>
          <div className="flex items-center gap-1">
            <PageButton
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </PageButton>
            <span className="px-2 tabular-nums">
              Page {page} / {lastPage}
            </span>
            <PageButton
              disabled={page >= lastPage || loading}
              onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
            >
              Next
            </PageButton>
          </div>
        </footer>
      </div>

      <AuditLogDetailDrawer row={selected} onClose={() => setSelected(null)} />
      <ExportPurposeModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        onConfirm={downloadCsv}
        filtersSummary={filtersSummary}
        rowCount={total}
      />
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="whitespace-nowrap px-4 py-2.5 text-left font-semibold">
      {children}
    </th>
  );
}

function PageButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2.5 py-1 text-xs font-medium text-[color:var(--color-ink)] hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export default AuditLogPage;
