import { db } from "@/lib/db";
import { riskCardRuns, riskHypotheses } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import { getCurrentTenant } from "@/lib/nbfc/tenant";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const tenant = await getCurrentTenant();
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
    .where(eq(riskCardRuns.tenant_id, tenant.id))
    .orderBy(desc(riskCardRuns.run_at))
    .limit(200);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Audit</h1>
        <p className="text-sm text-slate-500 mt-1">
          History of card runs for {tenant.display_name}. Newest first.
        </p>
      </div>

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
