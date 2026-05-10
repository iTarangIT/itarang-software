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
          <tr key={r.id} className="border-t">
            <td className="p-2 font-mono text-xs">{r.lot_id}</td>
            <td className="p-2">{r.reason}</td>
            <td className="p-2 font-mono text-xs">{r.requested_by}</td>
            <td className="p-2">
              {new Date(r.requested_at).toLocaleString()}
            </td>
            <td className="p-2 space-x-2">
              <button
                type="button"
                disabled={busyId === r.id}
                onClick={() => void decide(r.id, "approve")}
                className="rounded bg-red-600 px-3 py-1 text-white disabled:opacity-50"
              >
                Approve cancel
              </button>
              <button
                type="button"
                disabled={busyId === r.id}
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
