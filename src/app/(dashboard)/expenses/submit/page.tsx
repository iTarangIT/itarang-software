"use client";

import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Upload, Receipt, CheckCircle2, XCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

const CATEGORIES = [
  "Travel",
  "Office",
  "Marketing",
  "Utilities",
  "Vehicle/Fuel",
  "Food/Hospitality",
  "Software/SaaS",
  "Misc",
];

interface Submission {
  id: string;
  category: string;
  amount: string;
  description: string | null;
  bill_url: string | null;
  status: "pending" | "approved" | "rejected";
  rejection_reason: string | null;
  created_at: string;
  approved_at: string | null;
}

function StatusBadge({ status }: { status: Submission["status"] }) {
  const styles = {
    pending: "bg-amber-50 text-amber-700 border-amber-200",
    approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
    rejected: "bg-rose-50 text-rose-700 border-rose-200",
  } as const;
  const Icon = status === "approved" ? CheckCircle2 : status === "rejected" ? XCircle : Clock;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${styles[status]}`}
    >
      <Icon className="w-3 h-3" />
      {status}
    </span>
  );
}

export default function SubmitExpensePage() {
  const qc = useQueryClient();
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [bill, setBill] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data: mineRaw, isLoading } = useQuery({
    queryKey: ["expenses-mine"],
    queryFn: async () => {
      const r = await fetch("/api/expenses/mine", { cache: "no-store" });
      if (!r.ok) throw new Error("Failed to load submissions");
      const j = await r.json();
      return (j.data || []) as Submission[];
    },
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      setFormError(null);
      setSuccessMsg(null);
      const fd = new FormData();
      fd.set("category", category);
      fd.set("amount", amount);
      if (description) fd.set("description", description);
      if (bill) fd.set("bill", bill);
      const r = await fetch("/api/expenses/submit", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok || !j.success) {
        throw new Error(j?.error?.message || "Submission failed");
      }
      return j;
    },
    onSuccess: () => {
      setAmount("");
      setDescription("");
      setBill(null);
      setSuccessMsg("Expense submitted — awaiting CEO approval.");
      qc.invalidateQueries({ queryKey: ["expenses-mine"] });
    },
    onError: (e: Error) => {
      setFormError(e.message);
    },
  });

  const mine = mineRaw || [];

  return (
    <div className="space-y-8 pb-12 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight flex items-center gap-2">
          <Receipt className="w-6 h-6 text-brand-600" />
          Submit Business Expense
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Upload the bill and submit for CEO approval. Approved expenses are reflected on the CEO dashboard.
        </p>
      </div>

      <form
        className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!amount) {
            setFormError("Amount is required.");
            return;
          }
          submitMutation.mutate();
        }}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5 uppercase tracking-wider">
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-900 bg-white focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1.5 uppercase tracking-wider">
              Amount (₹)
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-900 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              required
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1.5 uppercase tracking-wider">
            Description (optional)
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="What was this expense for?"
            className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-900 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 resize-none"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1.5 uppercase tracking-wider">
            Upload Bill (PDF or image, ≤ 5MB)
          </label>
          <div className="flex items-center gap-3">
            <label className="cursor-pointer inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-gray-300 bg-gray-50 hover:bg-gray-100 text-sm font-medium text-gray-700">
              <Upload className="w-4 h-4" />
              {bill ? bill.name : "Choose file"}
              <input
                type="file"
                className="hidden"
                accept="application/pdf,image/*"
                onChange={(e) => setBill(e.target.files?.[0] ?? null)}
              />
            </label>
            {bill && (
              <button
                type="button"
                onClick={() => setBill(null)}
                className="text-xs font-semibold text-rose-600 hover:underline"
              >
                Remove
              </button>
            )}
          </div>
        </div>

        {formError && (
          <div className="p-3 rounded-xl bg-rose-50 border border-rose-100 text-xs font-medium text-rose-700">
            {formError}
          </div>
        )}
        {successMsg && (
          <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-100 text-xs font-medium text-emerald-700">
            {successMsg}
          </div>
        )}

        <div className="flex justify-end pt-2">
          <Button
            type="submit"
            disabled={submitMutation.isPending}
            className="bg-brand-600 hover:bg-brand-700 text-white px-6"
          >
            {submitMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Submit Expense
          </Button>
        </div>
      </form>

      <div className="p-6 rounded-2xl bg-white border border-gray-100 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">My Submissions</h2>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
          </div>
        ) : mine.length === 0 ? (
          <p className="text-xs text-gray-400 italic">You haven't submitted any expenses yet.</p>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
                    <th className="py-2 pr-4 font-semibold">Date</th>
                    <th className="py-2 pr-4 font-semibold">Category</th>
                    <th className="py-2 pr-4 font-semibold">Amount</th>
                    <th className="py-2 pr-4 font-semibold">Status</th>
                    <th className="py-2 font-semibold">Bill</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((s) => (
                    <tr key={s.id} className="border-b border-gray-50">
                      <td className="py-3 pr-4 text-xs text-gray-600 whitespace-nowrap">
                        {new Date(s.created_at).toLocaleDateString("en-IN")}
                      </td>
                      <td className="py-3 pr-4 text-xs font-semibold text-gray-900">{s.category}</td>
                      <td className="py-3 pr-4 text-xs font-bold text-gray-900 whitespace-nowrap">
                        ₹{Number(s.amount).toLocaleString("en-IN")}
                      </td>
                      <td className="py-3 pr-4">
                        <StatusBadge status={s.status} />
                        {s.status === "rejected" && s.rejection_reason && (
                          <p className="text-[10px] text-rose-600 mt-1">{s.rejection_reason}</p>
                        )}
                      </td>
                      <td className="py-3 text-xs">
                        {s.bill_url ? (
                          <a
                            href={s.bill_url}
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards — separate each field so values don't collide */}
            <div className="md:hidden divide-y divide-gray-100">
              {mine.map((s) => (
                <div key={s.id} className="py-3 first:pt-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{s.category}</p>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        {new Date(s.created_at).toLocaleDateString("en-IN")}
                      </p>
                    </div>
                    <p className="text-sm font-bold text-gray-900 whitespace-nowrap">
                      ₹{Number(s.amount).toLocaleString("en-IN")}
                    </p>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div>
                      <StatusBadge status={s.status} />
                      {s.status === "rejected" && s.rejection_reason && (
                        <p className="text-[10px] text-rose-600 mt-1">{s.rejection_reason}</p>
                      )}
                    </div>
                    {s.bill_url ? (
                      <a
                        href={s.bill_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-brand-600 hover:underline font-semibold"
                      >
                        View bill
                      </a>
                    ) : (
                      <span className="text-xs text-gray-300">No bill</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
