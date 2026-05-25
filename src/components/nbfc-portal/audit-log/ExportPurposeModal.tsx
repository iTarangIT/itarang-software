"use client";

/**
 * CSV export confirmation modal.
 *
 * BRD §6.3.5 mandates MFA re-confirmation + purpose declaration before any
 * audit-log CSV leaves the system. Real Supabase MFA is not wired yet (see
 * plan: stubbed) — this modal enforces the purpose declaration and a
 * "legitimate use" confirmation, and the export itself is recorded as an
 * `audit_log_export` row by the API.
 */
import { useState } from "react";
import { Download, ShieldCheck, X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Invoked with the typed purpose. Should trigger the CSV download. */
  onConfirm: (purpose: string) => Promise<void> | void;
  filtersSummary: string;
  rowCount: number;
}

export function ExportPurposeModal({
  open,
  onClose,
  onConfirm,
  filtersSummary,
  rowCount,
}: Props) {
  const [purpose, setPurpose] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const purposeTooShort = purpose.trim().length < 10;
  const disabled = purposeTooShort || !confirmed || submitting;

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(purpose.trim());
      setPurpose("");
      setConfirmed(false);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-modal-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl bg-[color:var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[color:var(--color-border)] px-5 py-4">
          <div className="flex gap-3">
            <div className="rounded-lg bg-sky-50 p-2 text-[color:var(--color-brand-sky)]">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h2
                id="export-modal-title"
                className="text-base font-semibold text-[color:var(--color-brand-navy)]"
              >
                Export audit log
              </h2>
              <p className="text-xs text-[color:var(--color-ink-muted)]">
                Per RBI Digital Lending Directions 2025 § 6.3.5
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-bg)]"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3 text-xs">
            <div className="font-semibold text-[color:var(--color-ink)]">
              {rowCount.toLocaleString("en-IN")} events will be exported
            </div>
            <div className="mt-0.5 text-[color:var(--color-ink-muted)]">
              {filtersSummary}
            </div>
          </div>

          {/* MFA placeholder — slot for a future Supabase MFA challenge block.
              Today it surfaces the requirement without gating, so QA sees the
              future shape. */}
          <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-amber-50/30 p-3 text-xs text-[color:var(--color-ink-muted)]">
            <span className="font-semibold text-amber-900">MFA</span> —
            once enrolment is live, a one-time code from your authenticator app
            will be required here.
          </div>

          <label className="block">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
              Purpose declaration · required
            </span>
            <textarea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              rows={3}
              placeholder="e.g. Quarterly compliance review for RBI inspection on 2026-06-15"
              className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-2 text-sm text-[color:var(--color-ink)] focus:outline focus:outline-2 focus:outline-[color:var(--color-brand-sky)] focus:outline-offset-[-1px]"
            />
            <span className="mt-1 block text-[11px] text-[color:var(--color-ink-muted)]">
              {purpose.length}/10 minimum characters. This statement is recorded
              with your user id in the audit log.
            </span>
          </label>

          <label className="flex items-start gap-2 text-xs text-[color:var(--color-ink)]">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I confirm this export is for legitimate compliance use and will be
              handled per our data-handling policy.
            </span>
          </label>

          {error ? (
            <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-ink)] hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={disabled}
            className="inline-flex items-center gap-2 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {submitting ? "Exporting…" : "Download CSV"}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default ExportPurposeModal;
