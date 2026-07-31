/**
 * History tab — every finding that has been closed out, with the full story of
 * HOW it was resolved: the resolution method (AI auto-apply vs manual triage),
 * the code diff that was written, who did it, when, and the IP the action came
 * from. Backed by the append-only security_finding_actions trail (E-219) plus
 * the resolution_* columns on the finding (E-218/E-219).
 *
 * Reopened findings deliberately keep their history rows, so a finding that was
 * resolved and later reopened still shows its past resolutions here.
 */
import { redirect } from "next/navigation";
import { asc, desc, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityFindings, securityFindingActions } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import type { Severity } from "@/lib/security/severity";
import type { SecurityCategory } from "@/lib/security/types";
import SecurityNavTabs from "../_components/SecurityNavTabs";
import ResolutionHistory, {
  type ResolvedFindingForUi,
  type FindingActionForUi,
} from "../_components/ResolutionHistory";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["it"]);
const CLOSED_STATUSES = ["resolved", "false_positive"];

async function load() {
  // Findings that are currently closed out…
  const closed = await db
    .select()
    .from(securityFindings)
    .where(inArray(securityFindings.status, CLOSED_STATUSES))
    .orderBy(desc(sql`coalesce(${securityFindings.resolved_at}, ${securityFindings.created_at})`));

  // …plus any finding that was resolved in the past and later reopened — it has
  // audit rows even though its status is no longer closed.
  const reopenedRows = await db
    .selectDistinct({ finding_id: securityFindingActions.finding_id })
    .from(securityFindingActions)
    .where(inArray(securityFindingActions.action, ["resolved", "false_positive", "auto_apply"]));

  const closedIds = new Set(closed.map((f) => f.id));
  const extraIds = reopenedRows.map((r) => r.finding_id).filter((fid) => !closedIds.has(fid));

  const reopened = extraIds.length
    ? await db
        .select()
        .from(securityFindings)
        .where(inArray(securityFindings.id, extraIds))
        .orderBy(desc(securityFindings.created_at))
    : [];

  const rows = [...closed, ...reopened];
  const ids = rows.map((r) => r.id);

  const actionRows = ids.length
    ? await db
        .select()
        .from(securityFindingActions)
        .where(inArray(securityFindingActions.finding_id, ids))
        .orderBy(asc(securityFindingActions.created_at))
    : [];

  const actionsByFinding = new Map<string, FindingActionForUi[]>();
  for (const a of actionRows) {
    const list = actionsByFinding.get(a.finding_id) ?? [];
    list.push({
      id: a.id,
      action: a.action,
      method: a.method,
      actor_email: a.actor_email,
      actor_role: a.actor_role,
      ip: a.ip,
      user_agent: a.user_agent,
      summary: a.summary,
      detail: a.detail as Record<string, unknown> | null,
      created_at: a.created_at?.toISOString() ?? null,
    });
    actionsByFinding.set(a.finding_id, list);
  }

  const findings: ResolvedFindingForUi[] = rows.map((r) => {
    const report = (r.resolution_report ?? null) as Record<string, unknown> | null;
    const reportIp = typeof report?.resolved_from_ip === "string" ? report.resolved_from_ip : null;
    const reportBy = typeof report?.applied_by === "string" ? report.applied_by : null;
    const reportResolvedBy = typeof report?.resolved_by === "string" ? report.resolved_by : null;
    return {
      id: r.id,
      check_slug: r.check_slug,
      category: r.category as SecurityCategory,
      severity: r.severity as Severity,
      title: r.title,
      summary: r.summary,
      target_url: r.target_url,
      http_method: r.http_method,
      reproduction: r.reproduction,
      remediation: r.remediation,
      evidence_json: r.evidence_json as Record<string, unknown> | null,
      owasp_ref: r.owasp_ref,
      cwe_ref: r.cwe_ref,
      confidence: r.confidence,
      status: r.status,
      created_at: r.created_at?.toISOString() ?? null,
      resolved_at: r.resolved_at?.toISOString() ?? null,
      resolution_method: r.resolution_method,
      resolution_summary: r.resolution_summary,
      resolution_report: report,
      // Fall back to the report for rows resolved before E-219 added the columns.
      resolved_by_email: r.resolved_by_email ?? reportBy ?? reportResolvedBy,
      resolved_ip: r.resolved_ip ?? reportIp,
      resolved_user_agent: r.resolved_user_agent,
      actions: actionsByFinding.get(r.id) ?? [],
    };
  });

  const counts = {
    total: findings.length,
    auto: findings.filter((f) => f.resolution_method === "auto_apply").length,
    manual: findings.filter((f) => f.resolution_method === "manual").length,
    falsePositive: findings.filter((f) => f.status === "false_positive").length,
    reopened: findings.filter((f) => !CLOSED_STATUSES.includes(f.status)).length,
    ips: new Set(findings.map((f) => f.resolved_ip).filter(Boolean)).size,
  };

  return { findings, counts };
}

export default async function SecurityHistoryPage() {
  const user = await requireAuth();
  // Wrong role → bounce to "/", which middleware forwards to that role’s own
  // dashboard. Sending them to /login instead would read as a forced logout.
  if (!ALLOWED_ROLES.has(user.role)) redirect("/");

  const { findings, counts } = await load();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Security Risk</h1>
        <p className="text-sm text-slate-500 mt-1">
          Resolution history — every finding that has been closed out, how it was resolved (AI
          auto-apply or manual triage), by whom, when, and from which IP. {counts.total} record
          {counts.total === 1 ? "" : "s"}.
        </p>
      </div>

      <SecurityNavTabs />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="Resolved records" value={counts.total} tone="slate" />
        <StatCard label="AI auto-applied" value={counts.auto} tone="emerald" />
        <StatCard label="Manually resolved" value={counts.manual} tone="sky" />
        <StatCard label="False positives" value={counts.falsePositive} tone="amber" />
        <StatCard label="Distinct origin IPs" value={counts.ips} tone="slate" />
      </div>

      <ResolutionHistory findings={findings} />
    </div>
  );
}

const TONES: Record<string, string> = {
  slate: "text-slate-900 dark:text-slate-100",
  emerald: "text-emerald-600 dark:text-emerald-400",
  sky: "text-sky-600 dark:text-sky-400",
  amber: "text-amber-600 dark:text-amber-400",
};

function StatCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-4">
      <div className={`text-2xl font-semibold ${TONES[tone] ?? TONES.slate}`}>{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
    </div>
  );
}
