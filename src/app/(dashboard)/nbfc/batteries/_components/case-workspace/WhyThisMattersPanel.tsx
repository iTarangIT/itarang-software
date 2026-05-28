"use client";

import type { CaseWhyThisMatters } from "./types";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-[color:var(--color-ink)]">
        {value ?? "—"}
      </p>
    </div>
  );
}

export function WhyThisMattersPanel({ wm }: { wm: CaseWhyThisMatters }) {
  return (
    <section
      aria-labelledby="why-matters-title"
      className="rounded-lg border border-sky-200 bg-sky-50/40 p-4"
    >
      <h3
        id="why-matters-title"
        className="mb-3 text-sm font-bold uppercase tracking-wide text-sky-700"
      >
        💡 Why this matters
      </h3>
      <div className="grid grid-cols-1 gap-2">
        <Row
          label="Default probability"
          value={
            wm.default_probability_pct != null
              ? `${wm.default_probability_pct}% (based on CDS)`
              : null
          }
        />
        <Row label="Evidence confidence" value={wm.evidence_confidence} />
        <Row
          label="Data freshness"
          value={
            wm.data_freshness
              ? new Date(wm.data_freshness).toLocaleString("en-IN")
              : null
          }
        />
        <Row label="Knowledge limits" value={wm.knowledge_limits} />
      </div>
    </section>
  );
}

export default WhyThisMattersPanel;
