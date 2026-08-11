"use client";

/**
 * E-070 — CancelLotApprovalQueue (BRD §6.3.4)
 *
 * Client component for the Auction Control Centre's "Cancel Lot Approval
 * Queue". Lists every pending Cancel Lot request and lets a *different* admin
 * approve or reject. The server enforces the actual self-approval rule
 * (HTTP 403); this UI surfaces the server response inline so the admin sees
 * why a click failed.
 *
 * The first-admin "request" surface (with MFA prompt + reason) lives on the
 * lot-detail page itself and POSTs to /api/admin/nbfc/auction/lot/cancel/request.
 * This queue handles only the second-admin approve/reject step.
 */
import { useCallback, useEffect, useState } from "react";

type PendingRow = {
  id: string;
  lot_id: string;
  reason: string;
  requested_by: string;
  requested_at: string;
  status: string;
  /** [E-234] Joined in by the approvals route so the row names a lot, not a uuid. */
  lot_code?: string | null;
  lot_title?: string | null;
  lot_status?: string | null;
  /** [E-234] The server 403s on self-approval; this lets the button say so first. */
  is_own_request?: boolean;
};

type ListResponse = { requests: PendingRow[] };

export default function CancelLotApprovalQueue() {
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorByRow, setErrorByRow] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        "/api/admin/nbfc/auction/lot/cancel/approvals",
        { cache: "no-store" },
      );
      if (!res.ok) {
        setRows([]);
        return;
      }
      const json = (await res.json()) as ListResponse;
      setRows(json.requests ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function decide(
    requestId: string,
    decision: "approve" | "reject",
  ): Promise<void> {
    setBusyId(requestId);
    setErrorByRow((prev) => {
      const next = { ...prev };
      delete next[requestId];
      return next;
    });
    try {
      const res = await fetch("/api/admin/nbfc/auction/lot/cancel/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: requestId, decision }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        setErrorByRow((prev) => ({
          ...prev,
          [requestId]: txt || `HTTP ${res.status}`,
        }));
        return;
      }
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return <div className="p-4 text-sm text-gray-500">Loading…</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="p-4 text-sm text-gray-500">
        No pending cancel-lot requests.
      </div>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead className="bg-gray-50 text-left">
        <tr>
          <th className="p-2">Lot</th>
          <th className="p-2">Reason</th>
          <th className="p-2">Requested by</th>
          <th className="p-2">Requested at</th>
          <th className="p-2">Action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-t align-top">
            <td className="p-2">
              <div className="font-mono text-xs font-semibold">
                {r.lot_code ?? r.lot_id}
              </div>
              {r.lot_title ? (
                <div className="text-xs text-gray-500">{r.lot_title}</div>
              ) : null}
              {r.lot_status ? (
                <div className="text-[11px] uppercase tracking-wide text-gray-400">
                  {r.lot_status}
                </div>
              ) : null}
            </td>
            <td className="p-2">{r.reason}</td>
            <td className="p-2 font-mono text-xs">
              {r.requested_by}
              {r.is_own_request ? (
                <div className="mt-1 text-[11px] font-sans text-amber-700">
                  You raised this — a second admin must decide.
                </div>
              ) : null}
            </td>
            <td className="p-2">
              {new Date(r.requested_at).toLocaleString()}
            </td>
            <td className="p-2 space-x-2">
              <button
                type="button"
                disabled={busyId === r.id || r.is_own_request}
                title={
                  r.is_own_request
                    ? "Cancelling a lot needs two different admins"
                    : undefined
                }
                onClick={() => void decide(r.id, "approve")}
                className="rounded bg-red-600 px-3 py-1 text-white disabled:opacity-50"
              >
                Approve cancel
              </button>
              <button
                type="button"
                disabled={busyId === r.id || r.is_own_request}
                onClick={() => void decide(r.id, "reject")}
                className="rounded border px-3 py-1 disabled:opacity-50"
              >
                Reject
              </button>
              {errorByRow[r.id] ? (
                <div className="mt-1 text-xs text-red-600">
                  {errorByRow[r.id]}
                </div>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
