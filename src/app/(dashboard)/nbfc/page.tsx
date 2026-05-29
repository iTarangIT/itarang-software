import Link from "next/link";
import { db } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";
import { Briefcase, ChartLine, ClipboardList } from "lucide-react";
import { nbfcLeadAssignments } from "@/lib/db/schema";
import { getCurrentTenant } from "@/lib/nbfc/tenant";

// Portfolio Command Centre — Addendum V0.1 §7.1.
// Three workspaces: Acquire (in scope here), Monitor and Recover (separate
// team, kept linked so the existing pages remain reachable). The landing
// page no longer auto-redirects to Portfolio Overview; the user picks.

export const dynamic = "force-dynamic";

export default async function NbfcLanding() {
  const tenant = await getCurrentTenant();

  const counts = await db
    .select({
      pending: sql<number>`count(*) filter (where ${nbfcLeadAssignments.status} = 'pending')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(nbfcLeadAssignments)
    .where(eq(nbfcLeadAssignments.tenant_id, tenant.id));

  const pendingPicks = counts[0]?.pending ?? 0;
  const totalAssignments = counts[0]?.total ?? 0;

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <header className="mb-8">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
          {tenant.display_name}
        </p>
        <h1 className="text-3xl font-semibold text-[color:var(--color-brand-navy)] mt-2">
          Portfolio Command Centre
        </h1>
        <p className="text-sm text-slate-500 mt-2 max-w-2xl">
          Acquire is the pre-disbursal origination workspace. Monitor and Recover
          cover the post-disbursal lifecycle and are operated by a separate team.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <Link
          href="/nbfc/acquire"
          className="group block rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 hover:border-[color:var(--color-brand-sky)] hover:shadow-md transition"
        >
          <div className="flex items-center gap-3 mb-3">
            <Briefcase className="w-5 h-5 text-[color:var(--color-brand-sky)]" />
            <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)]">
              Acquire
            </h2>
          </div>
          <p className="text-sm text-slate-500 leading-relaxed">
            Pre-disbursal origination — lead pipeline, Field Investigation,
            Video KYC, financing-conditions submission.
          </p>
          <div className="mt-4 flex items-center gap-2 text-xs">
            <span className="inline-flex items-center px-2 py-1 rounded-md bg-[color:var(--color-brand-sky)]/10 text-[color:var(--color-brand-sky)] font-bold">
              {pendingPicks} pending
            </span>
            <span className="text-slate-400">{totalAssignments} total</span>
          </div>
        </Link>

        <Link
          href="/nbfc/portfolio"
          className="group block rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 hover:border-slate-400 hover:shadow-md transition"
        >
          <div className="flex items-center gap-3 mb-3">
            <ChartLine className="w-5 h-5 text-slate-500" />
            <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)]">
              Monitor
            </h2>
          </div>
          <p className="text-sm text-slate-500 leading-relaxed">
            Disbursed portfolio, telemetry, risk alerts, asset health and the
            audit log. Operated by a separate team.
          </p>
          <p className="text-xs text-slate-400 mt-4">{tenant.active_loans.toLocaleString("en-IN")} active loans</p>
        </Link>

        <Link
          href="/nbfc/recovery"
          className="group block rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 hover:border-slate-400 hover:shadow-md transition"
        >
          <div className="flex items-center gap-3 mb-3">
            <ClipboardList className="w-5 h-5 text-slate-500" />
            <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)]">
              Recover
            </h2>
          </div>
          <p className="text-sm text-slate-500 leading-relaxed">
            Delinquency pipeline, recovery actions and auction. Operated by a
            separate team.
          </p>
        </Link>
      </div>
    </div>
  );
}
