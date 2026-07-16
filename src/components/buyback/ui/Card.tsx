import type { ReactNode } from "react";

/**
 * Card shell — proto card() (iTarang Portal.dc.html:430), the base surface
 * every buyback panel sits on. The optional `title` row matches the design's
 * per-panel header pattern (e.g. "Battery lines", "Recent requests").
 */
export default function Card({
  title,
  action,
  className = "",
  children,
}: {
  title?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-[10px] border border-gray-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,.04)] ${className}`}
    >
      {title && (
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 text-[13px] font-bold">
          <span>{title}</span>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
