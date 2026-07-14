export interface ActivityEntry {
  at: string;
  actor: string;
  role: string;
  action: string;
  detail?: string;
  from?: string;
  to?: string;
}

const ROLE_STYLE: Record<string, string> = {
  Dealer: "bg-blue-50 text-blue-600",
  Admin: "bg-slate-100 text-bb-navy",
  Vendor: "bg-teal-50 text-teal-700",
  System: "bg-slate-100 text-slate-500",
};

/**
 * Audit-trail timeline — pattern from the prototype's activity log
 * (iTarang Portal.dc.html:1183-1198), redrawn as a dedicated atom: a dot +
 * rail on the left, action/role/actor/detail/transition/timestamp on the
 * right.
 */
export default function ActivityTimeline({
  entries,
  labelFor,
}: {
  entries: ActivityEntry[];
  labelFor?: (action: string) => string;
}) {
  return (
    <div>
      {entries.map((entry, i) => {
        const roleClass = ROLE_STYLE[entry.role] ?? "bg-slate-100 text-slate-500";

        return (
          <div key={i} className="flex gap-3 py-2.5">
            <div className="flex flex-col items-center">
              <div className="h-2 w-2 shrink-0 rounded-full bg-green-600" />
              {i < entries.length - 1 && <div className="mt-1 w-px flex-1 bg-slate-200" />}
            </div>
            <div className="flex-1 pb-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                  <span className="font-bold text-slate-900">{labelFor ? labelFor(entry.action) : entry.action}</span>
                  <span className={`rounded px-1.5 text-[10px] font-bold ${roleClass}`}>{entry.role}</span>
                  <span className="text-slate-500">{entry.actor}</span>
                </div>
                <span className="whitespace-nowrap text-[11px] text-slate-400">{entry.at}</span>
              </div>
              {entry.detail && <div className="mt-0.5 text-xs text-slate-500">{entry.detail}</div>}
              {(entry.from || entry.to) && (
                <div className="mt-1 flex items-center gap-1.5 text-[11px] tabular-nums text-slate-400">
                  {entry.from && <span>{entry.from}</span>}
                  {entry.from && entry.to && <span>→</span>}
                  {entry.to && <span>{entry.to}</span>}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
