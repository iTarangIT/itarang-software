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

export interface EmiLoanRow {
  loanId: string;
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
      <header className="min-w-0">
        <p className="section-label-muted">EMI Tracker</p>
        <h1 className="mt-1 text-2xl font-semibold text-[color:var(--color-brand-navy)]">
          EMI Collection & Auto-Debit
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
          Each loan&apos;s EMI status, repayment progress and next auto-debit. Collections run
          automatically via E-NACH mandates — no manual entry in the happy path.
        </p>
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
              <th className="px-4 py-3">Battery serial</th>
              <th className="px-4 py-3 text-right">EMI</th>
              <th className="px-4 py-3">Next due</th>
              <th className="px-4 py-3">Last paid</th>
              <th className="px-4 py-3">Progress</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">DPD</th>
              <th className="px-4 py-3">Mandate</th>
              <th className="px-4 py-3">Next auto-debit</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.loanId}
                className="cursor-pointer border-b last:border-0 hover:bg-slate-50"
                onClick={() => setOpenLoan(r)}
              >
                <td className="px-4 py-3">
                  <div className="font-medium text-[color:var(--color-brand-navy)]">{r.borrower}</div>
                  <div className="text-xs text-[color:var(--color-ink-muted)]">{r.loanId}</div>
                </td>
                <td className="px-4 py-3 font-mono text-xs">{r.vehicleno ?? "—"}</td>
                <td className="px-4 py-3 text-right tabular-nums">{inr(r.emiAmount)}</td>
                <td className="px-4 py-3">{fmtDate(r.nextDue)}</td>
                <td className="px-4 py-3">{fmtDate(r.lastPaid)}</td>
                <td className="px-4 py-3 tabular-nums">
                  {r.paidCount}/{r.totalCount}
                </td>
                <td className="px-4 py-3">
                  <Pill value={r.derivedStatus} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {r.dpd > 0 ? <span className="text-red-600">{r.dpd}d</span> : "—"}
                </td>
                <td className="px-4 py-3">
                  {r.mandateStatus === "registered" ? (
                    <span className="text-emerald-700">E-NACH</span>
                  ) : (
                    <span className="text-[color:var(--color-ink-muted)]">{r.mandateStatus ?? "none"}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {r.nextAutoDebit ? fmtDate(r.nextAutoDebit) : <span className="text-[color:var(--color-ink-muted)]">Manual / UPI</span>}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-[color:var(--color-ink-muted)]">
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
            <EmiRow key={it.id} it={it} onCollect={() => setPayEmi(it)} />
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
function EmiRow({ it, onCollect }: { it: EmiScheduleItem; onCollect: () => void }) {
  const due = it.amount != null ? Number(it.amount) : 0;
  const paid = it.amount_paid != null ? Number(it.amount_paid) : 0;
  const settled = it.status === "paid" || it.status === "paid_late";
  const partial = !settled && paid > 0 && paid < due;
  const remaining = Math.max(0, Math.round((due - paid) * 100) / 100);
  const pct = due > 0 ? Math.min(100, Math.round((paid / due) * 100)) : 0;
  const displayStatus = partial ? "partial" : it.status;
  const collectable = !settled && remaining > 0;
  const succeeded = it.attempts.filter((a) => a.status === "succeeded" || a.status === "simulated");

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
        </div>
      </div>

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
