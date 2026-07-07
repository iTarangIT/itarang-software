"use client";

/**
 * EmiTrackerClient — portfolio EMI table + filters + per-loan drawer.
 *
 * Server hands down already-computed rows; this handles search/filter, the
 * drill-down drawer (fetches the EMI schedule + attempt history), and the
 * manual cash record-payment action.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import RecordPaymentModal from "./RecordPaymentModal";
import EmiBulkUploadModal from "./EmiBulkUploadModal";

/** Pure computed (pre-override) values — used to diff on save. */
export interface EmiComputed {
  borrower: string;
  vehicleno: string | null;
  emiAmount: number | null;
  nextDue: string | null;
  lastPaid: string | null;
  paidCount: number;
  totalCount: number;
  derivedStatus: "active" | "overdue" | "closed";
  dpd: number;
  mandateStatus: string | null;
  nextAutoDebit: string | null;
  financier: string | null;
}

export interface EmiLoanRow {
  loanId: string;
  // E-183 — a force-imported row with no underlying loan. Display-only: no
  // schedule drawer, no per-EMI collect, no mandate. Edited/removed by its own
  // override id (`overrideId`) via /api/nbfc/emi-tracker/standalone/[id].
  isStandalone?: boolean;
  overrideId?: string | null;
  // Effective (override → computed) display values.
  borrower: string;
  vehicleno: string | null;
  emiAmount: number | null;
  nextDue: string | null;
  lastPaid: string | null;
  paidCount: number;
  totalCount: number;
  overdueCount: number;
  dpd: number;
  mandateStatus: string | null;
  derivedStatus: "active" | "overdue" | "closed";
  nextAutoDebit: string | null;
  // Free-text financier label (override-only; no computed fallback).
  financier: string | null;
  // Pre-override values so the inline editor knows what to persist vs. leave computed.
  computed: EmiComputed;
}

interface Metrics {
  activeLoans: number;
  dueToday: number;
  overdue: number;
  collectedMonth: number;
  collectionRate: number;
}

interface EmiScheduleItem {
  id: string;
  emi_seq: number | null;
  due_date: string;
  paid_at: string | null;
  status: string;
  days_overdue: number | null;
  amount: string | null;
  amount_paid: string | null;
  attempt_count: number;
  payment_ref: string | null;
  collection_mode: string | null;
  attempts: Array<{
    id: string;
    mode: string;
    channel: string;
    status: string;
    amount_paise: number;
    failure_reason: string | null;
    reference_no: string | null;
    document_url: string | null;
    collected_at: string | null;
    note: string | null;
    created_at: string;
  }>;
}

const inr = (n: number | null) =>
  n == null ? "—" : `₹${Math.round(n).toLocaleString("en-IN")}`;

const fmtDate = (s: string | null) =>
  !s ? "—" : new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** RFC-4180 CSV cell: quote when it contains a comma, quote, or newline. */
function csvCell(v: string | number | null): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV of the (filtered) EMI table — mirrors the on-screen columns. */
function buildCsv(rows: EmiLoanRow[]): string {
  const headers = [
    "Borrower",
    "Loan ID",
    "Finance",
    "Battery serial",
    "EMI",
    "Next due",
    "Last paid",
    "Progress",
    "Status",
    "DPD",
    "Mandate",
    "Next auto-debit",
  ];
  const isoDate = (s: string | null) => (s ? s.slice(0, 10) : "");
  const lines = rows.map((r) =>
    [
      r.borrower,
      r.loanId,
      r.financier,
      r.vehicleno,
      r.emiAmount,
      isoDate(r.nextDue),
      isoDate(r.lastPaid),
      `${r.paidCount}/${r.totalCount}`,
      r.derivedStatus,
      r.dpd,
      r.mandateStatus ?? "none",
      isoDate(r.nextAutoDebit),
    ]
      .map(csvCell)
      .join(","),
  );
  return [headers.map(csvCell).join(","), ...lines].join("\r\n");
}

/** Trigger a client-side download of the given text as a file. */
function downloadText(filename: string, text: string) {
  const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const STATUS_PILL: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700",
  overdue: "bg-red-50 text-red-700",
  closed: "bg-slate-100 text-slate-600",
  scheduled: "bg-slate-100 text-slate-600",
  paid: "bg-emerald-50 text-emerald-700",
  paid_late: "bg-amber-50 text-amber-700",
  partial: "bg-amber-50 text-amber-700",
  missed: "bg-red-50 text-red-700",
  failed: "bg-red-50 text-red-700",
};

const STATUS_LABEL: Record<string, string> = { partial: "Partially paid" };

/** Editable canonical statuses (must match the PATCH route's allow-list). */
const EDIT_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "scheduled", label: "Scheduled" },
  { value: "overdue", label: "Overdue" },
  { value: "missed", label: "Missed" },
  { value: "paid", label: "Paid" },
  { value: "paid_late", label: "Paid late" },
  { value: "failed", label: "Failed" },
];

const SETTLED_STATUSES = new Set(["paid", "paid_late"]);

/** ISO/date string → 'YYYY-MM-DD' for a native <input type="date">. */
const toDateInput = (s: string | null) => (s ?? "").slice(0, 10);

function Pill({ value }: { value: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
        STATUS_PILL[value] ?? "bg-slate-100 text-slate-600"
      }`}
    >
      {STATUS_LABEL[value] ?? value.replace(/_/g, " ")}
    </span>
  );
}

export default function EmiTrackerClient({
  rows,
  metrics,
  mode,
}: {
  rows: EmiLoanRow[];
  metrics: Metrics;
  mode: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<"all" | "active" | "overdue" | "closed">("all");
  const [mandate, setMandate] = useState<"all" | "has" | "none">("all");
  const [q, setQ] = useState("");
  const [openLoan, setOpenLoan] = useState<EmiLoanRow | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const filtered = rows.filter((r) => {
    if (status !== "all" && r.derivedStatus !== status) return false;
    if (mandate === "has" && r.mandateStatus !== "registered") return false;
    if (mandate === "none" && r.mandateStatus === "registered") return false;
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      const hay = `${r.borrower} ${r.loanId} ${r.vehicleno ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="section-label-muted">EMI Tracker</p>
          <h1 className="mt-1 text-2xl font-semibold text-[color:var(--color-brand-navy)]">
            EMI Collection & Auto-Debit
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
            Each loan&apos;s EMI status, repayment progress and next auto-debit. Collections run
            automatically via E-NACH mandates — no manual entry in the happy path.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() =>
              downloadText(
                `emi-tracker-${new Date().toISOString().slice(0, 10)}.csv`,
                buildCsv(filtered),
              )
            }
            disabled={filtered.length === 0}
            title="Download the table below as CSV (respects the current filters)"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-border)] bg-white px-3.5 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-bg)] disabled:opacity-50"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download CSV
          </button>
          <button
            type="button"
            onClick={() => setBulkOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-brand-navy)] px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            Bulk upload
          </button>
        </div>
      </header>

      {mode !== "live" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <strong>Auto-debit: SIMULATE</strong> — collections are recorded for testing; no real
          money is moved. Set <code>EMI_AUTODEBIT_MODE=live</code> to enable real debits.
        </div>
      )}

      {/* Headline metrics */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Metric label="Active loans" value={String(metrics.activeLoans)} />
        <Metric label="EMIs due today" value={String(metrics.dueToday)} />
        <Metric label="Overdue / missed" value={String(metrics.overdue)} tone="danger" />
        <Metric label="Collected this month" value={inr(metrics.collectedMonth)} />
        <Metric label="Collection rate" value={`${metrics.collectionRate}%`} />
      </section>

      {/* Filters */}
      <section className="card-iTarang flex flex-wrap items-end gap-3 p-3">
        <Field label="Status">
          <select className={SELECT} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="overdue">Overdue</option>
            <option value="closed">Closed</option>
          </select>
        </Field>
        <Field label="Mandate">
          <select className={SELECT} value={mandate} onChange={(e) => setMandate(e.target.value as typeof mandate)}>
            <option value="all">All</option>
            <option value="has">Has E-NACH</option>
            <option value="none">No mandate</option>
          </select>
        </Field>
        <Field label="Search">
          <input
            className={SELECT}
            placeholder="Borrower, loan id, serial"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </Field>
        <span className="ml-auto self-center text-sm text-[color:var(--color-ink-muted)]">
          {filtered.length} of {rows.length}
        </span>
      </section>

      {/* Table */}
      <section className="card-iTarang overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-[color:var(--color-ink-muted)]">
              <th className="px-4 py-3">Borrower / Loan</th>
              <th className="px-4 py-3">Finance</th>
              <th className="px-4 py-3">Battery serial</th>
              <th className="px-4 py-3 text-right">EMI</th>
              <th className="px-4 py-3">Next due</th>
              <th className="px-4 py-3">Last paid</th>
              <th className="px-4 py-3">Progress</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">DPD</th>
              <th className="px-4 py-3">Mandate</th>
              <th className="px-4 py-3">Next auto-debit</th>
              <th className="px-4 py-3 text-right">Edit</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <EmiTableRow
                key={r.loanId}
                row={r}
                onOpen={() => setOpenLoan(r)}
                onEdited={() => router.refresh()}
              />
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={12} className="px-4 py-10 text-center text-[color:var(--color-ink-muted)]">
                  No loans match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {openLoan && (
        <LoanDrawer
          loan={openLoan}
          onClose={() => setOpenLoan(null)}
          onChanged={() => router.refresh()}
        />
      )}

      {bulkOpen && (
        <EmiBulkUploadModal
          onClose={() => setBulkOpen(false)}
          onApplied={() => router.refresh()}
        />
      )}
    </div>
  );
}

const SELECT =
  "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[color:var(--color-brand-sky)] focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase text-[color:var(--color-ink-muted)]">
        {label}
      </label>
      {children}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="card-iTarang p-4">
      <p className="section-label-muted">{label}</p>
      <p
        className={`mt-2 text-2xl font-semibold tabular-nums ${
          tone === "danger" ? "text-red-600" : "text-[color:var(--color-brand-navy)]"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

const CELL_INPUT =
  "w-full min-w-[4.5rem] rounded border border-slate-300 px-1.5 py-1 text-xs text-[color:var(--color-ink)] focus:border-[color:var(--color-brand-sky)] focus:outline-none";

/** ISO/date string → 'YYYY-MM-DD' for a native <input type="date">. */
const toDate = (s: string | null) => (s ?? "").slice(0, 10);

/**
 * One portfolio-table row. Click opens the schedule drawer; the Edit pencil
 * flips the row into inline inputs for every column. On save only the fields
 * that DIFFER from the computed value are persisted as overrides (others revert
 * to the live computed value), so editing one column doesn't freeze the rest.
 */
function EmiTableRow({
  row,
  onOpen,
  onEdited,
}: {
  row: EmiLoanRow;
  onOpen: () => void;
  onEdited: () => void;
}) {
  const c = row.computed;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [f, setF] = useState(() => ({
    borrower: row.borrower === "—" ? "" : row.borrower,
    vehicleno: row.vehicleno ?? "",
    emi: row.emiAmount != null ? String(row.emiAmount) : "",
    nextDue: toDate(row.nextDue),
    lastPaid: toDate(row.lastPaid),
    progressPaid: String(row.paidCount),
    progressTotal: String(row.totalCount),
    status: row.derivedStatus,
    dpd: String(row.dpd),
    mandate: row.mandateStatus === "registered" ? "registered" : "none",
    nextAutoDebit: toDate(row.nextAutoDebit),
    financier: row.financier ?? "",
  }));
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  const open = () => {
    // Reset the form to current values whenever we enter edit mode.
    setErr(null);
    setF({
      borrower: row.borrower === "—" ? "" : row.borrower,
      vehicleno: row.vehicleno ?? "",
      emi: row.emiAmount != null ? String(row.emiAmount) : "",
      nextDue: toDate(row.nextDue),
      lastPaid: toDate(row.lastPaid),
      progressPaid: String(row.paidCount),
      progressTotal: String(row.totalCount),
      status: row.derivedStatus,
      dpd: String(row.dpd),
      mandate: row.mandateStatus === "registered" ? "registered" : "none",
      nextAutoDebit: toDate(row.nextAutoDebit),
      financier: row.financier ?? "",
    });
    setEditing(true);
  };

  // Persist only fields that differ from the computed value (null = revert).
  const textField = (input: string, computedVal: string) => {
    const t = input.trim();
    return t === "" || t === computedVal ? null : t;
  };
  const numField = (input: string, computedVal: number | null) => {
    const t = input.trim();
    if (t === "") return null;
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return n === computedVal ? null : n;
  };
  const dateField = (input: string, computedVal: string | null) => {
    const t = toDate(input);
    return t === "" || t === (computedVal ?? "").slice(0, 10) ? null : t;
  };

  const save = async () => {
    setErr(null);
    setSaving(true);
    try {
      // Standalone rows have no computed baseline — persist every field verbatim
      // to the standalone endpoint (keyed by the override id, not a loan).
      if (row.isStandalone && row.overrideId) {
        const payload = {
          borrower: f.borrower.trim() || null,
          vehicleno: f.vehicleno.trim() || null,
          emi: f.emi.trim() === "" ? null : Number(f.emi),
          next_due: f.nextDue || null,
          last_paid: f.lastPaid || null,
          progress_paid: f.progressPaid.trim() === "" ? null : Number(f.progressPaid),
          progress_total: f.progressTotal.trim() === "" ? null : Number(f.progressTotal),
          status: f.status,
          dpd: f.dpd.trim() === "" ? null : Number(f.dpd),
          mandate: f.mandate,
          next_auto_debit: f.nextAutoDebit || null,
          financier: f.financier.trim() || null,
        };
        const res = await fetch(
          `/api/nbfc/emi-tracker/standalone/${encodeURIComponent(row.overrideId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "Failed to save");
        setEditing(false);
        onEdited();
        return;
      }

      const mComputed = c.mandateStatus === "registered" ? "registered" : "none";
      const payload = {
        borrower: textField(f.borrower, c.borrower === "—" ? "" : c.borrower),
        vehicleno: textField(f.vehicleno, c.vehicleno ?? ""),
        emi: numField(f.emi, c.emiAmount),
        next_due: dateField(f.nextDue, c.nextDue),
        last_paid: dateField(f.lastPaid, c.lastPaid),
        progress_paid: numField(f.progressPaid, c.paidCount),
        progress_total: numField(f.progressTotal, c.totalCount),
        status: f.status !== c.derivedStatus ? f.status : null,
        dpd: numField(f.dpd, c.dpd),
        mandate: f.mandate !== mComputed ? f.mandate : null,
        next_auto_debit: dateField(f.nextAutoDebit, c.nextAutoDebit),
        // Override-only field (no computed fallback): persist as typed, or null.
        financier: f.financier.trim() || null,
      };
      const res = await fetch(
        `/api/nbfc/loans/${encodeURIComponent(row.loanId)}/tracker-override`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to save");
      setEditing(false);
      onEdited();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setErr(null);
    setSaving(true);
    try {
      // Standalone rows have no computed value to revert to — "Reset" removes
      // the imported entry entirely. Real loans clear their overrides.
      const url =
        row.isStandalone && row.overrideId
          ? `/api/nbfc/emi-tracker/standalone/${encodeURIComponent(row.overrideId)}`
          : `/api/nbfc/loans/${encodeURIComponent(row.loanId)}/tracker-override`;
      const res = await fetch(url, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to reset");
      setEditing(false);
      onEdited();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to reset");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <tr
        className={`border-b last:border-0 ${row.isStandalone ? "" : "cursor-pointer hover:bg-slate-50"}`}
        onClick={row.isStandalone ? undefined : onOpen}
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-[color:var(--color-brand-navy)]">{row.borrower}</span>
            {row.isStandalone && (
              <span
                title="Imported from a bulk upload with no matching loan — display only"
                className="rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 ring-1 ring-sky-200"
              >
                Imported
              </span>
            )}
          </div>
          <div className="text-xs text-[color:var(--color-ink-muted)]">
            {row.isStandalone ? "No linked loan" : row.loanId}
          </div>
        </td>
        <td className="px-4 py-3">
          {row.financier ? (
            <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
              {row.financier}
            </span>
          ) : (
            <span className="text-[color:var(--color-ink-muted)]">—</span>
          )}
        </td>
        <td className="px-4 py-3 font-mono text-xs">{row.vehicleno ?? "—"}</td>
        <td className="px-4 py-3 text-right tabular-nums">{inr(row.emiAmount)}</td>
        <td className="px-4 py-3">{fmtDate(row.nextDue)}</td>
        <td className="px-4 py-3">{fmtDate(row.lastPaid)}</td>
        <td className="px-4 py-3 tabular-nums">
          {row.paidCount}/{row.totalCount}
        </td>
        <td className="px-4 py-3">
          <Pill value={row.derivedStatus} />
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {row.dpd > 0 ? <span className="text-red-600">{row.dpd}d</span> : "—"}
        </td>
        <td className="px-4 py-3">
          {row.mandateStatus === "registered" ? (
            <span className="text-emerald-700">E-NACH</span>
          ) : (
            <span className="text-[color:var(--color-ink-muted)]">{row.mandateStatus ?? "none"}</span>
          )}
        </td>
        <td className="px-4 py-3">
          {row.nextAutoDebit ? fmtDate(row.nextAutoDebit) : <span className="text-[color:var(--color-ink-muted)]">Manual / UPI</span>}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            Edit
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b bg-sky-50/40 align-top last:border-0">
      <td className="px-3 py-2">
        <input className={CELL_INPUT} value={f.borrower} onChange={(e) => set("borrower", e.target.value)} placeholder="Borrower" />
        <div className="mt-1 text-[10px] text-[color:var(--color-ink-muted)]">
          {row.isStandalone ? "Imported · no linked loan" : row.loanId}
        </div>
      </td>
      <td className="px-3 py-2">
        <input className={CELL_INPUT} value={f.financier} onChange={(e) => set("financier", e.target.value)} placeholder="Financier" list="emi-financier-suggestions" />
        <datalist id="emi-financier-suggestions">
          <option value="Self Finance" />
          <option value="iTarang Finance" />
          <option value="HEY EV" />
        </datalist>
      </td>
      <td className="px-3 py-2">
        <input className={`${CELL_INPUT} font-mono`} value={f.vehicleno} onChange={(e) => set("vehicleno", e.target.value)} placeholder="Serial" />
      </td>
      <td className="px-3 py-2">
        <input type="number" min={0} step="0.01" className={`${CELL_INPUT} text-right`} value={f.emi} onChange={(e) => set("emi", e.target.value)} />
      </td>
      <td className="px-3 py-2">
        <input type="date" className={CELL_INPUT} value={f.nextDue} onChange={(e) => set("nextDue", e.target.value)} />
      </td>
      <td className="px-3 py-2">
        <input type="date" className={CELL_INPUT} value={f.lastPaid} onChange={(e) => set("lastPaid", e.target.value)} />
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          <input type="number" min={0} className={`${CELL_INPUT} min-w-[3rem] text-right`} value={f.progressPaid} onChange={(e) => set("progressPaid", e.target.value)} />
          <span className="text-xs text-[color:var(--color-ink-muted)]">/</span>
          <input type="number" min={0} className={`${CELL_INPUT} min-w-[3rem] text-right`} value={f.progressTotal} onChange={(e) => set("progressTotal", e.target.value)} />
        </div>
      </td>
      <td className="px-3 py-2">
        <select className={CELL_INPUT} value={f.status} onChange={(e) => set("status", e.target.value)}>
          <option value="active">Active</option>
          <option value="overdue">Overdue</option>
          <option value="closed">Closed</option>
        </select>
      </td>
      <td className="px-3 py-2">
        <input type="number" min={0} className={`${CELL_INPUT} text-right`} value={f.dpd} onChange={(e) => set("dpd", e.target.value)} />
      </td>
      <td className="px-3 py-2">
        <select className={CELL_INPUT} value={f.mandate} onChange={(e) => set("mandate", e.target.value)}>
          <option value="registered">E-NACH</option>
          <option value="none">none</option>
        </select>
      </td>
      <td className="px-3 py-2">
        <input type="date" className={CELL_INPUT} value={f.nextAutoDebit} onChange={(e) => set("nextAutoDebit", e.target.value)} />
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col items-stretch gap-1">
          <button onClick={save} disabled={saving} className="rounded-md bg-[color:var(--color-brand-navy)] px-2 py-1 text-xs font-medium text-white disabled:opacity-50">
            {saving ? "…" : "Save"}
          </button>
          <button onClick={() => setEditing(false)} disabled={saving} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={reset}
            disabled={saving}
            title={row.isStandalone ? "Remove this imported entry" : "Clear all overrides for this loan"}
            className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            {row.isStandalone ? "Remove" : "Reset"}
          </button>
          {err && <span className="text-[10px] text-red-600">{err}</span>}
        </div>
      </td>
    </tr>
  );
}

function LoanDrawer({
  loan,
  onClose,
  onChanged,
}: {
  loan: EmiLoanRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<EmiScheduleItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payEmi, setPayEmi] = useState<EmiScheduleItem | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/loans/${encodeURIComponent(loan.loanId)}/emi-schedule`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to load");
      setItems(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [loan.loanId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="h-full w-full max-w-2xl overflow-y-auto bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="section-label-muted">Loan {loan.loanId}</p>
            <h2 className="text-xl font-semibold text-[color:var(--color-brand-navy)]">{loan.borrower}</h2>
            <p className="text-sm text-[color:var(--color-ink-muted)]">
              {loan.vehicleno ?? "—"} · {loan.paidCount}/{loan.totalCount} paid · EMI {inr(loan.emiAmount)}
            </p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-slate-400 hover:text-slate-600">
            ×
          </button>
        </div>

        {error && <div className="mt-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div className="mt-5 space-y-2">
          {items == null && <p className="text-sm text-[color:var(--color-ink-muted)]">Loading…</p>}
          {items?.map((it) => (
            <EmiRow
              key={it.id}
              it={it}
              loanId={loan.loanId}
              onCollect={() => setPayEmi(it)}
              onSaved={async () => {
                await load();
                onChanged();
              }}
            />
          ))}
        </div>
      </div>

      {payEmi && (
        <RecordPaymentModal
          loanId={loan.loanId}
          borrower={loan.borrower}
          emi={payEmi}
          onClose={() => setPayEmi(null)}
          onSuccess={async () => {
            setPayEmi(null);
            await load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/** One installment row in the drawer, with partial-payment progress + history. */
function EmiRow({
  it,
  loanId,
  onCollect,
  onSaved,
}: {
  it: EmiScheduleItem;
  loanId: string;
  onCollect: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const due = it.amount != null ? Number(it.amount) : 0;
  const paid = it.amount_paid != null ? Number(it.amount_paid) : 0;
  const settled = it.status === "paid" || it.status === "paid_late";
  const partial = !settled && paid > 0 && paid < due;
  const remaining = Math.max(0, Math.round((due - paid) * 100) / 100);
  const pct = due > 0 ? Math.min(100, Math.round((paid / due) * 100)) : 0;
  const displayStatus = partial ? "partial" : it.status;
  const collectable = !settled && remaining > 0;
  const succeeded = it.attempts.filter((a) => a.status === "succeeded" || a.status === "simulated");

  const [editing, setEditing] = useState(false);

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm">
          <span className="font-medium">EMI {it.emi_seq ?? "—"}</span>
          <span className="text-[color:var(--color-ink-muted)]"> · due {fmtDate(it.due_date)}</span>
          {it.amount && <span className="text-[color:var(--color-ink-muted)]"> · {inr(due)}</span>}
        </div>
        <div className="flex items-center gap-3">
          <Pill value={displayStatus} />
          {collectable && (
            <button
              onClick={onCollect}
              className="rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1 text-xs font-medium text-white"
            >
              Collect payment
            </button>
          )}
          <button
            onClick={() => setEditing((v) => !v)}
            className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {editing ? "Cancel" : "Edit"}
          </button>
        </div>
      </div>

      {editing && (
        <EmiEditForm
          it={it}
          loanId={loanId}
          onClose={() => setEditing(false)}
          onSaved={onSaved}
        />
      )}

      {partial && (
        <div className="mt-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-amber-400" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-xs text-amber-700">
            {inr(paid)} / {inr(due)} collected · {inr(remaining)} due
          </p>
        </div>
      )}

      {(it.paid_at || succeeded.length > 0) && (
        <div className="mt-2 space-y-0.5 text-xs text-[color:var(--color-ink-muted)]">
          {it.paid_at && <div>Cleared {fmtDate(it.paid_at)}</div>}
          {succeeded.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-x-1.5">
              <span className="capitalize text-[color:var(--color-ink)]">{a.channel.replace(/_/g, " ")}</span>
              <span>· {inr(a.amount_paise / 100)}</span>
              <span>· {fmtDate(a.collected_at ?? a.created_at)}</span>
              {a.reference_no && <span>· ref {a.reference_no}</span>}
              {a.document_url && (
                <a
                  href={a.document_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[color:var(--color-brand-sky)] hover:underline"
                >
                  View receipt
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Inline editor for an installment's due date, amount, status and cleared date. */
function EmiEditForm({
  it,
  loanId,
  onClose,
  onSaved,
}: {
  it: EmiScheduleItem;
  loanId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [dueDate, setDueDate] = useState(toDateInput(it.due_date));
  const [amount, setAmount] = useState(it.amount != null ? String(Number(it.amount)) : "");
  const [status, setStatus] = useState(it.status);
  const [paidAt, setPaidAt] = useState(toDateInput(it.paid_at));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isSettled = SETTLED_STATUSES.has(status);

  const save = async () => {
    setErr(null);
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        due_date: dueDate,
        amount: amount === "" ? 0 : Number(amount),
        status,
        // Only meaningful when settled; the API clears it otherwise.
        paid_at: isSettled ? paidAt || null : null,
      };
      const res = await fetch(
        `/api/nbfc/loans/${encodeURIComponent(loanId)}/emi/${encodeURIComponent(it.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to save");
      onClose();
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-[color:var(--color-ink-muted)]">
          Due date
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-[color:var(--color-ink)] focus:border-[color:var(--color-brand-sky)] focus:outline-none"
          />
        </label>
        <label className="text-xs font-medium text-[color:var(--color-ink-muted)]">
          Amount (₹)
          <input
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-[color:var(--color-ink)] focus:border-[color:var(--color-brand-sky)] focus:outline-none"
          />
        </label>
        <label className="text-xs font-medium text-[color:var(--color-ink-muted)]">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-[color:var(--color-ink)] focus:border-[color:var(--color-brand-sky)] focus:outline-none"
          >
            {EDIT_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-[color:var(--color-ink-muted)]">
          Cleared date
          <input
            type="date"
            value={paidAt}
            disabled={!isSettled}
            onChange={(e) => setPaidAt(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-[color:var(--color-ink)] focus:border-[color:var(--color-brand-sky)] focus:outline-none disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
          />
          {!isSettled && (
            <span className="mt-0.5 block font-normal normal-case text-[10px] text-slate-400">
              Only for Paid / Paid late
            </span>
          )}
        </label>
      </div>

      {err && <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{err}</div>}

      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={saving}
          className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-white disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}
