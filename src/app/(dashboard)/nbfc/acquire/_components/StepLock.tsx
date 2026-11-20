/**
 * E-387 — greys out a step's panels when the parent/child CIBIL approval
 * hierarchy does not let the current login act on it. The panels stay visible
 * (read-only); every button / input inside is disabled by the fieldset. The
 * API routes enforce the same rule, so this is presentation only.
 */
import type { ReactNode } from "react";

export default function StepLock({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs font-medium text-amber-900">
        <svg
          className="mt-0.5 h-4 w-4 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span>{reason}</span>
      </div>
      <fieldset disabled className="min-w-0 opacity-70">
        {children}
      </fieldset>
    </div>
  );
}
