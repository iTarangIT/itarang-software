import type { ReactNode } from "react";

import Card from "./Card";

/**
 * Document preview — proto docPreview() (iTarang Portal.dc.html:736-744): a
 * mock PO/invoice card with the navy iTarang letterhead strip. `children`
 * replaces the label/value row list wholesale for callers with a bespoke
 * body (e.g. a line-item table) instead of simple rows.
 */
export default function DocPreviewCard({
  title,
  docNumber,
  rows,
  badge,
  action,
  children,
}: {
  title: string;
  docNumber: string;
  rows: [string, string][];
  badge?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="text-[13.5px] font-bold text-slate-900">{title}</div>
        {badge && (
          <span className="rounded-full bg-[#EFF6FF] px-2.5 py-[3px] text-[11px] font-bold text-blue-600">
            {badge}
          </span>
        )}
      </div>
      <div className="overflow-hidden rounded-lg border border-gray-200">
        <div className="flex items-center justify-between bg-bb-navy px-3 py-2 text-[11.5px] text-white">
          <span className="font-bold">{docNumber}</span>
          <span className="text-[#7C93A8]">iTarang Technologies</span>
        </div>
        <div className="p-3">
          {children ??
            rows.map(([label, value], i) => (
              <div key={i} className="flex justify-between py-1 text-[12.5px]">
                <span className="text-slate-600">{label}</span>
                <span className="font-semibold text-slate-900">{value}</span>
              </div>
            ))}
        </div>
      </div>
      {action && <div className="mt-2.5">{action}</div>}
    </Card>
  );
}
