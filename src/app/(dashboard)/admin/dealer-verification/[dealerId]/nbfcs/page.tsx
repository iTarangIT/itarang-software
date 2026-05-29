"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Loader2,
  Lock,
  Plus,
  RotateCcw,
  Search,
  XCircle,
} from "lucide-react";

// Admin · Dealer NBFC Exclusions
// /admin/dealer-verification/[dealerId]/nbfcs
//
// Routing model: A + D (auto-enroll, admin only blocks exceptions).
// Every NBFC whose loan product matches the lead's state/city/category is
// auto-enrolled. This page is an EXCEPTION manager — it lists NBFCs that
// the admin has explicitly excluded for this dealer.
//
// Wire-up:
//   GET  /api/admin/dealers/[dealerId]/nbfc-assignments?excluded=1  list blocks
//   POST /api/admin/dealers/[dealerId]/nbfc-assignments              create a block (status='suspended')
//   PATCH /api/admin/nbfc-assignments/[assignmentId]                 status='active' (un-block) or 'terminated' (permanent)
//   GET  /api/admin/nbfc/eligible-for-assignment                     candidate picker

type Assignment = {
  id: number;
  nbfcId: number;
  shortName: string;
  status: "active" | "suspended" | "terminated" | string;
  enabledAt: string | null;
  notes: string | null;
};

type EligibleNbfc = {
  id: number;
  nbfcId: string;
  shortName: string;
  legalName: string;
  status: string;
  activeLoanProductCount: number;
};

const STATUS_LABEL: Record<string, string> = {
  suspended: "Excluded",
  terminated: "Locked",
};

const STATUS_TONE: Record<string, string> = {
  suspended: "bg-amber-50 text-amber-700 border-amber-200",
  terminated: "bg-slate-100 text-slate-500 border-slate-200",
};

export default function DealerNbfcExclusionsPage() {
  const { dealerId } = useParams<{ dealerId: string }>();

  const [exclusions, setExclusions] = useState<Assignment[]>([]);
  const [eligible, setEligible] = useState<EligibleNbfc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [adding, setAdding] = useState<number | null>(null);
  const [patching, setPatching] = useState<number | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // We pull both 'suspended' and 'terminated' rows in parallel — both
      // represent blocks. 'active' rows are legacy and ignored.
      const [suspendedRes, terminatedRes, eRes] = await Promise.all([
        fetch(
          `/api/admin/dealers/${dealerId}/nbfc-assignments?status=suspended`,
          { credentials: "include" },
        ),
        fetch(
          `/api/admin/dealers/${dealerId}/nbfc-assignments?status=terminated`,
          { credentials: "include" },
        ),
        fetch(`/api/admin/nbfc/eligible-for-assignment`, {
          credentials: "include",
        }),
      ]);
      const suspendedJson = await suspendedRes.json();
      const terminatedJson = await terminatedRes.json();
      const eJson = await eRes.json();
      if (!suspendedRes.ok || !suspendedJson.success) {
        throw new Error(suspendedJson?.message || "Failed to load exclusions");
      }
      if (!terminatedRes.ok || !terminatedJson.success) {
        throw new Error(
          terminatedJson?.message || "Failed to load locked exclusions",
        );
      }
      if (!eRes.ok || !eJson.success) {
        throw new Error(eJson?.message || "Failed to load eligible NBFCs");
      }
      setExclusions([
        ...(suspendedJson.items ?? []),
        ...(terminatedJson.items ?? []),
      ]);
      setEligible(eJson.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [dealerId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const excludedNbfcIds = useMemo(
    () => new Set(exclusions.map((a) => a.nbfcId)),
    [exclusions],
  );

  const filteredPicker = useMemo(() => {
    const term = pickerSearch.trim().toLowerCase();
    return eligible
      .filter((n) => !excludedNbfcIds.has(n.id))
      .filter((n) => {
        if (!term) return true;
        return (
          n.shortName.toLowerCase().includes(term) ||
          n.legalName.toLowerCase().includes(term) ||
          n.nbfcId.toLowerCase().includes(term)
        );
      });
  }, [eligible, excludedNbfcIds, pickerSearch]);

  async function handleAddException(nbfcInternalId: number) {
    setAdding(nbfcInternalId);
    setError(null);
    try {
      const createRes = await fetch(
        `/api/admin/dealers/${dealerId}/nbfc-assignments`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nbfcId: nbfcInternalId,
            status: "suspended",
          }),
        },
      );
      const createJson = await createRes.json();
      if (!createRes.ok || !createJson.success) {
        // 409 — a row already exists (likely a legacy status='active' pairing
        // or a previously-removed exception). Reuse it and PATCH to suspended.
        if (createRes.status === 409 && createJson?.assignmentId) {
          await fetch(`/api/admin/nbfc-assignments/${createJson.assignmentId}`, {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "suspended" }),
          });
          await fetchAll();
          setPickerOpen(false);
          setPickerSearch("");
          return;
        }
        throw new Error(createJson?.message || "Failed to add exception");
      }
      await fetchAll();
      setPickerOpen(false);
      setPickerSearch("");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to add exception",
      );
    } finally {
      setAdding(null);
    }
  }

  async function handlePatch(
    assignmentId: number,
    nextStatus: "active" | "terminated",
  ) {
    setPatching(assignmentId);
    setError(null);
    try {
      const res = await fetch(`/api/admin/nbfc-assignments/${assignmentId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.message || "Failed to update exception");
      }
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setPatching(null);
    }
  }

  return (
    <div className="px-6 py-8 max-w-5xl mx-auto space-y-6">
      <div>
        <Link
          href={`/admin/dealer-verification/${dealerId}`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to dealer verification
        </Link>
      </div>

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
            Dealer · {dealerId}
          </p>
          <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
            Excluded NBFCs
          </h1>
          <p className="text-sm text-slate-500 mt-2 max-w-2xl">
            All NBFCs whose loan product geography and battery category match
            this dealer&apos;s leads are <b>auto-enrolled</b>. This page lists
            only the NBFCs you have explicitly excluded — they will not appear
            in this dealer&apos;s Section G.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[color:var(--color-brand-navy)] text-white text-sm font-semibold hover:opacity-90 transition"
        >
          <Plus className="w-4 h-4" />
          Add Exception
        </button>
      </header>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-800 px-4 py-3 text-sm flex items-start gap-2">
          <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {pickerOpen && (
        <section className="border border-slate-200 rounded-xl bg-white p-5 space-y-4">
          <div className="flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-lg">
            <Search className="w-4 h-4 text-slate-400" />
            <input
              autoFocus
              type="text"
              placeholder="Search by short name, legal name, or NBFC code…"
              value={pickerSearch}
              onChange={(e) => setPickerSearch(e.target.value)}
              className="flex-1 outline-none text-sm bg-transparent"
            />
            {pickerSearch && (
              <button
                type="button"
                className="text-xs text-slate-400 hover:text-slate-700"
                onClick={() => setPickerSearch("")}
              >
                clear
              </button>
            )}
          </div>

          {filteredPicker.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-6">
              {eligible.length - exclusions.length <= 0
                ? "Every eligible NBFC is already excluded for this dealer."
                : "No NBFCs match your search."}
            </p>
          ) : (
            <ul className="space-y-2 max-h-96 overflow-y-auto">
              {filteredPicker.map((n) => (
                <li
                  key={n.id}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-slate-200 hover:border-[color:var(--color-brand-sky)] transition"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-800 truncate">
                      {n.shortName}
                    </div>
                    <div className="text-xs text-slate-500 truncate">
                      {n.legalName} · {n.nbfcId}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {n.activeLoanProductCount} active loan product
                      {n.activeLoanProductCount === 1 ? "" : "s"}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={adding === n.id}
                    onClick={() => handleAddException(n.id)}
                    className="px-3 py-1.5 rounded-md bg-amber-600 text-white text-xs font-bold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-1.5"
                  >
                    {adding === n.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5" />
                    )}
                    Exclude
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="border border-slate-200 rounded-xl bg-white">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 px-5 pt-5 mb-3">
          Current exceptions
        </h2>
        {loading ? (
          <div className="px-5 py-10 text-center">
            <Loader2 className="w-5 h-5 animate-spin text-slate-400 mx-auto" />
          </div>
        ) : exclusions.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-semibold text-slate-700">
              No exceptions — all geo-matched NBFCs are auto-enrolled for this
              dealer.
            </p>
            <p className="text-xs text-slate-500 mt-2 max-w-md mx-auto">
              Click <b>Add Exception</b> above only if you need to block a
              specific NBFC from this dealer&apos;s Section G.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-5 py-3 text-left font-semibold">NBFC</th>
                <th className="px-5 py-3 text-left font-semibold">Since</th>
                <th className="px-5 py-3 text-left font-semibold">Type</th>
                <th className="px-5 py-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {exclusions.map((a) => {
                const isTerminated = a.status === "terminated";
                return (
                  <tr key={a.id} className="border-t border-slate-100">
                    <td className="px-5 py-3 font-medium text-slate-800">
                      {a.shortName}
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-500">
                      {a.enabledAt
                        ? new Date(a.enabledAt).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })
                        : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`inline-block px-2 py-1 rounded-md text-[11px] font-bold border ${
                          STATUS_TONE[a.status] ??
                          "bg-slate-50 text-slate-600 border-slate-200"
                        }`}
                      >
                        {STATUS_LABEL[a.status] ?? a.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="inline-flex gap-2">
                        {!isTerminated && (
                          <button
                            type="button"
                            disabled={patching === a.id}
                            onClick={() => handlePatch(a.id, "active")}
                            className="px-2.5 py-1.5 rounded-md text-xs font-bold border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 transition inline-flex items-center gap-1.5"
                            title="Remove this exception — NBFC will auto-enroll again if it matches the dealer's geo."
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            Remove Exception
                          </button>
                        )}
                        {!isTerminated && (
                          <button
                            type="button"
                            disabled={patching === a.id}
                            onClick={() => {
                              if (
                                !confirm(
                                  `Permanently lock ${a.shortName} for this dealer? This cannot be reversed.`,
                                )
                              )
                                return;
                              handlePatch(a.id, "terminated");
                            }}
                            className="px-2.5 py-1.5 rounded-md text-xs font-bold border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50 transition inline-flex items-center gap-1.5"
                          >
                            <Lock className="w-3.5 h-3.5" />
                            Lock Permanently
                          </button>
                        )}
                        {isTerminated && (
                          <span className="text-xs text-slate-400 italic">
                            permanent block
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-xs text-slate-400 leading-relaxed">
        Section G auto-enrolls every NBFC whose loan product&apos;s{" "}
        <code className="text-[11px] bg-slate-100 px-1.5 py-0.5 rounded">
          active_locations
        </code>{" "}
        and{" "}
        <code className="text-[11px] bg-slate-100 px-1.5 py-0.5 rounded">
          eligible_battery_categories
        </code>{" "}
        match this lead, then drops any pair listed here as <b>Excluded</b> or{" "}
        <b>Locked</b>.
      </p>
    </div>
  );
}
