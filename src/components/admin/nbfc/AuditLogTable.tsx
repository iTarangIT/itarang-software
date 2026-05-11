"use client";

/**
 * E-071 — Admin Audit Log table (BRD §6.3.5).
 *
 * Renders the paginated, filterable audit log. The columns mirror the BRD
 * table — Timestamp, IMEI/Entity, Action, Reason Code, Requested By,
 * Approved By, Exec. Status.
 */
import { useEffect, useMemo, useState } from "react";
import AuditLogFilters, { type AuditLogFilterValue } from "./AuditLogFilters";

type AuditRow = {
  id: string;
  timestamp: string | null;
  entity_id: string | null;
  action: string | null;
  reason_code: string | null;
  requested_by: { id: string | null; name: string | null; role: string | null };
  approved_by: { id: string | null; name: string | null; role: string | null };
  exec_status: "executed" | "pending" | "rejected" | null;
};

type Response = {
  rows: AuditRow[];
  page: number;
  page_size: number;
  total: number;
};

type Props = {
  fetcher?: typeof fetch;
};

export default function AuditLogTable({ fetcher }: Props) {
  const f = fetcher ?? fetch;
  const [filters, setFilters] = useState<AuditLogFilterValue>({});
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Response | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.from) p.set("from", new Date(filters.from).toISOString());
    if (filters.to) p.set("to", new Date(filters.to).toISOString());
    if (filters.action) p.set("action", filters.action);
    if (filters.requestedBy) p.set("requestedBy", filters.requestedBy);
    if (filters.status) p.set("status", filters.status);
    if (filters.entityId) p.set("entityId", filters.entityId);
    p.set("page", String(page));
    p.set("page_size", "50");
    return p.toString();
  }, [filters, page]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const res = await f(`/api/audit-log?${qs}`);
        if (cancelled) return;
        if (!res.ok) {
          setErr(`HTTP ${res.status}`);
          setLoading(false);
          return;
        }
        const body = (await res.json()) as Response;
        if (cancelled) return;
        setData(body);
        setErr(null);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [qs, f]);

  return (
    <div data-testid="audit-log-table" className="space-y-4">
      <AuditLogFilters
        initial={filters}
        onChange={(next) => {
          setPage(1);
          setFilters(next);
        }}
      />
      {err ? (
        <div data-testid="audit-log-error" className="text-sm text-red-600">
          {err}
        </div>
      ) : null}
      {loading ? (
        <div data-testid="audit-log-loading" className="text-sm text-gray-500">
          Loading…
        </div>
      ) : null}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b bg-gray-50 text-left">
            <th className="px-2 py-1">Timestamp</th>
            <th className="px-2 py-1">Entity</th>
            <th className="px-2 py-1">Action</th>
            <th className="px-2 py-1">Reason</th>
            <th className="px-2 py-1">Requested By</th>
            <th className="px-2 py-1">Approved By</th>
            <th className="px-2 py-1">Status</th>
          </tr>
        </thead>
        <tbody>
          {(data?.rows ?? []).map((r) => (
            <tr key={r.id} className="border-b">
              <td className="px-2 py-1">{r.timestamp ?? "—"}</td>
              <td className="px-2 py-1">{r.entity_id ?? "—"}</td>
              <td className="px-2 py-1">{r.action ?? "—"}</td>
              <td className="px-2 py-1">{r.reason_code ?? "—"}</td>
              <td className="px-2 py-1">
                {r.requested_by.name ?? r.requested_by.id ?? "—"}
                {r.requested_by.role ? (
                  <span className="ml-1 text-xs text-gray-500">
                    ({r.requested_by.role})
                  </span>
                ) : null}
              </td>
              <td className="px-2 py-1">
                {r.approved_by.name ?? r.approved_by.id ?? "—"}
                {r.approved_by.role ? (
                  <span className="ml-1 text-xs text-gray-500">
                    ({r.approved_by.role})
                  </span>
                ) : null}
              </td>
              <td className="px-2 py-1">{r.exec_status ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between text-xs">
        <div data-testid="audit-log-total">
          Total: {data?.total ?? 0} | Page {data?.page ?? 1}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="audit-log-prev"
            disabled={page <= 1}
            className="rounded border px-2 py-1 disabled:opacity-50"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </button>
          <button
            type="button"
            data-testid="audit-log-next"
            disabled={
              !data ||
              data.page * data.page_size >= data.total
            }
            className="rounded border px-2 py-1 disabled:opacity-50"
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
