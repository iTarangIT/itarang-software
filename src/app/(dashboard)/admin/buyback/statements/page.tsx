"use client";

/**
 * Bank reconciliation (M13 / U9 — the STATEMENT method).
 *
 * Upload the bank's CSV/XLSX; the rows that look like settlements iTarang is
 * owed, or owes, come back with a deal pencilled against them. An admin confirms
 * or ignores each one.
 *
 * TWO THINGS THIS SCREEN DELIBERATELY DOES NOT DO:
 *
 *  · It never shows the row's own amount as "the" settlement amount. What gets
 *    recorded is derived server-side from the locks, and the confirm call refuses
 *    the row if the two disagree — so the amount you see here is the BANK's
 *    claim, and confirming is you saying "yes, that is our payment", not "yes,
 *    that is what it was worth".
 *
 *  · It has no "confirm all". The matcher is a suggestion engine; a bulk-accept
 *    button would turn it into an unattended payment system, which is precisely
 *    the thing the confirm route is built to prevent.
 */

import { useEffect, useState } from "react";

import { inr } from "@/lib/buyback/format";

interface StatementImport {
  id: string;
  filename: string;
  account_label: string | null;
  row_count: number;
  matched_count: number;
  suggested_count: number;
  ignored_count: number;
  imported_by: string | null;
  created_at: string;
}

interface StatementRow {
  id: string;
  txn_date: string;
  amount: string;
  txn_ref: string | null;
  description: string | null;
  status: "UNMATCHED" | "SUGGESTED" | "MATCHED" | "IGNORED";
  suggested_leg: "DEALER" | "VENDOR" | null;
  suggested_request_no: string | null;
  suggested_counterparty: string | null;
  matched_leg_sub_id: string | null;
}

const STATUS_CHIP: Record<StatementRow["status"], string> = {
  UNMATCHED: "bg-slate-100 text-slate-500",
  SUGGESTED: "bg-amber-100 text-amber-700",
  MATCHED: "bg-emerald-100 text-emerald-700",
  IGNORED: "bg-slate-100 text-slate-400",
};

export default function BuybackStatementsPage() {
  const [imports, setImports] = useState<StatementImport[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<StatementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [accountLabel, setAccountLabel] = useState("");

  // A counter, not a callback. Calling a useCallback'd loader from an effect body
  // makes ESLint (rightly) see a synchronous setState inside the effect; bumping a
  // key and doing the work in an async IIFE means every setState lands after an
  // await, and the `cancelled` guard stops a late response from a stale import
  // overwriting the rows of the one the user has since clicked.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const res = await fetch("/api/admin/buyback/statements");
      const json = await res.json();
      if (cancelled) return;

      const list: StatementImport[] = json?.data?.imports ?? [];
      setImports(list);
      setLoading(false);
      if (list.length > 0) setSelected((s) => s ?? list[0].id);
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;

    (async () => {
      const res = await fetch(`/api/admin/buyback/statements/${selected}/rows`);
      const json = await res.json();
      if (cancelled) return;

      setRows(json?.data?.rows ?? []);
      setRowsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [selected, reloadKey]);

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    setNotice(null);

    const form = new FormData();
    form.append("file", file);
    if (accountLabel.trim()) form.append("account_label", accountLabel.trim());

    const res = await fetch("/api/admin/buyback/statements", { method: "POST", body: form });
    const json = await res.json();
    setUploading(false);

    if (!json?.success) {
      setError(json?.error?.message ?? "That statement could not be imported.");
      return;
    }

    setFile(null);
    setAccountLabel("");
    setNotice(
      `${json.data.rows_imported} transactions read · ${json.data.rows_suggested} matched to open deals.`,
    );
    setSelected(json.data.import_id);
    reload();
  };

  const act = async (rowId: string, ignore: boolean) => {
    setBusyRow(rowId);
    setError(null);
    setNotice(null);

    const res = await fetch(
      `/api/admin/buyback/statements/rows/${rowId}/confirm${ignore ? "?ignore=1" : ""}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    const json = await res.json();
    setBusyRow(null);

    if (!json?.success) {
      setError(json?.error?.message ?? "That row could not be reconciled.");
      return;
    }

    if (!ignore) {
      setNotice(
        json.data.both_legs_settled
          ? `${json.data.leg_sub_id} recorded — ${json.data.request_no} is now settled.`
          : `${json.data.leg_sub_id} recorded (${json.data.amount_label}).`,
      );
    }

    reload();
  };

  return (
    <div className="mx-auto max-w-6xl px-6 pb-24 pt-6">
      <div>
        <h1 className="text-lg font-bold text-slate-900">Bank reconciliation</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Import the bank statement and confirm the rows that settle a deal. A confirmed row becomes
          a settlement — the statement is its proof, so no separate receipt is needed.
        </p>
      </div>

      {/* --- Upload --- */}
      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-xs font-semibold text-slate-600">Statement (CSV or Excel)</span>
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-1 block w-full max-w-xs text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-slate-700"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-600">Account</span>
            <input
              value={accountLabel}
              placeholder="HDFC ••4021"
              onChange={(e) => setAccountLabel(e.target.value)}
              className="mt-1 w-48 rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <button
            onClick={upload}
            disabled={!file || uploading}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
          >
            {uploading ? "Reading…" : "Import"}
          </button>
        </div>

        {notice && <div className="mt-3 text-xs font-semibold text-emerald-700">{notice}</div>}
        {error && <div className="mt-3 text-xs text-red-600">{error}</div>}
      </div>

      {/* --- Imports --- */}
      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-10 text-center text-sm text-slate-400">Loading…</div>
        ) : imports.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">
            No statements imported yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-[10px] font-bold uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5">Statement</th>
                <th className="px-4 py-2.5">Account</th>
                <th className="px-4 py-2.5">Rows</th>
                <th className="px-4 py-2.5">Suggested</th>
                <th className="px-4 py-2.5">Matched</th>
                <th className="px-4 py-2.5">Imported</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((i) => (
                <tr
                  key={i.id}
                  onClick={() => setSelected(i.id)}
                  className={`cursor-pointer border-t border-slate-50 ${
                    selected === i.id ? "bg-slate-50" : "hover:bg-slate-50/60"
                  }`}
                >
                  <td className="px-4 py-2.5 font-semibold text-slate-800">{i.filename}</td>
                  <td className="px-4 py-2.5 text-slate-500">{i.account_label ?? "—"}</td>
                  <td className="px-4 py-2.5 text-slate-500">{i.row_count}</td>
                  <td className="px-4 py-2.5 font-semibold text-amber-700">
                    {i.suggested_count || "—"}
                  </td>
                  <td className="px-4 py-2.5 font-semibold text-emerald-700">
                    {i.matched_count || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">
                    {new Date(i.created_at).toLocaleDateString("en-IN")}
                    {i.imported_by ? ` · ${i.imported_by}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* --- Rows of the selected import --- */}
      {selected && (
        <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-400">
            Transactions
          </div>

          {rowsLoading ? (
            <div className="p-10 text-center text-sm text-slate-400">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-400">
              No readable transactions in this statement.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-[10px] font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Narration</th>
                  <th className="px-4 py-2.5">Reference</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  <th className="px-4 py-2.5">Match</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const amount = Number(r.amount);
                  const done = r.status === "MATCHED" || r.status === "IGNORED";

                  return (
                    <tr
                      key={r.id}
                      className={`border-t border-slate-50 align-middle ${
                        done ? "bg-slate-50/60 text-slate-400" : ""
                      }`}
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">{r.txn_date}</td>
                      <td className="max-w-xs truncate px-4 py-2.5 text-slate-600">
                        {r.description ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-slate-500">{r.txn_ref ?? "—"}</td>
                      <td
                        className={`whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums ${
                          done ? "" : amount < 0 ? "text-red-600" : "text-emerald-700"
                        }`}
                      >
                        {inr(amount)}
                      </td>

                      <td className="px-4 py-2.5">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_CHIP[r.status]}`}
                        >
                          {r.status}
                        </span>
                        {r.status === "MATCHED" && r.matched_leg_sub_id && (
                          <span className="ml-2 text-xs font-semibold text-slate-500">
                            {r.matched_leg_sub_id}
                          </span>
                        )}
                        {r.status === "SUGGESTED" && r.suggested_request_no && (
                          <span className="ml-2 text-xs text-slate-600">
                            <span className="font-semibold text-slate-800">
                              {r.suggested_request_no}
                            </span>{" "}
                            ·{" "}
                            {r.suggested_leg === "DEALER"
                              ? "payout to"
                              : "receipt from"}{" "}
                            {r.suggested_counterparty ?? "—"}
                          </span>
                        )}
                      </td>

                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        {!done && (
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => act(r.id, false)}
                              disabled={busyRow === r.id || r.status !== "SUGGESTED"}
                              title={
                                r.status === "SUGGESTED"
                                  ? "Record this as the settlement"
                                  : "No open deal owes this amount — nothing to confirm"
                              }
                              className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400"
                            >
                              {busyRow === r.id ? "…" : "Confirm"}
                            </button>
                            <button
                              onClick={() => act(r.id, true)}
                              disabled={busyRow === r.id}
                              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:text-slate-300"
                            >
                              Ignore
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
