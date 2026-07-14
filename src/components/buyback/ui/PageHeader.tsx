import type { ReactNode } from "react";

/**
 * Page header — proto H() (design handoff, iTarang Portal.dc.html:423-429).
 * Title + optional subtitle on the left, an optional action slot (e.g. a
 * primary button) on the right.
 */
export default function PageHeader({
  title,
  sub,
  right,
}: {
  title: string;
  sub?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="text-[22px] font-extrabold tracking-[-.3px] text-slate-900">{title}</div>
        {sub && <div className="mt-[3px] text-[13px] text-slate-500">{sub}</div>}
      </div>
      {right ?? null}
    </div>
  );
}
