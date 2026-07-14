/**
 * Provenance completeness bar — proto (iTarang Portal.dc.html:831), the small
 * meter shown in the admin review queue next to each request's provenance %.
 * The fill width is a genuinely dynamic percentage, so it's set via inline
 * style rather than a Tailwind class — Tailwind's build-time scanner can't
 * see a class name assembled from a runtime number.
 */
export default function ProvenanceBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const fillClass = clamped >= 80 ? "bg-green-600" : clamped >= 50 ? "bg-amber-500" : "bg-red-600";

  return (
    <div className="flex items-center gap-[7px]">
      <div className="h-[6px] w-[46px] overflow-hidden rounded bg-slate-100">
        <div className={`h-full ${fillClass}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="text-[11.5px] font-semibold text-slate-500">{clamped}%</span>
    </div>
  );
}
