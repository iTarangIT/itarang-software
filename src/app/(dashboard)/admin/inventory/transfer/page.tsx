"use client";

// BRD V2 §5.4 — Admin inter-dealer transfer.
// Pick source dealer → list their available serials → check the ones to move
// → pick target dealer → enter reason → submit. Initiated transfers show in
// the bottom panel.

import { useEffect, useMemo, useState } from "react";
import { Loader2, ArrowRightLeft, AlertTriangle, CheckCircle2 } from "lucide-react";

interface DealerOption {
  id: string;
  business_entity_name: string;
}

interface InventoryRow {
  id: string;
  serialNumber: string | null;
  category: string | null;
  subCategory: string | null;
  modelNumber: string | null;
  status: string;
}

interface TransferRow {
  id: string;
  source_dealer_id: string;
  target_dealer_id: string;
  serials: string[];
  reason: string | null;
  status: string;
  initiated_at: string;
  acknowledged_at: string | null;
}

export default function AdminInventoryTransferPage() {
  const [dealers, setDealers] = useState<DealerOption[]>([]);
  const [sourceDealerId, setSourceDealerId] = useState("");
  const [targetDealerId, setTargetDealerId] = useState("");
  const [reason, setReason] = useState("");
  const [available, setAvailable] = useState<InventoryRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingItems, setLoadingItems] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [recent, setRecent] = useState<TransferRow[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);

  // Load dealers + recent transfers on mount.
  useEffect(() => {
    (async () => {
      try {
        const [dr, tr] = await Promise.all([
          fetch("/api/admin/dealers?limit=500").then((r) => r.json()),
          fetch("/api/admin/inventory/transfer").then((r) => r.json()),
        ]);
        if (dr.success) setDealers(dr.data || []);
        if (tr.success) setRecent(tr.data?.rows || []);
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  // Load available items whenever source dealer changes.
  useEffect(() => {
    setSelected(new Set());
    if (!sourceDealerId) {
      setAvailable([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingItems(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/inventory/all?dealerId=${encodeURIComponent(sourceDealerId)}&status=available&limit=500`,
        );
        const json = await res.json();
        if (cancelled) return;
        if (json.success) setAvailable(json.data?.items || []);
        else setError(json.error?.message || "Failed to load source inventory");
      } catch {
        if (!cancelled) setError("Failed to load source inventory");
      } finally {
        if (!cancelled) setLoadingItems(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceDealerId]);

  const reloadRecent = async () => {
    setLoadingRecent(true);
    try {
      const res = await fetch("/api/admin/inventory/transfer");
      const json = await res.json();
      if (json.success) setRecent(json.data?.rows || []);
    } finally {
      setLoadingRecent(false);
    }
  };

  const dealerById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of dealers) m.set(d.id, d.business_entity_name);
    return m;
  }, [dealers]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(available.map((r) => r.serialNumber ?? "").filter(Boolean)));
  };
  const clearAll = () => setSelected(new Set());

  const canSubmit =
    sourceDealerId &&
    targetDealerId &&
    sourceDealerId !== targetDealerId &&
    selected.size > 0 &&
    reason.trim().length >= 5;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/admin/inventory/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceDealerId,
          targetDealerId,
          serials: [...selected],
          reason: reason.trim(),
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message || "Failed to initiate transfer");
        return;
      }
      setInfo(
        `Transfer ${json.data.transferId} initiated. ${json.data.serialCount} item${json.data.serialCount === 1 ? "" : "s"} marked transferred_out.`,
      );
      setSelected(new Set());
      setReason("");
      await reloadRecent();
      // Refresh source list
      const refresh = await fetch(
        `/api/admin/inventory/all?dealerId=${encodeURIComponent(sourceDealerId)}&status=available&limit=500`,
      ).then((r) => r.json());
      if (refresh.success) setAvailable(refresh.data?.items || []);
    } catch {
      setError("Failed to initiate transfer");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      <div className="max-w-[1400px] mx-auto px-6 py-8 space-y-6">
        <header>
          <h1 className="text-[28px] font-black text-gray-900 tracking-tight">
            Inter-Dealer Transfer
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Move available stock between dealers. Selected items are locked
            (status = transferred_out) until the target dealer acknowledges receipt.
          </p>
        </header>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {info && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">
            <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{info}</span>
          </div>
        )}

        <section className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-1">
                Source Dealer
              </label>
              <select
                value={sourceDealerId}
                onChange={(e) => setSourceDealerId(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              >
                <option value="">Select…</option>
                {dealers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.business_entity_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-1">
                Target Dealer
              </label>
              <select
                value={targetDealerId}
                onChange={(e) => setTargetDealerId(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              >
                <option value="">Select…</option>
                {dealers
                  .filter((d) => d.id !== sourceDealerId)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.business_entity_name}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-1">
              Reason (visible in audit trail)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="e.g. Rebalancing slow-moving 3W stock"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          {/* Available serials grid */}
          {sourceDealerId && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-gray-700">
                  Available serials ({available.length}) ·{" "}
                  <span className="text-[#0047AB]">{selected.size} selected</span>
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={selectAll}
                    className="text-xs font-bold text-[#0047AB] hover:underline"
                  >
                    Select all
                  </button>
                  <span className="text-gray-300">·</span>
                  <button
                    onClick={clearAll}
                    className="text-xs font-bold text-gray-500 hover:underline"
                  >
                    Clear
                  </button>
                </div>
              </div>
              {loadingItems ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                </div>
              ) : available.length === 0 ? (
                <p className="text-xs text-gray-400 py-6 text-center">
                  Source dealer has no available serials.
                </p>
              ) : (
                <div className="border border-gray-100 rounded-xl max-h-[320px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">
                        <th className="px-3 py-2 w-8"></th>
                        <th className="px-3 py-2 text-left">Serial</th>
                        <th className="px-3 py-2 text-left">Category</th>
                        <th className="px-3 py-2 text-left">Asset Type</th>
                        <th className="px-3 py-2 text-left">Model</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {available.map((r) => {
                        const sn = r.serialNumber ?? "";
                        const checked = selected.has(sn);
                        return (
                          <tr
                            key={r.id}
                            className={`cursor-pointer ${checked ? "bg-blue-50/40" : "hover:bg-gray-50"}`}
                            onClick={() => sn && toggle(sn)}
                          >
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => sn && toggle(sn)}
                              />
                            </td>
                            <td className="px-3 py-2 font-mono">{sn || "—"}</td>
                            <td className="px-3 py-2">{r.category ?? "—"}</td>
                            <td className="px-3 py-2">{r.subCategory ?? "—"}</td>
                            <td className="px-3 py-2">{r.modelNumber ?? "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-end pt-2 border-t border-gray-100">
            <button
              onClick={handleSubmit}
              disabled={!canSubmit || submitting}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#0047AB] hover:bg-[#003580] text-white rounded-xl font-bold text-sm transition-colors disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ArrowRightLeft className="w-4 h-4" />
              )}
              {submitting ? "Initiating…" : `Transfer ${selected.size} item${selected.size === 1 ? "" : "s"}`}
            </button>
          </div>
        </section>

        {/* Recent transfers */}
        <section className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="font-bold text-gray-900">Recent transfers</h2>
            <button
              onClick={reloadRecent}
              className="text-xs font-bold text-[#0047AB] hover:underline"
            >
              {loadingRecent ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {recent.length === 0 ? (
            <div className="text-center py-10 text-gray-400 text-sm">
              No transfers yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500 font-bold">
                  <tr>
                    <th className="px-3 py-2 text-left">Transfer ID</th>
                    <th className="px-3 py-2 text-left">Source</th>
                    <th className="px-3 py-2 text-left">Target</th>
                    <th className="px-3 py-2 text-right">Serials</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-left">Initiated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {recent.map((t) => (
                    <tr key={t.id}>
                      <td className="px-3 py-2 font-mono text-[11px]">{t.id}</td>
                      <td className="px-3 py-2">
                        {dealerById.get(t.source_dealer_id) ?? t.source_dealer_id}
                      </td>
                      <td className="px-3 py-2">
                        {dealerById.get(t.target_dealer_id) ?? t.target_dealer_id}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Array.isArray(t.serials) ? t.serials.length : 0}
                      </td>
                      <td className="px-3 py-2">
                        <TransferStatusBadge status={t.status} />
                      </td>
                      <td className="px-3 py-2 text-gray-500">
                        {new Date(t.initiated_at).toLocaleString("en-IN")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function TransferStatusBadge({ status }: { status: string }) {
  const cls =
    status === "completed"
      ? "bg-emerald-50 text-emerald-700"
      : status === "cancelled"
        ? "bg-gray-100 text-gray-600"
        : "bg-amber-50 text-amber-700";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${cls}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
