/**
 * WeeklyPanel — "This week": four factual portfolio-movement stats derived
 * from real tables (no editorialised prose). Window is a rolling 7 days.
 */
import { BellRing, CheckCircle2, Recycle, ShieldOff } from "lucide-react";
import type { WeeklyStats } from "@/lib/nbfc/command-centre";

export default function WeeklyPanel({ weekly }: { weekly: WeeklyStats }) {
  const stats = [
    {
      key: "emis",
      label: "EMIs settled",
      value: weekly.emis_settled,
      hint: "paid in the last 7 days",
      Icon: CheckCircle2,
    },
    {
      key: "alerts",
      label: "New risk alerts",
      value: weekly.new_risk_alerts,
      hint: "raised in the last 7 days",
      Icon: BellRing,
    },
    {
      key: "recovery",
      label: "Recovery added",
      value: weekly.recovery_added,
      hint: "batteries entered the pipeline",
      Icon: Recycle,
    },
    {
      key: "immob",
      label: "Immobilisations",
      value: weekly.immobilisations_executed,
      hint: "executed in the last 7 days",
      Icon: ShieldOff,
    },
  ];
  return (
    <section className="card-iTarang p-5" data-testid="cc-weekly">
      <h2 className="text-base font-semibold text-[color:var(--color-brand-navy)]">
        This week
      </h2>
      <p className="mt-1 text-[12px] text-[color:var(--color-ink-muted)]">
        Portfolio movement over the last 7 days.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.key} data-testid={`cc-weekly-${s.key}`}>
            <div className="flex items-center gap-2">
              <s.Icon
                className="w-4 h-4 shrink-0"
                style={{ color: "var(--color-brand-sky)" }}
              />
              <p className="text-[28px] leading-none font-semibold text-[color:var(--color-brand-navy)] tabular-nums">
                {s.value}
              </p>
            </div>
            <p className="mt-2 text-sm font-medium text-[color:var(--color-brand-navy)]">
              {s.label}
            </p>
            <p className="text-[12px] text-[color:var(--color-ink-muted)]">
              {s.hint}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
