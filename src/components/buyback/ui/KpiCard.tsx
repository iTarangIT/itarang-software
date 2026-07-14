import type { ReactNode } from "react";

/**
 * KPI stat tile — proto kpi() (iTarang Portal.dc.html:432-436), plus the navy
 * "hero" variant used for the one emphasized metric per screen (e.g. "Total
 * Margin Earned", handoff:800). `accent` is a Tailwind text-color class (e.g.
 * "text-blue-600"), not a raw hex — this kit is Tailwind-first throughout.
 */
export default function KpiCard({
  label,
  value,
  accent = "text-slate-900",
  note,
  variant = "default",
}: {
  label: string;
  value: ReactNode;
  accent?: string;
  note?: string;
  variant?: "default" | "navy";
}) {
  if (variant === "navy") {
    return (
      <div className="rounded-[10px] bg-[linear-gradient(135deg,#0B2239,#123a5c)] px-[18px] py-4 text-white transition hover:-translate-y-px hover:shadow-[0_4px_14px_rgba(15,23,42,.10)]">
        <div className="text-[12px] font-semibold text-[#9FB4C6]">{label}</div>
        <div className="mt-1.5 text-[28px] font-extrabold tabular-nums text-green-400">{value}</div>
        {note && <div className="mt-[3px] text-[11.5px] text-[#9FB4C6]">{note}</div>}
      </div>
    );
  }

  return (
    <div className="rounded-[10px] border border-gray-200 bg-white px-[18px] py-4 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:-translate-y-px hover:shadow-[0_4px_14px_rgba(15,23,42,.10)]">
      <div className="text-[12px] font-semibold text-slate-500">{label}</div>
      <div className={`mt-1.5 text-[26px] font-extrabold tabular-nums ${accent}`}>{value}</div>
      {note && <div className="mt-[3px] text-[11.5px] text-slate-400">{note}</div>}
    </div>
  );
}
