import Card from "./Card";

export interface ActivityEntry {
  at: string;
  actor: string;
  role: string;
  action: string;
  detail?: string;
  from?: string;
  to?: string;
}

const ROLE_COLOR: Record<string, string> = {
  dealer: "#2563EB",
  admin: "#0B2239",
  vendor: "#0D9488",
  system: "#64748B",
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
  note,
}: {
  entries: ActivityEntry[];
  labelFor?: (action: string) => string;
  note?: string;
}) {
  const getRoleColor = (role: string): string => {
    return ROLE_COLOR[role.toLowerCase()] ?? ROLE_COLOR.system;
  };

  return (
    <div className="mt-4">
      {note && <div className="mb-2.5 text-xs text-slate-400">{note}</div>}
      <Card className="py-1.5">
        {entries.map((entry, i) => {
          const roleColor = getRoleColor(entry.role);

          return (
            <div key={i} className={`flex gap-3 px-4 py-[11px] ${i < entries.length - 1 ? "border-b border-[#F4F6F9]" : ""}`}>
              <div className="flex w-[10px] flex-none flex-col items-center">
                <div
                  className="mt-1 h-[9px] w-[9px] rounded-full"
                  style={{ backgroundColor: roleColor }}
                />
                {i < entries.length - 1 && <div className="mt-[3px] w-[2px] flex-1 bg-[#EEF2F7]" />}
              </div>
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-bold">{labelFor ? labelFor(entry.action) : entry.action}</span>
                  <span
                    className="rounded-[5px] px-[7px] py-px text-[10px] font-bold text-white"
                    style={{ backgroundColor: roleColor }}
                  >
                    {entry.role}
                  </span>
                </div>
                {entry.detail && <div className="mt-0.5 text-[12.5px] text-slate-500">{entry.detail}</div>}
                {(entry.to || (entry.from && entry.from !== "—")) && (
                  <div className="mt-1 flex items-center gap-1.5 text-xs tabular-nums">
                    {entry.from && (
                      <span className={entry.from === "—" ? "text-slate-400" : "text-slate-400 line-through"}>
                        {entry.from}
                      </span>
                    )}
                    {entry.to && (
                      <>
                        <span className="text-slate-400">→</span>
                        <span className="font-bold text-slate-900">{entry.to}</span>
                      </>
                    )}
                  </div>
                )}
                <div className="mt-[3px] text-[11px] text-slate-400">
                  {entry.at} · {entry.actor}
                </div>
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}
