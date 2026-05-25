"use client";

/**
 * Single dense table row for the NBFC audit log. Designed to read like a
 * Razorpay/Stripe-dashboard event row: monospaced timestamps + entity IDs,
 * status pill with coloured dot, truncated reason with title-tooltip.
 */
import { entityTone, statusTone, type AuditLogRow } from "./types";

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function AuditLogRowItem({
  row,
  onClick,
}: {
  row: AuditLogRow;
  onClick: () => void;
}) {
  const tone = statusTone(row.status);
  const ent = entityTone(row.entity.type);
  return (
    <tr
      onClick={onClick}
      className="cursor-pointer border-b border-[color:var(--color-border)]/70 transition-colors hover:bg-slate-50/70"
    >
      <td className="whitespace-nowrap px-4 py-2.5 align-top font-mono text-[11px] tabular-nums text-[color:var(--color-ink-muted)]">
        {row.timestamp ? dateFmt.format(new Date(row.timestamp)) : "—"}
      </td>
      <td className="px-4 py-2.5 align-top">
        <span
          className={`mr-2 inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${ent.bg} ${ent.text}`}
        >
          {ent.label}
        </span>
        <span className="font-mono text-[11px] text-[color:var(--color-ink)]">
          {row.entity.label ?? "—"}
        </span>
      </td>
      <td className="px-4 py-2.5 align-top text-sm font-semibold text-[color:var(--color-ink)]">
        {row.action_label}
      </td>
      <td className="px-4 py-2.5 align-top text-xs text-[color:var(--color-ink-muted)]">
        {row.reason_text ? (
          <span title={row.reason_text}>{truncate(row.reason_text, 60)}</span>
        ) : (
          <span className="text-[color:var(--color-ink-muted)]/60">—</span>
        )}
      </td>
      <td className="px-4 py-2.5 align-top text-xs">
        <div className="font-medium text-[color:var(--color-ink)]">
          {row.requested_by.name ?? row.requested_by.id ?? "—"}
        </div>
        {row.requested_by.role ? (
          <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-ink-muted)]">
            {row.requested_by.role.replace(/_/g, " ")}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-2.5 align-top text-xs">
        {row.approved_by ? (
          <div className="font-medium text-[color:var(--color-ink)]">
            {row.approved_by.name ?? row.approved_by.id}
          </div>
        ) : (
          <span className="text-[color:var(--color-ink-muted)]/60">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-2.5 align-top">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone.bg} ${tone.text}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
          {tone.label}
        </span>
      </td>
    </tr>
  );
}

export default AuditLogRowItem;
