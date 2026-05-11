"use client";

/**
 * E-068 — RiskRuleApprovalQueue
 *
 * Client component for /admin/nbfc/risk-rules/approvals. Lists every pending
 * threshold change request and lets a *different* admin approve or reject.
 * The server enforces the actual self-approval rule (HTTP 403); this UI
 * surfaces the server response inline so the admin sees why a click failed.
 */
import { useCallback, useEffect, useState } from "react";

type PendingRow = {
  id: string;
  rule_key: string;
  previous_value: string;
  new_value: string;
  requested_by: string;
  requested_at: string;
  status: string;
};

type ListResponse = { requests: PendingRow[] };

export default function RiskRuleApprovalQueue() {
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorByRow, setErrorByRow] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/nbfc/risk-rules/approvals", {
        cache: "no-store",
      });
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

  const decide = useCallback(
    async (id: string, decision: "approve" | "reject") => {
      setBusyId(id);
      setErrorByRow((m) => ({ ...m, [id]: "" }));
      try {
        const res = await fetch("/api/admin/nbfc/risk-rules/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ request_id: id, decision }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
          status?: string;
        };
        if (!res.ok) {
          setErrorByRow((m) => ({
            ...m,
            [id]: json.error ?? `HTTP ${res.status}`,
          }));
          return;
        }
        await reload();
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  if (loading) {
    return <p className="text-sm text-gray-500">Loading pending changes…</p>;
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-gray-600">
        No pending threshold changes awaiting Risk Head approval.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase text-gray-600">
          <tr>
            <th className="px-3 py-2">Rule</th>
            <th className="px-3 py-2">Current</th>
            <th className="px-3 py-2">Proposed</th>
            <th className="px-3 py-2">Requested by</th>
            <th className="px-3 py-2">Requested at</th>
            <th className="px-3 py-2">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 font-mono text-xs">{r.rule_key}</td>
              <td className="px-3 py-2">{r.previous_value}</td>
              <td className="px-3 py-2 font-semibold">{r.new_value}</td>
              <td className="px-3 py-2 font-mono text-xs text-gray-500">
                {r.requested_by.slice(0, 8)}…
              </td>
              <td className="px-3 py-2 text-xs text-gray-500">
                {new Date(r.requested_at).toLocaleString()}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-col gap-1">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => decide(r.id, "approve")}
                      className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => decide(r.id, "reject")}
                      className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                  {errorByRow[r.id] ? (
                    <span className="text-xs text-red-600">
                      {errorByRow[r.id]}
                    </span>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
