"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, CheckCircle2, XCircle, Clock, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

type Status = "pending" | "approved" | "rejected";

interface ExpenseRow {
  id: string;
  category: string;
  amount: string;
  description: string | null;
  bill_url: string | null;
  status: Status;
  rejection_reason: string | null;
  created_at: string;
  approved_at: string | null;
  submitter_name: string | null;
  submitter_email: string | null;
  submitter_role: string | null;
}

export default function CEOExpenseApprovalsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Status>("pending");
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const { data: rows, isLoading } = useQuery({
    queryKey: ["admin-expenses", tab],
    queryFn: async () => {
      const r = await fetch(`/api/admin/expenses?status=${tab}`, { cache: "no-store" });
      if (!r.ok) throw new Error("Failed to load");
      const j = await r.json();
      return (j.data || []) as ExpenseRow[];
    },
  });

  const approve = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/expenses/${id}/approve`, { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Approve failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-expenses"] });
      qc.invalidateQueries({ queryKey: ["dashboard-metrics", "ceo"] });
    },
  });

  const reject = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const r = await fetch(`/api/admin/expenses/${id}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) throw new Error(j?.error?.message || "Reject failed");
    },
    onSuccess: () => {
      setRejecting(null);
      setReason("");
      qc.invalidateQueries({ queryKey: ["admin-expenses"] });
      qc.invalidateQueries({ queryKey: ["dashboard-metrics", "ceo"] });
    },
  });

  const tabClass = (t: Status) =>
    `px-4 py-2 text-xs font-semibold rounded-lg transition-colors ${
      tab === t
        ? "bg-brand-600 text-white"
        : "bg-gray-50 text-gray-600 hover:bg-gray-100"
    }`;

  return (
    <div className="space-y-8 pb-12">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight flex items-center gap-2">
            <FileText className="w-6 h-6 text-brand-600" />
            Expense Approvals
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Approve business expenses submitted across iTarang. Approved
            expenses count toward "Other Business Expenses (MTD)" on your dashboard.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button className={tabClass("pending")} onClick={() => setTab("pending")}>
          <Clock className="inline w-3.5 h-3.5 mr-1.5" />
          Pending
        </button>
        <button className={tabClass("approved")} onClick={() => setTab("approved")}>
          <CheckCircle2 className="inline w-3.5 h-3.5 mr-1.5" />
          Approved
        </button>
        <button className={tabClass("rejected")} onClick={() => setTab("rejected")}>
          <XCircle className="inline w-3.5 h-3.5 mr-1.5" />
          Rejected
        </button>
      </div>

      <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : !rows || rows.length === 0 ? (
          <p className="text-sm text-gray-400 italic py-6 text-center">
            No {tab} expenses.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
                  <th className="py-2 font-semibold">Submitted</th>
                  <th className="py-2 font-semibold">Submitter</th>
                  <th className="py-2 font-semibold">Category</th>
                  <th className="py-2 font-semibold">Amount</th>
                  <th className="py-2 font-semibold">Description</th>
                  <th className="py-2 font-semibold">Bill</th>
                  {tab === "pending" && <th className="py-2 font-semibold text-right">Action</th>}
                  {tab === "rejected" && <th className="py-2 font-semibold">Reason</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-gray-50 align-top">
                    <td className="py-3 text-xs text-gray-600">
                      {new Date(row.created_at).toLocaleDateString("en-IN")}
                    </td>
                    <td className="py-3 text-xs">
                      <p className="font-semibold text-gray-900">
                        {row.submitter_name || "—"}
                      </p>
                      <p className="text-[10px] text-gray-400 uppercase tracking-wider">
                        {row.submitter_role || ""}
                      </p>
                    </td>
                    <td className="py-3 text-xs font-semibold text-gray-900">{row.category}</td>
                    <td className="py-3 text-xs font-bold text-gray-900">
                      ₹{Number(row.amount).toLocaleString("en-IN")}
                    </td>
                    <td className="py-3 text-xs text-gray-600 max-w-xs">
                      {row.description || <span className="text-gray-300">—</span>}
                    </td>
                    <td className="py-3 text-xs">
                      {row.bill_url ? (
                        <a
                          href={row.bill_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-brand-600 hover:underline font-semibold"
                        >
                          View
                        </a>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    {tab === "pending" && (
                      <td className="py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            className="bg-emerald-600 hover:bg-emerald-700 text-white"
                            disabled={approve.isPending}
                            onClick={() => approve.mutate(row.id)}
                          >
                            {approve.isPending && approve.variables === row.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              "Approve"
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-rose-200 text-rose-700 hover:bg-rose-50"
                            onClick={() => {
                              setRejecting(row.id);
                              setReason("");
                            }}
                          >
                            Reject
                          </Button>
                        </div>
                      </td>
                    )}
                    {tab === "rejected" && (
                      <td className="py-3 text-xs text-rose-600">
                        {row.rejection_reason || "—"}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {rejecting && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-xl">
            <h3 className="text-base font-bold text-gray-900 mb-2">Reject Expense</h3>
            <p className="text-xs text-gray-500 mb-4">
              Optional reason — visible to the submitter on their history page.
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="e.g. Bill missing GST number, please re-upload"
              className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 resize-none"
            />
            <div className="flex justify-end gap-2 mt-4">
              <Button
                variant="outline"
                onClick={() => {
                  setRejecting(null);
                  setReason("");
                }}
              >
                Cancel
              </Button>
              <Button
                className="bg-rose-600 hover:bg-rose-700 text-white"
                disabled={reject.isPending}
                onClick={() => reject.mutate({ id: rejecting, reason })}
              >
                {reject.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Reject
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
