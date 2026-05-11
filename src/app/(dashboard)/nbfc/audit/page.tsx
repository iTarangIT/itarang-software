/**
 * /nbfc/audit — Audit Log (BRD §6.4.4)
 *
 * Two tabs:
 *   - "risk" (default): risk_card_runs history (existing behaviour)
 *   - "actions": nbfc_audit_log + nbfc_borrower_actions stream — every NBFC
 *     privileged action (immobilisation request/approve/reject/remobilise,
 *     flag-for-recovery, payment reminders, etc.) tenant-scoped.
 *
 * Filters per BRD §6.4: from / to / action_type / status / entity_id.
 */
import Link from "next/link";
import { db } from "@/lib/db";
import { and, desc, eq, gte, ilike, lte } from "drizzle-orm";
import {
  riskCardRuns,
  riskHypotheses,
  nbfcAuditLog,
  users as usersTable,
} from "@/lib/db/schema";
import { getCurrentTenant } from "@/lib/nbfc/tenant";

export const dynamic = "force-dynamic";

interface SearchParams {
  tab?: "risk" | "actions" | string;
  from?: string;
  to?: string;
  action?: string;
  entity?: string;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const tenant = await getCurrentTenant();
  const params = (await searchParams) ?? {};
  const tab = params.tab === "actions" ? "actions" : "risk";

  if (tab === "actions") {
    return <ActionsTab tenantId={tenant.id} tenantName={tenant.display_name} params={params} />;
  }
  return <RiskTab tenantId={tenant.id} tenantName={tenant.display_name} params={params} />;
}

function TabBar({ active, params }: { active: "risk" | "actions"; params: SearchParams }) {
  const carry = (() => {
    const next = new URLSearchParams();
    for (const k of ["from", "to", "action", "entity"] as const) {
      const v = params[k];
      if (v) next.set(k, String(v));
    }
    return next.toString();
  })();
  return (
    <div className="flex gap-2 border-b border-slate-200 dark:border-slate-800">
      {(["risk", "actions"] as const).map((t) => (
        <Link
          key={t}
          href={`/nbfc/audit?tab=${t}${carry ? `&${carry}` : ""}`}
          className={`px-4 py-2 text-xs font-bold uppercase tracking-widest border-b-2 -mb-px ${
            active === t
              ? "border-[color:var(--color-brand-navy)] text-[color:var(--color-brand-navy)]"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
        >
          {t === "risk" ? "Risk runs" : "Borrower actions"}
        </Link>
      ))}
    </div>
  );
}

async function RiskTab({
  tenantId,
  tenantName,
  params,
}: {
  tenantId: string;
  tenantName: string;
  params: SearchParams;
}) {
  const rows = await db
    .select({
      id: riskCardRuns.id,
      run_at: riskCardRuns.run_at,
      severity: riskCardRuns.severity,
      finding_summary: riskCardRuns.finding_summary,
      affected_count: riskCardRuns.affected_count,
      total_count: riskCardRuns.total_count,
      llm_model: riskCardRuns.llm_model,
      hyp_title: riskHypotheses.title,
      hyp_slug: riskHypotheses.slug,
    })
    .from(riskCardRuns)
    .leftJoin(riskHypotheses, eq(riskCardRuns.hypothesis_id, riskHypotheses.id))
    .where(eq(riskCardRuns.tenant_id, tenantId))
    .orderBy(desc(riskCardRuns.run_at))
    .limit(200);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Audit</h1>
        <p className="text-sm text-slate-500 mt-1">
          History for {tenantName}. Newest first.
        </p>
      </header>
      <TabBar active="risk" params={params} />
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900 text-xs text-slate-500 uppercase">
            <tr>
              <th className="px-4 py-3 text-left font-medium">When</th>
              <th className="px-4 py-3 text-left font-medium">Hypothesis</th>
              <th className="px-4 py-3 text-left font-medium">Severity</th>
              <th className="px-4 py-3 text-right font-medium">Affected</th>
              <th className="px-4 py-3 text-left font-medium">Finding</th>
              <th className="px-4 py-3 text-left font-medium">Model</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  No runs yet. Visit Risk and click &quot;Re-run analysis&quot;.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2 tabular-nums text-slate-500">
                    {r.run_at?.toLocaleString() ?? "—"}
                  </td>
                  <td className="px-4 py-2">
                    <div className="font-medium">{r.hyp_title ?? r.hyp_slug ?? "?"}</div>
                  </td>
                  <td className="px-4 py-2">
                    <SevPill sev={r.severity} />
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {r.affected_count}/{r.total_count}
                  </td>
                  <td className="px-4 py-2 text-slate-600 dark:text-slate-400">
                    {r.finding_summary}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{r.llm_model ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

async function ActionsTab({
  tenantId,
  tenantName,
  params,
}: {
  tenantId: string;
  tenantName: string;
  params: SearchParams;
}) {
  const conditions = [eq(nbfcAuditLog.tenant_id, tenantId)];
  if (params.from) conditions.push(gte(nbfcAuditLog.created_at, new Date(params.from)));
  if (params.to) conditions.push(lte(nbfcAuditLog.created_at, new Date(`${params.to}T23:59:59`)));
  if (params.action) conditions.push(ilike(nbfcAuditLog.action_type, `%${params.action}%`));

  const auditRows = await db
    .select({
      id: nbfcAuditLog.id,
      created_at: nbfcAuditLog.created_at,
      action_type: nbfcAuditLog.action_type,
      action_id: nbfcAuditLog.action_id,
      before_state: nbfcAuditLog.before_state,
      after_state: nbfcAuditLog.after_state,
      user_id: nbfcAuditLog.user_id,
      user_email: usersTable.email,
      user_name: usersTable.name,
    })
    .from(nbfcAuditLog)
    .leftJoin(usersTable, eq(usersTable.id, nbfcAuditLog.user_id))
    .where(and(...conditions))
    .orderBy(desc(nbfcAuditLog.created_at))
    .limit(300);

  // Filter by entity_id (action_id) JS-side because it's optional.
  const entityFilter = params.entity?.trim();
  const filtered = entityFilter
    ? auditRows.filter((r) => (r.action_id ?? "").includes(entityFilter))
    : auditRows;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Audit</h1>
        <p className="text-sm text-slate-500 mt-1">
          Borrower actions for {tenantName}.
        </p>
      </header>

      <TabBar active="actions" params={params} />

      <form className="flex flex-wrap items-end gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
        <input type="hidden" name="tab" value="actions" />
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">From</label>
          <input type="date" name="from" defaultValue={params.from ?? ""} className="border rounded px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">To</label>
          <input type="date" name="to" defaultValue={params.to ?? ""} className="border rounded px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Action contains</label>
          <input type="text" name="action" defaultValue={params.action ?? ""} placeholder="immobilisation" className="border rounded px-2 py-1 text-sm" />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">Entity id contains</label>
          <input type="text" name="entity" defaultValue={params.entity ?? ""} className="border rounded px-2 py-1 text-sm w-full" />
        </div>
        <button type="submit" className="px-4 py-1.5 text-sm font-bold bg-[color:var(--color-brand-navy)] text-white rounded">
          Apply
        </button>
        {(params.from || params.to || params.action || params.entity) && (
          <Link href="/nbfc/audit?tab=actions" className="text-xs underline text-slate-500 self-center">
            Reset
          </Link>
        )}
      </form>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900 text-xs text-slate-500 uppercase">
            <tr>
              <th className="px-4 py-3 text-left font-medium">When</th>
              <th className="px-4 py-3 text-left font-medium">Action</th>
              <th className="px-4 py-3 text-left font-medium">Entity</th>
              <th className="px-4 py-3 text-left font-medium">By</th>
              <th className="px-4 py-3 text-left font-medium">Status change</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  No audit events match.
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const before = (r.before_state as Record<string, unknown> | null)?.status ?? "";
                const after = (r.after_state as Record<string, unknown> | null)?.status ?? "";
                return (
                  <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2 text-xs text-slate-500 tabular-nums">
                      {r.created_at?.toLocaleString() ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-xs uppercase font-bold">{r.action_type}</td>
                    <td className="px-4 py-2 font-mono text-xs">{r.action_id ?? "—"}</td>
                    <td className="px-4 py-2">
                      <div className="text-sm">{r.user_name ?? r.user_email ?? r.user_id}</div>
                      <div className="text-xs text-slate-500">{r.user_email ?? ""}</div>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600">
                      {before || after ? (
                        <span>
                          <code>{String(before || "—")}</code> → <code>{String(after || "—")}</code>
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SevPill({ sev }: { sev: string }) {
  const tone =
    sev === "high"
      ? "bg-red-50 text-red-600"
      : sev === "warn"
        ? "bg-amber-50 text-amber-600"
        : "bg-emerald-50 text-emerald-600";
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-semibold uppercase ${tone}`}>{sev}</span>
  );
}

