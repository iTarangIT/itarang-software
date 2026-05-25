"use client";

import ScoreBadge from "@/components/nbfc-portal/ScoreBadge";
import type { CaseFlagged } from "./types";

interface Props {
  flagged: CaseFlagged;
  loanSanctionId: string;
  bands: { low_mid: number; mid_high: number };
}

function confidencePill(confidence: string | null) {
  const v = (confidence ?? "").toUpperCase();
  const tone =
    v === "HIGH"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : v === "MEDIUM"
        ? "bg-amber-50 text-amber-800 border-amber-200"
        : "bg-slate-100 text-slate-600 border-slate-200";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}
    >
      Confidence · {v || "—"}
    </span>
  );
}

export function WhyFlaggedPanel({ flagged, loanSanctionId, bands }: Props) {
  return (
    <section
      aria-labelledby="why-flagged-title"
      className="rounded-lg border border-amber-200 bg-amber-50/60 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id="why-flagged-title"
          className="text-sm font-bold uppercase tracking-wide text-amber-800"
        >
          ⚠ Why this account is flagged
        </h3>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[color:var(--color-ink-muted)]">
        {confidencePill(flagged.confidence)}
        {flagged.last_updated ? (
          <span className="inline-flex items-center gap-1">
            🕒 Last updated:{" "}
            {new Date(flagged.last_updated).toLocaleString("en-IN")}
          </span>
        ) : null}
      </div>
      {flagged.reasons.length > 0 ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[color:var(--color-ink)]">
          {flagged.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm italic text-[color:var(--color-ink-muted)]">
          No flagged reasons recorded.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ScoreBadge
          type="cds"
          value={flagged.cds_score}
          loanSanctionId={loanSanctionId}
          thresholds={{ cdsWarning: bands.low_mid, cdsHigh: bands.mid_high }}
        />
        <ScoreBadge
          type="pci"
          value={flagged.pci_score}
          loanSanctionId={loanSanctionId}
        />
        <span className="text-[11px] text-[color:var(--color-ink-muted)]">
          (click any score to see formula, inputs &amp; limits)
        </span>
      </div>
    </section>
  );
}

export default WhyFlaggedPanel;
