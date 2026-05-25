"use client";

/**
 * Shared chrome for the four action modals (payment reminder, field visit,
 * battery immobilisation, loan restructuring). Renders the title, sub-title
 * ("Evidence → Decision → Action → Audit"), and the close button. Body content
 * is passed via children; the bottom Cancel / Submit-for-approval row is
 * provided by the caller because the submit label and disabled state vary.
 */
import { ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  caseSubtitle: string;
  children: ReactNode;
  footer: ReactNode;
}

export function ModalShell({
  open,
  onClose,
  title,
  caseSubtitle,
  children,
  footer,
}: Props) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="action-modal-title"
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-10"
    >
      <div className="w-full max-w-xl rounded-xl bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-[color:var(--color-border)] p-5">
          <div className="min-w-0">
            <h2
              id="action-modal-title"
              className="text-lg font-semibold text-[color:var(--color-ink)]"
            >
              {title}
            </h2>
            <p className="mt-1 text-xs text-[color:var(--color-ink-muted)]">
              {caseSubtitle} · Evidence → Decision → Action → Audit
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-lg leading-none text-[color:var(--color-ink-muted)] hover:bg-slate-100"
          >
            ×
          </button>
        </header>
        <div className="space-y-4 p-5">{children}</div>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[color:var(--color-border)] bg-[color:var(--color-surface-muted)] p-4">
          {footer}
        </footer>
      </div>
    </div>
  );
}

export default ModalShell;
