import Link from "next/link";
import { requireRole } from "@/lib/auth-utils";
import { errorMessage } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES, ECOFY_ROLE_LABEL, ECOFY_STAGE_LABELS } from "@/lib/ecofy/access";
import { ecofyCounts, ecofyLoadByAssignee, ecofyStageCounts, listEcofyLeads } from "@/lib/ecofy/queries";
import { readDashboards } from "@/lib/ecofy/service";
import { formatQueueAge, StageBadge, TemperatureBadge } from "@/components/ecofy/badges";

export const dynamic = "force-dynamic";

type Ageing = { cases: Array<{ id: string; caseNo: string; stage: string; inStageWorkingHours: number; band: string }> };

// E-307 — Sales Head's Ecofy dashboard: pipeline by stage, the pickup queue,
// load per ASM / ISR, and Ecofy's own ageing view.
export default async function EcofyDashboardPage() {
    const user = await requireRole([...ECOFY_MANAGER_ROLES]);
    const [counts, stages, load, queue] = await Promise.all([
        ecofyCounts(user),
        ecofyStageCounts(),
        ecofyLoadByAssignee(),
        listEcofyLeads({ view: "queue" }),
    ]);
    let ecofy: { ageing: Ageing } | null = null;
    let ecofyError: string | null = null;
    try {
        const d = await readDashboards();
        ecofy = { ageing: d.ageing as Ageing };
    } catch (err) {
        ecofyError = errorMessage(err);
    }
    const byStage = new Map(stages.map((s) => [s.stage ?? "—", s.n]));
    const max = Math.max(1, ...stages.map((s) => s.n));

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Ecofy — Dashboard</h1>
                <p className="mt-1 text-sm text-gray-600">
                    Leads handed over by Ecofy and worked by your ASMs and ISRs. Credit, sanction and disbursement stay with the financier; installation with the EPC partner.
                </p>
            </header>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Kpi label="Open Ecofy leads" value={counts.open} href="/sales-head/ecofy/leads" />
                <Kpi label="Waiting in pickup queue" value={counts.queue} sub={counts.queueHot ? `${counts.queueHot} hot` : undefined} href="/sales-head/ecofy/queue" alert={counts.queueHot > 0} />
                <Kpi label="Follow-ups due now" value={counts.followUpsDue} alert={counts.followUpsDue > 0} />
                <Kpi label="Meetings today" value={counts.meetingsToday} />
            </div>

            <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
                <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                    <h2 className="mb-3 text-sm font-semibold text-gray-900">Pipeline — leads by stage</h2>
                    <div className="space-y-2">
                        {Object.keys(ECOFY_STAGE_LABELS).map((st) => {
                            const n = byStage.get(st) ?? 0;
                            return (
                                <Link key={st} href={`/sales-head/ecofy/leads?view=all&stage=${st}`} className="grid grid-cols-[170px_1fr_40px] items-center gap-2 text-sm hover:opacity-80">
                                    <span className="text-gray-700">
                                        {st} · {ECOFY_STAGE_LABELS[st]}
                                    </span>
                                    <span className="h-3 rounded bg-gray-100">
                                        <span className="block h-3 rounded bg-sky-500" style={{ width: `${Math.round((n / max) * 100)}%` }} />
                                    </span>
                                    <span className="text-right font-medium text-gray-900">{n}</span>
                                </Link>
                            );
                        })}
                    </div>
                </section>

                <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                    <h2 className="mb-3 text-sm font-semibold text-gray-900">Load per ASM / ISR (open leads)</h2>
                    {load.length === 0 ? (
                        <p className="text-sm text-gray-500">Nothing assigned yet.</p>
                    ) : (
                        <table className="min-w-full text-sm">
                            <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                                <tr>
                                    <th className="py-1">Owner</th>
                                    <th className="py-1 text-right">Open</th>
                                    <th className="py-1 text-right">Hot</th>
                                    <th className="py-1 text-right">Follow-ups due</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {load.map((r) => (
                                    <tr key={r.user_id}>
                                        <td className="py-1.5">
                                            <Link href={`/sales-head/ecofy/leads?assignee=${r.user_id}`} className="text-blue-700 hover:underline">
                                                {r.name ?? "—"}
                                            </Link>
                                            <span className="ml-1 text-xs text-gray-500">{ECOFY_ROLE_LABEL[r.role ?? ""] ?? r.role}</span>
                                        </td>
                                        <td className="py-1.5 text-right">{r.open}</td>
                                        <td className="py-1.5 text-right">{r.hot}</td>
                                        <td className={`py-1.5 text-right ${r.followUpsDue ? "font-medium text-red-700" : ""}`}>{r.followUpsDue}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </section>
            </div>

            <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-gray-900">Pickup queue — oldest first</h2>
                    <Link href="/sales-head/ecofy/queue" className="text-sm text-blue-700 hover:underline">
                        Assign leads →
                    </Link>
                </div>
                {queue.length === 0 ? (
                    <p className="text-sm text-gray-500">Nothing waiting.</p>
                ) : (
                    <ul className="divide-y divide-gray-100">
                        {queue.slice(0, 8).map((l) => (
                            <li key={l.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                                <Link href={`/sales-head/ecofy/leads/${l.id}`} className="font-medium text-blue-700 hover:underline">
                                    {l.case_no ?? l.id.slice(0, 8)}
                                </Link>
                                <span className="text-gray-900">{l.customer_name}</span>
                                <TemperatureBadge value={l.temperature} />
                                <span className="text-gray-500">{l.city}</span>
                                <span className="ml-auto text-gray-600">waiting {formatQueueAge(l.queue_entered_at)}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <h2 className="mb-3 text-sm font-semibold text-gray-900">Ageing in Ecofy — longest in stage (working hours)</h2>
                {ecofyError ? (
                    <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Ecofy could not be reached: {ecofyError}</p>
                ) : (
                    <table className="min-w-full text-sm">
                        <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="py-1">Case</th>
                                <th className="py-1">Stage</th>
                                <th className="py-1 text-right">In stage</th>
                                <th className="py-1 text-right">Band</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {(ecofy?.ageing.cases ?? []).slice(0, 12).map((c) => (
                                <tr key={c.id}>
                                    <td className="py-1.5 font-medium">{c.caseNo}</td>
                                    <td className="py-1.5">
                                        <StageBadge value={c.stage} />
                                    </td>
                                    <td className="py-1.5 text-right">{c.inStageWorkingHours} wh</td>
                                    <td className="py-1.5 text-right">{c.band}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    );
}

function Kpi({ label, value, sub, href, alert }: { label: string; value: number; sub?: string; href?: string; alert?: boolean }) {
    const body = (
        <div className={`rounded-xl border p-4 shadow-sm ${alert ? "border-red-200 bg-red-50" : "border-gray-200 bg-white"}`}>
            <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
            <div className={`mt-1 text-2xl font-semibold ${alert ? "text-red-700" : "text-gray-900"}`}>{value}</div>
            {sub ? <div className="text-xs text-gray-600">{sub}</div> : null}
        </div>
    );
    return href ? (
        <Link href={href} className="hover:opacity-90">
            {body}
        </Link>
    ) : (
        body
    );
}
