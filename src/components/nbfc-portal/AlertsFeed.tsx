/**
 * AlertsFeed — "Needs attention now". The unified, severity-grouped alert
 * feed merging nbfc_risk_alerts (CDS/PCI) and telemetry_alerts (battery
 * telemetry). Groups are collapsible via native <details>; Critical is open
 * by default. A row's "View case" links to the borrower's loan when known.
 */
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { AlertFeedItem, AlertSeverity } from "@/lib/nbfc/command-centre";
import { formatRelativeIST } from "@/lib/nbfc/format";

const SEV_META: Record<
  AlertSeverity,
  { label: string; color: string }
> = {
  critical: { label: "Critical", color: "var(--color-danger)" },
  warning: { label: "Warning", color: "var(--color-warning)" },
  info: { label: "Info", color: "var(--color-brand-sky)" },
};

const SEV_ORDER: AlertSeverity[] = ["critical", "warning", "info"];

function viewCaseHref(item: AlertFeedItem): string {
  return item.loan_sanction_id
    ? `/nbfc/leads?focus=${encodeURIComponent(item.loan_sanction_id)}`
    : "/nbfc/risk";
}

function AlertRow({ item }: { item: AlertFeedItem }) {
  const sev = SEV_META[item.severity];
  const meta = [
    item.battery_serial,
    item.borrower_name,
    item.city,
    formatRelativeIST(item.created_at),
  ].filter((x): x is string => !!x);
  return (
    <li
      className="flex items-start gap-3 py-2.5 border-t border-[color:var(--color-border)] first:border-t-0"
      data-testid="cc-alert-row"
    >
      <span
        className="mt-1.5 w-2 h-2 rounded-full shrink-0"
        style={{ background: sev.color }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[color:var(--color-brand-navy)]">
          {item.title}
          {item.detail ? (
            <span className="font-normal text-[color:var(--color-ink-muted)]">
              {" "}
              — {item.detail}
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-ink-muted)] truncate">
          {meta.join(" · ")}
        </p>
      </div>
      <Link
        href={viewCaseHref(item)}
        className="shrink-0 text-[12px] font-semibold text-[color:var(--color-brand-sky)] hover:underline focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-sky)] rounded px-1"
      >
        View case
      </Link>
    </li>
  );
}

function SeverityGroup({
  severity,
  rows,
}: {
  severity: AlertSeverity;
  rows: AlertFeedItem[];
}) {
  const sev = SEV_META[severity];
  return (
    <details
      className="group rounded-lg border border-[color:var(--color-border)]"
      open={severity === "critical"}
      data-testid={`cc-alert-group-${severity}`}
    >
      <summary className="flex items-center gap-2 px-3 py-2.5 cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="w-4 h-4 shrink-0 transition-transform group-open:rotate-90 text-[color:var(--color-ink-muted)]" />
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ background: sev.color }}
          aria-hidden
        />
        <span className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
          {rows.length} {sev.label}
        </span>
      </summary>
      <ul className="px-3 pb-2">
        {rows.map((item) => (
          <AlertRow key={item.id} item={item} />
        ))}
      </ul>
    </details>
  );
}

export default function AlertsFeed({ items }: { items: AlertFeedItem[] }) {
  return (
    <section className="card-iTarang p-5" data-testid="cc-alerts">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-base font-semibold text-[color:var(--color-brand-navy)]">
          Needs attention now
        </h2>
        <p className="text-[12px] text-[color:var(--color-ink-muted)]">
          {items.length} active alert{items.length === 1 ? "" : "s"} · grouped by
          severity
        </p>
      </div>
      {items.length === 0 ? (
        <p
          className="mt-4 rounded-lg border border-[color:var(--color-border)] px-4 py-6 text-center text-sm text-[color:var(--color-ink-muted)]"
          data-testid="cc-alerts-empty"
        >
          Nothing needs attention — the portfolio is all clear.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {SEV_ORDER.map((sev) => {
            const rows = items.filter((i) => i.severity === sev);
            if (rows.length === 0) return null;
            return <SeverityGroup key={sev} severity={sev} rows={rows} />;
          })}
        </div>
      )}
    </section>
  );
}
