import Link from "next/link";
import { redirect } from "next/navigation";
import { gte, inArray, sql } from "drizzle-orm";
import { ShieldAlert, Radar } from "lucide-react";
import { db } from "@/lib/db";
import { securityEvents, securityFindings } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { getScanFreshness, STALE_AFTER_HOURS } from "@/lib/security/scan-run";

export const dynamic = "force-dynamic";

// Same single-role gate as the two security pages — see the comment in
// src/lib/security/route-guard.ts.
const ALLOWED_ROLES = new Set(["it"]);

const ACTIVE_STATUSES = ["open", "acknowledged"];

export default async function ItDashboardPage() {
  const user = await requireAuth();
  // Wrong role → bounce to "/", which middleware forwards to that role's own
  // dashboard. Sending them to /login instead would read as a forced logout.
  if (!ALLOWED_ROLES.has(user.role)) redirect("/");

  // Time windows live in SQL (now() - interval) so the render body stays pure.
  const [findingAgg, eventAgg, freshness] = await Promise.all([
    db
      .select({
        critical: sql<number>`cast(count(*) filter (where ${securityFindings.severity} = 'critical') as int)`,
        high: sql<number>`cast(count(*) filter (where ${securityFindings.severity} = 'high') as int)`,
        total: sql<number>`cast(count(*) as int)`,
      })
      .from(securityFindings)
      .where(inArray(securityFindings.status, ACTIVE_STATUSES)),
    db
      .select({
        last24h: sql<number>`cast(count(*) filter (where ${securityEvents.occurred_at} >= now() - interval '24 hours') as int)`,
        blocked24h: sql<number>`cast(count(*) filter (where ${securityEvents.occurred_at} >= now() - interval '24 hours' and ${securityEvents.action} = 'blocked') as int)`,
        unreviewed: sql<number>`cast(count(*) filter (where ${securityEvents.status} = 'new') as int)`,
      })
      .from(securityEvents)
      .where(gte(securityEvents.occurred_at, sql`now() - interval '7 days'`)),
    getScanFreshness(),
  ]);

  const findings = findingAgg[0] ?? { critical: 0, high: 0, total: 0 };
  const events = eventAgg[0] ?? { last24h: 0, blocked24h: 0, unreviewed: 0 };
  const detectionEnabled = process.env.SECURITY_DETECTION_ENABLED === "1";

  const cards = [
    {
      href: "/it/security",
      icon: ShieldAlert,
      title: "Security Risk",
      blurb:
        "Vulnerabilities the scanner agent found by walking the CRM — with reproduction steps, OWASP/CWE refs and remediation.",
      primary: `${findings.total} active finding${findings.total === 1 ? "" : "s"}`,
      secondary:
        findings.critical + findings.high > 0
          ? `${findings.critical} critical · ${findings.high} high`
          : "Nothing critical or high open",
      alert: findings.critical > 0,
      footer: freshness.in_flight
        ? "Scan running now…"
        : freshness.last_run_at
          ? `Last scan ${new Date(freshness.last_run_at).toLocaleString()}${
              freshness.is_stale ? ` · stale (>${STALE_AFTER_HOURS}h)` : ""
            }`
          : "Never scanned — run a scan to populate findings",
    },
    {
      href: "/it/security/live",
      icon: Radar,
      title: "Live Attacks",
      blurb:
        "Attacks caught in real time by the middleware detection layer — injection, traversal, SSRF, scanners and volumetric floods.",
      primary: `${events.last24h} event${events.last24h === 1 ? "" : "s"} in 24h`,
      secondary: `${events.blocked24h} blocked · ${events.unreviewed} unreviewed (7d)`,
      alert: events.unreviewed > 0,
      footer: detectionEnabled
        ? "Live detection is on"
        : "Live detection is off (SECURITY_DETECTION_ENABLED is not set)",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">IT Dashboard</h1>
        <p className="text-sm text-slate-500 mt-1">
          Application security for the iTarang CRM — scanner findings and live attack detection.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {cards.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="group block rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 transition-colors hover:border-slate-400 dark:hover:border-slate-600"
          >
            <div className="flex items-start gap-3">
              <span
                className={`shrink-0 rounded-lg p-2 ${
                  c.alert
                    ? "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400"
                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                }`}
              >
                <c.icon className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h2 className="font-semibold text-slate-900 dark:text-slate-100">{c.title}</h2>
                <p className="text-sm text-slate-500 mt-1">{c.blurb}</p>
              </div>
            </div>

            <div className="mt-4 flex items-baseline gap-3">
              <span
                className={`text-2xl font-semibold ${
                  c.alert ? "text-red-600 dark:text-red-400" : "text-slate-900 dark:text-slate-100"
                }`}
              >
                {c.primary}
              </span>
              <span className="text-sm text-slate-500">{c.secondary}</span>
            </div>

            <p className="mt-2 text-xs text-slate-500">{c.footer}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
