"use client";

/**
 * ScoreBadge — a clickable CDS / PCI score pill (BRD §6.1.5 + §6.4.5).
 *
 * Renders the score in its risk-band colour and, on tap, opens the
 * ScoreExplainabilityDrawer for that loan. Used wherever a CDS or PCI score
 * appears in the NBFC portal (Lead Intelligence, Battery Monitoring, the lead
 * detail drawer). CDS bands follow BRD §6.1.5 (0–39 low / 40–69 medium /
 * 70–100 high); thresholds default to the BRD values but can be overridden
 * from `nbfc_risk_rules` by the caller.
 */
import { useState } from "react";
import ScoreExplainabilityDrawer from "@/components/nbfc/scores/ScoreExplainabilityDrawer";

export type ScoreThresholds = {
  /** CDS medium-band lower bound (default 40). */
  cdsWarning?: number;
  /** CDS high-band lower bound (default 70). */
  cdsHigh?: number;
};

function cdsTone(v: number, warning: number, high: number): string {
  if (v >= high) return "status-pill-danger";
  if (v >= warning) return "status-pill-warning";
  return "status-pill-success";
}

function pciTone(v: number): string {
  // BRD §6.1.5 PCI zones: <0.40 concern · 0.40–0.75 monitor · >0.75 healthy.
  if (v < 0.4) return "status-pill-danger";
  if (v <= 0.75) return "status-pill-warning";
  return "status-pill-success";
}

export default function ScoreBadge({
  type,
  value,
  loanSanctionId,
  thresholds,
  className = "",
}: {
  type: "cds" | "pci";
  value: number | string | null | undefined;
  loanSanctionId: string | null | undefined;
  thresholds?: ScoreThresholds;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const num =
    value === null || value === undefined || value === ""
      ? null
      : Number(value);

  // No score yet, or no loan key to explain against → static muted dash.
  if (num === null || Number.isNaN(num) || !loanSanctionId) {
    return (
      <span
        className={`status-pill status-pill-neutral ${className}`}
        title="Score not yet computed"
      >
        —
      </span>
    );
  }

  const warning = thresholds?.cdsWarning ?? 40;
  const high = thresholds?.cdsHigh ?? 70;
  const tone = type === "cds" ? cdsTone(num, warning, high) : pciTone(num);
  const label = type === "cds" ? num.toFixed(0) : num.toFixed(2);

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // Stop the click bubbling to an enclosing clickable table row.
          e.stopPropagation();
          setOpen(true);
        }}
        className={`status-pill ${tone} cursor-pointer transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-sky)] focus:ring-offset-1 ${className}`}
        title={`${type.toUpperCase()} ${label} — tap for explainability`}
      >
        {label}
      </button>
      <ScoreExplainabilityDrawer
        loanSanctionId={loanSanctionId}
        scoreType={type}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
