"use client";

/**
 * RecordPaymentModal — collect a payment against one EMI installment.
 *
 * Supports full or PARTIAL collection, a transaction type (cash / UPI / bank /
 * cheque / QR), a back-datable collection date, an optional reference, and an
 * optional receipt/invoice upload. Posts multipart/form-data to the
 * record-payment route and calls onSuccess() on completion.
 */
import { useMemo, useRef, useState } from "react";

export interface PaymentEmi {
  id: string;
  emi_seq: number | null;
  due_date: string;
  amount: string | null;
  amount_paid: string | null;
}

const MODES: { value: string; label: string; refLabel: string | null }[] = [
  { value: "cash", label: "Cash", refLabel: null },
  { value: "upi", label: "UPI", refLabel: "UPI reference / txn id" },
  { value: "bank_transfer", label: "Bank Transfer", refLabel: "Bank / NEFT-IMPS ref" },
  { value: "cheque", label: "Cheque", refLabel: "Cheque number" },
  { value: "qr", label: "QR / Link", refLabel: "Payment / order id" },
];

const money = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export default function RecordPaymentModal({
  loanId,
  borrower,
  emi,
  onClose,
  onSuccess,
}: {
  loanId: string;
  borrower: string;
  emi: PaymentEmi;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const due = emi.amount != null ? Number(emi.amount) : 0;
  const paidSoFar = emi.amount_paid != null ? Number(emi.amount_paid) : 0;
  const remaining = Math.max(0, Math.round((due - paidSoFar) * 100) / 100);

  const today = new Date().toISOString().slice(0, 10);
  const [amount, setAmount] = useState<string>(remaining ? String(remaining) : "");
  const [mode, setMode] = useState<string>("cash");
  const [paidAt, setPaidAt] = useState<string>(today);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const modeMeta = MODES.find((m) => m.value === mode)!;
  const amountNum = Number(amount);
  const valid = Number.isFinite(amountNum) && amountNum > 0 && amountNum <= remaining + 0.001;
  const afterRemaining = valid ? Math.max(0, Math.round((remaining - amountNum) * 100) / 100) : remaining;

  const hint = useMemo(() => {
    if (!amount.trim()) return null;
    if (!Number.isFinite(amountNum) || amountNum <= 0) return { tone: "err", text: "Enter an amount greater than 0." };
    if (amountNum > remaining + 0.001) return { tone: "err", text: `Cannot exceed the remaining ${money(remaining)} due.` };
    if (afterRemaining > 0) return { tone: "warn", text: `Partial — ${money(afterRemaining)} will remain due on this EMI.` };
    return { tone: "ok", text: "This clears the EMI in full." };
  }, [amount, amountNum, remaining, afterRemaining]);

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("amount", String(amountNum));
      fd.set("mode", mode);
      fd.set("paid_at", paidAt);
      if (reference.trim()) fd.set("reference", reference.trim());
      if (note.trim()) fd.set("note", note.trim());
      if (file) fd.set("file", file);
      const res = await fetch(
        `/api/nbfc/loans/${encodeURIComponent(loanId)}/emi/${encodeURIComponent(emi.id)}/record-payment`,
        { method: "POST", body: fd },
      );
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.error ?? "Failed to record payment");
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to record payment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-10"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-3 border-b border-[color:var(--color-border)] p-5">
          <div className="min-w-0">
            <p className="section-label-muted">Collect payment</p>
            <h2 className="mt-0.5 text-lg font-semibold text-[color:var(--color-brand-navy)]">
              {borrower} · EMI {emi.emi_seq ?? "—"}
            </h2>
            <p className="mt-0.5 text-xs text-[color:var(--color-ink-muted)]">
              Due {fmtDate(emi.due_date)} · EMI {money(due)}
              {paidSoFar > 0 && ` · ${money(paidSoFar)} collected`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-2xl leading-none text-slate-400 hover:text-slate-600"
          >
            ×
          </button>
        </header>

        <div className="space-y-4 p-5">
          {/* Remaining due banner */}
          <div className="flex items-center justify-between rounded-xl bg-[color:var(--color-bg)] px-4 py-3">
            <span className="section-label-muted">Remaining due</span>
            <span className="text-xl font-semibold tabular-nums text-[color:var(--color-brand-navy)]">
              {money(remaining)}
            </span>
          </div>

          {/* Amount */}
          <Field label="Amount to collect">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--color-ink-muted)]">₹</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                max={remaining}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={`${INPUT} pl-7`}
                placeholder="0.00"
              />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {remaining > 0 && (
                <Chip onClick={() => setAmount(String(remaining))} active={amountNum === remaining}>
                  Full {money(remaining)}
                </Chip>
              )}
              {[0.5, 0.25].map((f) => {
                const v = Math.round(remaining * f * 100) / 100;
                return v > 0 && v < remaining ? (
                  <Chip key={f} onClick={() => setAmount(String(v))} active={amountNum === v}>
                    {money(v)}
                  </Chip>
                ) : null;
              })}
            </div>
            {hint && (
              <p
                className={`mt-1.5 text-xs ${
                  hint.tone === "err"
                    ? "text-red-600"
                    : hint.tone === "warn"
                      ? "text-amber-700"
                      : "text-emerald-700"
                }`}
              >
                {hint.text}
              </p>
            )}
          </Field>

          {/* Transaction type */}
          <Field label="Transaction type">
            <div className="flex flex-wrap gap-2">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMode(m.value)}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                    mode === m.value
                      ? "border-[color:var(--color-brand-sky)] bg-[color:var(--color-brand-sky)]/10 text-[color:var(--color-brand-navy)]"
                      : "border-slate-300 text-[color:var(--color-ink-muted)] hover:border-slate-400"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Date */}
            <Field label="Payment date">
              <input
                type="date"
                value={paidAt}
                max={today}
                onChange={(e) => setPaidAt(e.target.value)}
                className={INPUT}
              />
            </Field>
            {/* Reference (only when the mode has one) */}
            {modeMeta.refLabel && (
              <Field label={modeMeta.refLabel}>
                <input
                  type="text"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  className={INPUT}
                  placeholder="Optional"
                />
              </Field>
            )}
          </div>

          {/* Receipt upload */}
          <Field label="Receipt / invoice (optional)">
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />
            {file ? (
              <div className="flex items-center justify-between rounded-lg border border-slate-300 px-3 py-2 text-sm">
                <span className="truncate text-[color:var(--color-ink)]">{file.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    setFile(null);
                    if (fileRef.current) fileRef.current.value = "";
                  }}
                  className="ml-3 text-xs text-red-600 hover:underline"
                >
                  Remove
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="w-full rounded-lg border border-dashed border-slate-300 px-3 py-2.5 text-sm text-[color:var(--color-ink-muted)] hover:border-[color:var(--color-brand-sky)]"
              >
                + Attach a PDF or image (≤ 10 MB)
              </button>
            )}
          </Field>

          {/* Note */}
          <Field label="Note (optional)">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={INPUT}
              placeholder="e.g. collected by field agent"
            />
          </Field>

          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[color:var(--color-ink-muted)] hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || busy}
            onClick={submit}
            className="rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Recording…" : valid ? `Collect ${money(amountNum)}` : "Collect payment"}
          </button>
        </footer>
      </div>
    </div>
  );
}

const INPUT =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[color:var(--color-brand-sky)] focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[color:var(--color-ink-muted)]">
        {label}
      </label>
      {children}
    </div>
  );
}

function Chip({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        active
          ? "border-[color:var(--color-brand-sky)] bg-[color:var(--color-brand-sky)]/10 text-[color:var(--color-brand-navy)]"
          : "border-slate-300 text-[color:var(--color-ink-muted)] hover:border-slate-400"
      }`}
    >
      {children}
    </button>
  );
}
