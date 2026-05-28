"use client";

/**
 * E-111 — floating tray showing the CEO's in-progress flag batch.
 *
 * Appears only when the viewer is CEO. The bottom-right pill shows the
 * current pending-flag count and either:
 *   • "Enable flag mode" when no flags are pending and flag mode is off,
 *   • "Disable flag mode" when on with no pending flags,
 *   • "Review & submit (N)" when ≥1 flag is pending.
 *
 * Clicking "Review & submit" opens a side drawer listing each flagged item
 * with an editable remark, plus an overall summary remark. Submitting POSTs
 * to /api/admin/nbfc/{nbfcId}/corrections via the context.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send, X } from "lucide-react";
import {
  compositeKey,
  useCorrectionFlagContext,
  type PendingFlag,
} from "./correction-flag-context";
import {
  type CorrectionKind,
  labelFor,
} from "@/lib/nbfc/admin/correction-catalog";

export default function NbfcPendingFlagsTray() {
  const {
    viewerIsCeo,
    pendingFlags,
    setRemark,
    toggleFlag,
    clearFlags,
    submitting,
    submit,
  } = useCorrectionFlagContext();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!viewerIsCeo) return null;

  const count = pendingFlags.size;

  return (
    <>
      {/* Flag-mode toggle lives in NbfcFinalApprovalPanel's action row
          (next to Approve/Reject). The tray only surfaces when the CEO
          has flagged at least one item — then it's the submit pill. */}
      {count > 0 && (
        <div
          className="fixed bottom-6 right-6 z-40"
          data-testid="ceo-flag-tray"
        >
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="inline-flex items-center gap-2 rounded-full px-4 h-11 text-sm font-semibold shadow-lg"
            style={{
              background: "var(--color-warning)",
              color: "white",
            }}
          >
            <Send className="w-4 h-4" />
            Review &amp; submit ({count})
          </button>
        </div>
      )}

      {drawerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Review and submit correction requests"
          className="fixed inset-0 z-50 flex items-stretch justify-end"
          style={{ background: "rgba(0,0,0,0.45)" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setDrawerOpen(false);
          }}
        >
          <div
            className="bg-white shadow-2xl flex flex-col w-full"
            style={{ maxWidth: 560 }}
          >
            <header className="flex items-center justify-between px-5 py-4 border-b border-[color:var(--color-border)]">
              <div>
                <p className="section-label-muted">
                  Correction request · {count} item{count === 1 ? "" : "s"}
                </p>
                <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)] mt-0.5">
                  Review &amp; submit
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close drawer"
                className="btn-ghost inline-flex items-center justify-center w-8 h-8 p-0"
              >
                <X className="w-4 h-4" />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div className="space-y-2">
                <label
                  htmlFor="summary-remarks"
                  className="text-xs font-semibold text-[color:var(--color-ink-muted)] uppercase tracking-wider"
                >
                  Overall remark (optional)
                </label>
                <textarea
                  id="summary-remarks"
                  rows={2}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="One-line summary the admin will see at the top of the corrections panel."
                  className="w-full rounded-md border border-[color:var(--color-border)] px-3 py-2 text-[13px]"
                />
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold text-[color:var(--color-ink-muted)] uppercase tracking-wider">
                  Per-item remarks
                </p>
                {Array.from(pendingFlags.entries()).map(([key, flag]) => (
                  <PendingFlagRow
                    key={key}
                    compositeKeyVal={key}
                    flag={flag}
                    onRemarkChange={(remark) => setRemark(key, remark)}
                    onRemove={() =>
                      toggleFlag({
                        kind: flag.kind,
                        targetKey: flag.targetKey,
                        targetRefId: flag.targetRefId,
                      })
                    }
                  />
                ))}
              </div>

              {error && (
                <p
                  data-testid="flag-submit-error"
                  className="text-sm rounded-lg px-3 py-2"
                  style={{
                    background: "var(--color-danger-bg)",
                    color: "var(--color-danger)",
                  }}
                >
                  {error}
                </p>
              )}
            </div>

            <footer className="flex items-center justify-between gap-3 px-5 py-4 border-t border-[color:var(--color-border)]">
              <button
                type="button"
                onClick={() => {
                  clearFlags();
                  setSummary("");
                  setError(null);
                  setDrawerOpen(false);
                }}
                className="text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-brand-navy)]"
              >
                Discard all flags
              </button>
              <button
                type="button"
                data-testid="submit-corrections-button"
                disabled={submitting || count === 0}
                onClick={async () => {
                  setError(null);
                  const r = await submit(summary);
                  if (r.ok) {
                    setSummary("");
                    setDrawerOpen(false);
                    router.refresh();
                  } else {
                    setError(r.error ?? "Submit failed.");
                  }
                }}
                className={
                  submitting || count === 0
                    ? "btn-primary opacity-50 cursor-not-allowed inline-flex items-center gap-2"
                    : "btn-primary inline-flex items-center gap-2"
                }
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                <Send className="w-4 h-4" />
                Send corrections to admin
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

function PendingFlagRow({
  flag,
  onRemarkChange,
  onRemove,
}: {
  compositeKeyVal: string;
  flag: PendingFlag;
  onRemarkChange: (remark: string) => void;
  onRemove: () => void;
}) {
  return (
    <div
      className="rounded-lg border border-[color:var(--color-border)] p-3 space-y-2"
      style={{ background: "var(--color-bg)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
          {labelFor(flag.kind as CorrectionKind, flag.targetKey)}
        </p>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove this flag"
          className="text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-danger)]"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <textarea
        rows={2}
        value={flag.remark}
        onChange={(e) => onRemarkChange(e.target.value)}
        placeholder="What needs to change? (optional)"
        className="w-full rounded-md border border-[color:var(--color-border)] px-2 py-1.5 text-[12px]"
      />
    </div>
  );
}
