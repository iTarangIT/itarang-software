"use client";

/**
 * Lead-scoped audit timeline — embedded inside the Lead Intelligence drawer.
 *
 * Calls GET /api/nbfc/audit-log with entityId filtered to either the loan
 * sanction id (when set on the lead) or the lead id (matched against
 * payload.context.lead_id in the API). Renders a compact event list using the
 * same status/entity tone tokens as the full audit page.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  buildQueryString,
  statusTone,
  type AuditLogResponse,
  type AuditLogRow,
  EMPTY_FILTERS,
} from "./types";

interface Props {
  /** Either the loan sanction id or the lead id — whichever uniquely scopes the timeline. */
  entityId: string;
  /** Optional link to the full audit page filtered to this entity. */
  showFullLink?: boolean;
}

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function LeadAuditTimeline({ entityId, showFullLink = true }: Props) {
  const [items, setItems] = useState<AuditLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const qs = buildQueryString(
          { ...EMPTY_FILTERS, entityId },
          { limit: 20 },
        );
        const res = await fetch(`/api/nbfc/audit-log?${qs}`, {
          cache: "no-store",
        });
        const body: AuditLogResponse | { ok: false; error: string } =
          await res.json();
        if (cancelled) return;
        if (!res.ok || !("items" in body)) {
          setError(
            "error" in body && typeof body.error === "string"
              ? body.error
              : `HTTP ${res.status}`,
          );
          setItems([]);
          return;
        }
        setItems(body.items);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setItems([]);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [entityId]);

  if (items === null) {
    return (
      <p className="text-xs italic text-[color:var(--color-ink-muted)]">
        Loading timeline…
      </p>
    );
  }

  if (items.length === 0) {
    return (
      <div className="space-y-2">
        {error ? (
          <p className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
            {error}
          </p>
        ) : null}
        <p className="rounded border border-dashed border-[color:var(--color-border)] p-3 text-xs italic text-[color:var(--color-ink-muted)]">
          No audit events recorded yet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ul className="space-y-1.5">
        {items.map((r) => {
          const tone = statusTone(r.status);
          return (
            <li
              key={r.id}
              className="flex items-start gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-2"
            >
              <span className={`mt-1.5 h-1.5 w-1.5 flex-none rounded-full ${tone.dot}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-[color:var(--color-ink)]">
                    {r.action_label}
                  </span>
                  <span className="flex-none font-mono text-[10px] tabular-nums text-[color:var(--color-ink-muted)]">
                    {r.timestamp ? dateFmt.format(new Date(r.timestamp)) : "—"}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-[color:var(--color-ink-muted)]">
                  <span className={`rounded-full px-1.5 py-0.5 font-semibold ${tone.bg} ${tone.text}`}>
                    {tone.label}
                  </span>
                  {r.requested_by.name ? (
                    <span>· {r.requested_by.name}</span>
                  ) : null}
                  {r.reason_text ? (
                    <span className="truncate">· {r.reason_text}</span>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {showFullLink ? (
        <Link
          href={`/nbfc/audit?entityId=${encodeURIComponent(entityId)}`}
          className="text-xs font-semibold text-[color:var(--color-brand-sky)] hover:underline"
        >
          View full audit log →
        </Link>
      ) : null}
    </div>
  );
}

export default LeadAuditTimeline;
