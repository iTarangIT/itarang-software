/**
 * CommandNavStrip — 3 nav tiles into Risk Alerts / Lead Intelligence /
 * Recovery, each with a live count. Replaces the demo's ACQUIRE/MONITOR/
 * RECOVER cards (ACQUIRE was pre-disbursement underwriting — not a concern of
 * this post-disbursement partner portal).
 */
import Link from "next/link";
import { ArrowRight, ClipboardList, Search, Siren } from "lucide-react";
import type { NavCounts } from "@/lib/nbfc/command-centre";
import { inr } from "@/lib/nbfc/format";

export default function CommandNavStrip({ counts }: { counts: NavCounts }) {
  const tiles = [
    {
      href: "/nbfc/risk",
      label: "Risk Alerts",
      count: counts.risk_alerts_open,
      unit: "open alerts",
      Icon: Siren,
    },
    {
      href: "/nbfc/leads",
      label: "Lead Intelligence",
      count: counts.leads_total,
      unit: "active loans",
      Icon: Search,
    },
    {
      href: "/nbfc/recovery",
      label: "Recovery & Auction",
      count: counts.recovery_open,
      unit: "in pipeline",
      Icon: ClipboardList,
    },
  ];
  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-3"
      data-testid="cc-nav-strip"
    >
      {tiles.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          data-testid={`cc-nav-${t.href.split("/").pop()}`}
          className="card-iTarang p-4 flex items-center gap-3 transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-sky)]"
        >
          <span
            className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "var(--color-info-bg)" }}
          >
            <t.Icon
              className="w-5 h-5"
              style={{ color: "var(--color-brand-sky)" }}
            />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
              {t.label}
            </p>
            <p className="text-[12px] text-[color:var(--color-ink-muted)]">
              <span className="font-semibold tabular-nums">{inr(t.count)}</span>{" "}
              {t.unit}
            </p>
          </div>
          <ArrowRight
            className="w-4 h-4 shrink-0"
            style={{ color: "var(--color-brand-sky)" }}
          />
        </Link>
      ))}
    </div>
  );
}
