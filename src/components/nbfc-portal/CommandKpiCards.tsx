/**
 * CommandKpiCards — the 4-card KPI row of the Portfolio Command Centre.
 *
 * Active Loans and Delinquency carry an honest trend delta (computed only
 * where history supports it — see command-centre.ts); At-Risk and Recovery
 * render plain. Visual language inherits from PortfolioSummaryCards.
 */
import { AlertOctagon, AlertTriangle, Layers3, Recycle } from "lucide-react";
import type { CommandCentreKpis, KpiDelta } from "@/lib/nbfc/command-centre";
import { inr, inrCompact } from "@/lib/nbfc/format";

function DeltaChip({ delta }: { delta: KpiDelta | null }) {
  if (!delta) return null;
  const color =
    delta.tone === "good"
      ? "var(--color-success)"
      : delta.tone === "bad"
        ? "var(--color-danger)"
        : "var(--color-ink-muted)";
  return (
    <span
      className="text-[12px] font-semibold tabular-nums"
      style={{ color }}
    >
      {delta.text}
    </span>
  );
}

type Tone = "neutral" | "warning";

function toneStyles(tone: Tone) {
  if (tone === "warning") {
    return {
      iconWrap: { background: "var(--color-warning-bg)" },
      iconColor: "var(--color-warning)",
    };
  }
  return {
    iconWrap: { background: "var(--color-info-bg)" },
    iconColor: "var(--color-brand-sky)",
  };
}

function KpiCard({
  testId,
  label,
  value,
  caption,
  delta,
  Icon,
  tone,
}: {
  testId: string;
  label: string;
  value: string;
  caption: string;
  delta: KpiDelta | null;
  Icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  tone: Tone;
}) {
  const t = toneStyles(tone);
  return (
    <div className="card-iTarang p-5" data-testid={testId}>
      <div className="flex items-start justify-between gap-3">
        <p className="section-label-muted">{label}</p>
        <span
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={t.iconWrap}
        >
          <Icon className="w-4 h-4" style={{ color: t.iconColor }} />
        </span>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <p className="text-[28px] leading-tight font-semibold text-[color:var(--color-brand-navy)] tabular-nums">
          {value}
        </p>
        <DeltaChip delta={delta} />
      </div>
      <p className="mt-2 text-[12px] text-[color:var(--color-ink-muted)]">
        {caption}
      </p>
    </div>
  );
}

export default function CommandKpiCards({ kpis }: { kpis: CommandCentreKpis }) {
  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      data-testid="cc-kpis"
    >
      <KpiCard
        testId="cc-kpi-active-loans"
        label="Active Loans"
        value={inr(kpis.active_loans.value)}
        caption="Disbursed and not yet closed."
        delta={kpis.active_loans.delta}
        Icon={Layers3}
        tone="neutral"
      />
      <KpiCard
        testId="cc-kpi-at-risk"
        label="At-Risk Accounts"
        value={inr(kpis.at_risk.value)}
        caption={`${kpis.at_risk.pct_of_book.toFixed(1)}% of the active book — 30+ days overdue or a warning or critical telemetry alert.`}
        delta={null}
        Icon={AlertTriangle}
        tone="warning"
      />
      <KpiCard
        testId="cc-kpi-delinquency"
        label="Delinquency Rate"
        value={`${kpis.delinquency_rate.value.toFixed(2)}%`}
        caption="Active loans with an EMI overdue > 30 days."
        delta={kpis.delinquency_rate.delta}
        Icon={AlertOctagon}
        tone={kpis.delinquency_rate.value > 5 ? "warning" : "neutral"}
      />
      <KpiCard
        testId="cc-kpi-recovery"
        label="Recovery in Motion"
        value={inrCompact(kpis.recovery_in_motion.amount_inr)}
        caption={`${inr(kpis.recovery_in_motion.count)} batteries in the recovery pipeline.`}
        delta={null}
        Icon={Recycle}
        tone="neutral"
      />
    </div>
  );
}
