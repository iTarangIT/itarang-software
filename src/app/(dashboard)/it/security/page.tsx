import { redirect } from "next/navigation";
import { desc, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityFindings, securityScanRuns } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { getScanFreshness, STALE_AFTER_HOURS } from "@/lib/security/scan-run";
import { severityRank, type Severity } from "@/lib/security/severity";
import { CATEGORY_LABELS, type SecurityCategory } from "@/lib/security/types";
import RunScanButton from "./_components/RunScanButton";
import FilterBar from "./_components/FilterBar";
import ExportMenu from "./_components/ExportMenu";
import SeverityStatCards from "./_components/SeverityStatCards";
import SecurityNavTabs from "./_components/SecurityNavTabs";
import SecurityFindings, { type FindingForUi } from "./_components/SecurityFindings";

export const dynamic = "force-dynamic";

// The IT Dashboard is the only home for the security surface — see the comment
// in src/lib/security/route-guard.ts for why admin/ceo are not on this list.
const ALLOWED_ROLES = new Set(["it"]);
const ACTIVE_STATUSES = ["open", "acknowledged"];

interface SearchParams {
  severity?: string;
  category?: string;
  status?: string;
}

async function load(sp: SearchParams) {
  const statusFilter = sp.status && sp.status !== "active" ? [sp.status] : ACTIVE_STATUSES;

  const rows = await db
    .select()
    .from(securityFindings)
    .where(inArray(securityFindings.status, statusFilter))
    .orderBy(desc(securityFindings.created_at));

  const findings: FindingForUi[] = rows.map((r) => ({
    id: r.id,
    check_slug: r.check_slug,
    category: r.category as SecurityCategory,
    severity: r.severity as Severity,
    title: r.title,
    summary: r.summary,
    target_url: r.target_url,
    http_method: r.http_method,
    evidence_json: r.evidence_json as Record<string, unknown> | null,
    reproduction: r.reproduction,
    remediation: r.remediation,
    owasp_ref: r.owasp_ref,
    cwe_ref: r.cwe_ref,
    confidence: r.confidence,
    status: r.status,
    created_at: r.created_at?.toISOString() ?? null,
    resolution_summary: r.resolution_summary,
    resolution_report: r.resolution_report as Record<string, unknown> | null,
    resolution_method: r.resolution_method,
  }));

  // KPI counts over the full active set (independent of the severity/category view filter).
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  // Grid view filter.
  const sevFilter = sp.severity as Severity | undefined;
  const catFilter = sp.category as SecurityCategory | undefined;
  const visible = findings
    .filter((f) => (sevFilter ? f.severity === sevFilter : true))
    .filter((f) => (catFilter ? f.category === catFilter : true))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  return { findings, visible, counts, total: findings.length };
}

export default async function SecurityDashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireAuth();
  // Wrong role → bounce to "/", which middleware forwards to that role’s own
  // dashboard. Sending them to /login instead would read as a forced logout.
  if (!ALLOWED_ROLES.has(user.role)) redirect("/");

  const sp = await searchParams;
  const [{ visible, counts, total }, freshness, lastRunRows] = await Promise.all([
    load(sp),
    getScanFreshness(),
    db
      .select({
        target_base_url: securityScanRuns.target_base_url,
        target_env: securityScanRuns.target_env,
        mode: securityScanRuns.mode,
        surfaces_walked: securityScanRuns.surfaces_walked,
      })
      .from(securityScanRuns)
      .orderBy(desc(securityScanRuns.started_at))
      .limit(1),
  ]);
  const lastRun = lastRunRows[0] ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Security Risk</h1>
          <p className="text-sm text-slate-500 mt-1">
            Vulnerabilities the scanner agent found by walking the CRM (starting at dealer
            onboarding). {total} active finding{total === 1 ? "" : "s"}
            {lastRun ? ` · target ${lastRun.target_env} (${lastRun.mode})` : ""}.
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {freshness.in_flight ? (
              <span className="text-slate-600 dark:text-slate-400">Scan running now…</span>
            ) : freshness.last_run_at ? (
              <>
                Last scan {new Date(freshness.last_run_at).toLocaleString()}
                {freshness.is_stale ? (
                  <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 font-medium">
                    Stale — older than {STALE_AFTER_HOURS}h
                  </span>
                ) : null}
              </>
            ) : (
              <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 font-medium">
                Never scanned — run a scan to populate findings
              </span>
            )}
          </p>
        </div>
        <RunScanButton inFlight={freshness.in_flight} />
      </div>

      <SecurityNavTabs />

      <SeverityStatCards counts={counts} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar
          categories={Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <ExportMenu />
      </div>

      <SecurityFindings findings={visible} />
    </div>
  );
}
