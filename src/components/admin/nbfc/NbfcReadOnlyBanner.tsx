import { Lock } from "lucide-react";

/**
 * Read-only banner shown above any past-step wizard form when the NBFC
 * is approved/active. Both admin and CEO see the same banner — neither
 * can edit a finalized NBFC. Pure presentation, no client state.
 */
export default function NbfcReadOnlyBanner() {
  return (
    <div
      role="status"
      data-testid="nbfc-readonly-banner"
      className="flex items-start gap-3 rounded-xl px-4 py-3 border"
      style={{
        background: "var(--color-info-bg, rgba(19,143,198,0.08))",
        borderColor: "rgba(19,143,198,0.30)",
        color: "var(--color-brand-navy)",
      }}
    >
      <span
        className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
        style={{
          background: "var(--color-brand-sky)",
          color: "#fff",
        }}
      >
        <Lock className="w-4 h-4" />
      </span>
      <div className="min-w-0 text-sm">
        <p className="font-semibold">
          Read-only — this NBFC has been approved
        </p>
        <p className="opacity-90 mt-0.5">
          All steps are locked for both admin and CEO. The signed LSP
          agreement is final; changes here are no longer accepted. To
          amend any detail, contact your CEO to request a new correction
          round.
        </p>
      </div>
    </div>
  );
}
