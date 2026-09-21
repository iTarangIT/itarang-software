"use client";

// Reporting Review sheet 6 — the CEO one-screen view, rows in a fixed order:
// exceptions first, then money, engine, base and people. Row 6 (trust) is the
// DataHealthPanel rendered right after this. Every figure is for the window
// chosen in the CEO filter bar and, where it has one, is compared with the
// previous period of the same length.

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Loader2 } from "lucide-react";

import type { ControlTower, Compare } from "@/lib/dashboard/ceoControlTower";
import { ACCOUNT_BUCKETS, ACCOUNT_BUCKET_LABELS } from "@/lib/dealers/accountHealthRules";

const inr = (n: number) =>
    n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(2)} L` : `₹${Math.round(n).toLocaleString("en-IN")}`;
const num = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 1 });

function Delta({ c, money = false }: { c: Compare; money?: boolean }) {
    if (c.prev == null) return null;
    const diff = c.now - c.prev;
    if (diff === 0) return <span className="text-[11px] text-gray-400">same as previous period</span>;
    const up = diff > 0;
    const Icon = up ? ArrowUpRight : ArrowDownRight;
    return (
        <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${up ? "text-emerald-700" : "text-rose-700"}`}>
            <Icon className="h-3 w-3" />
            {money ? inr(Math.abs(diff)) : num(Math.abs(diff))} vs previous ({money ? inr(c.prev) : num(c.prev)})
        </span>
    );
}

function Row({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
    return (
        <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
            <h3 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-gray-500">
                {n} · {title}
            </h3>
            {children}
        </section>
    );
}

function Stat({ label, value, sub, href }: { label: string; value: string; sub?: React.ReactNode; href?: string }) {
    const body = (
        <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 h-full">
            <p className="text-[11px] font-medium text-gray-600">{label}</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-gray-900">{value}</p>
            {sub && <div className="mt-0.5">{sub}</div>}
        </div>
    );
    return href ? (
        <Link href={href} className="block hover:opacity-90">
            {body}
        </Link>
    ) : (
        body
    );
}

function Exception({ label, count, href, extra }: { label: string; count: number | null; href?: string; extra?: string }) {
    const tone =
        count == null ? "border-gray-200 bg-gray-50 text-gray-500" : count === 0 ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800";
    const body = (
        <div className={`rounded-xl border px-3 py-2 ${tone}`}>
            <p className="text-[11px] font-medium">{label}</p>
            <p className="text-lg font-bold tabular-nums">{count == null ? "—" : num(count)}</p>
            {extra && <p className="text-[11px]">{extra}</p>}
        </div>
    );
    return href ? <Link href={href}>{body}</Link> : body;
}

export function CeoControlTower({ windowQs }: { windowQs: string }) {
    const { data, isLoading, error } = useQuery<ControlTower & { label: string }>({
        queryKey: ["ceo-control-tower", windowQs],
        queryFn: async () => {
            const res = await fetch(`/api/dashboard/ceo/control-tower?${windowQs}`, { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load the control tower");
            return json.data;
        },
        placeholderData: (prev) => prev,
        staleTime: 60_000,
    });

    if (isLoading && !data) {
        return (
            <div className="flex items-center gap-2 rounded-2xl border border-gray-100 bg-white p-5 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Building the one-screen view…
            </div>
        );
    }
    if (error || !data) {
        return <p className="rounded-2xl border border-rose-100 bg-rose-50 p-4 text-sm text-rose-700">{(error as Error)?.message}</p>;
    }
    const unavailable = <p className="text-xs text-gray-400">Could not be computed on this environment.</p>;
    const { exceptions: x, money: m, engine: e, base: b, people: p } = data;

    return (
        <div className="space-y-4" data-testid="ceo-control-tower">
            <Row n={1} title="Needs your attention">
                {x ? (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                        <Exception label="Quotes waiting for your approval" count={x.quotes_pending} />
                        <Exception label="Leads unassigned over 7 days" count={x.unassigned_over_7d} href="/leads" />
                        <Exception label="Leads idle over 7 working days" count={x.idle_over_7d} href="/admin/reports/needs-attention" />
                        <Exception
                            label="Dealers in Red / Dormant"
                            count={x.red_dormant_dealers}
                            href="/admin/reports/dealer-health"
                            extra={x.red_dormant_dealers ? `${inr(x.at_risk_90d)} at risk (90 d)` : undefined}
                        />
                        <Exception
                            label="SPOCs below 80% of target"
                            count={x.spocs_below_80}
                            href="/admin/targets"
                            extra={x.spocs_below_80 == null ? "targets not set up" : undefined}
                        />
                        <Exception label="Orders claimed, no invoice" count={null} extra="not tracked — no order record" />
                    </div>
                ) : (
                    unavailable
                )}
            </Row>

            <Row n={2} title={`Money · ${data.label}`}>
                {m ? (
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
                        <Stat label="Revenue" value={inr(m.revenue.now)} sub={<Delta c={m.revenue} money />} href="/ceo/invoices" />
                        <div className="rounded-xl border border-gray-100 p-3">
                            <p className="text-[11px] font-medium text-gray-600">By business type</p>
                            {m.by_type.length === 0 ? (
                                <p className="mt-1 text-xs text-gray-400">No invoice is linked to a dealer yet.</p>
                            ) : (
                                m.by_type.map((t) => (
                                    <p key={t.type} className="flex justify-between text-xs tabular-nums"><span>{t.type}</span><span>{inr(t.revenue)}</span></p>
                                ))
                            )}
                            {m.unlinked_revenue > 0 && (
                                <Link href="/ceo/invoices" className="mt-1 block text-[11px] font-semibold text-amber-700 hover:underline">
                                    {inr(m.unlinked_revenue)} not linked to any dealer →
                                </Link>
                            )}
                        </div>
                        <div className="rounded-xl border border-gray-100 p-3">
                            <p className="text-[11px] font-medium text-gray-600">By SPOC</p>
                            {m.by_spoc.length === 0 ? <p className="mt-1 text-xs text-gray-400">Needs dealer GSTINs to attribute.</p> : m.by_spoc.map((s) => (
                                <p key={s.name} className="flex justify-between text-xs tabular-nums"><span>{s.name}</span><span>{inr(s.revenue)}</span></p>
                            ))}
                        </div>
                        <div className="rounded-xl border border-gray-100 p-3">
                            <p className="text-[11px] font-medium text-gray-600">By city</p>
                            {m.by_city.length === 0 ? <p className="mt-1 text-xs text-gray-400">Needs dealer GSTINs to attribute.</p> : m.by_city.map((c) => (
                                <p key={c.city} className="flex justify-between text-xs tabular-nums"><span>{c.city}</span><span>{inr(c.revenue)}</span></p>
                            ))}
                        </div>
                    </div>
                ) : (
                    unavailable
                )}
            </Row>

            <Row n={3} title="Engine">
                {e ? (
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                        <Stat label="Leads in" value={num(e.leads_in.now)} sub={<Delta c={e.leads_in} />} />
                        <Stat label="Converted" value={num(e.converted.now)} sub={<Delta c={e.converted} />} />
                        <Stat label="First orders" value={num(e.first_orders.now)} sub={<Delta c={e.first_orders} />} href="/admin/reports/dealer-health" />
                        <Stat
                            label={e.headline.label}
                            value={e.headline.value == null ? "—" : `${(e.headline.value * 100).toFixed(1)}%`}
                        />
                        <div className="rounded-xl border border-gray-100 p-3">
                            <p className="text-[11px] font-medium text-gray-600">AI calling (this period)</p>
                            <p className="text-xs tabular-nums">Leads called: {num(e.ai.leads_called)}</p>
                            <p className="text-xs tabular-nums">Connect: {e.ai.connect_pct == null ? "—" : `${e.ai.connect_pct}%`}</p>
                            <p className="text-xs tabular-nums">AI qualified: {num(e.ai.ai_qualified)}</p>
                            <p className="text-xs tabular-nums">…then converted: {num(e.ai.ai_qualified_converted)}</p>
                        </div>
                    </div>
                ) : (
                    unavailable
                )}
            </Row>

            <Row n={4} title="Base">
                {b ? (
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                        <Link href="/admin/reports/dealer-health" className="rounded-xl border border-gray-100 p-3 hover:bg-gray-50">
                            <p className="text-[11px] font-medium text-gray-600">Dealer account health</p>
                            {ACCOUNT_BUCKETS.map((k) => (
                                <p key={k} className="flex justify-between text-xs tabular-nums">
                                    <span>{ACCOUNT_BUCKET_LABELS[k].split(" (")[0]}</span>
                                    <span>{num(b.dealers[k] ?? 0)}</span>
                                </p>
                            ))}
                        </Link>
                        <Link href="/admin/reports" className="rounded-xl border border-gray-100 p-3 hover:bg-gray-50">
                            <p className="text-[11px] font-medium text-gray-600">Finance funnel</p>
                            <p className="mt-1 text-xs text-gray-500">Dealers onboarded, KYC files, disbursed and rejected — on the Reports page, Funnel tab.</p>
                        </Link>
                        <div className="rounded-xl border border-gray-100 p-3">
                            <p className="text-[11px] font-medium text-gray-600">Buyback</p>
                            <p className="text-xs tabular-nums">Kg sourced: {num(b.buyback.kg.now)}</p>
                            <Delta c={b.buyback.kg} />
                            <p className="text-xs tabular-nums">Paid to dealers: {inr(b.buyback.paid)}</p>
                            <p className="text-xs tabular-nums">₹ per kg: {b.buyback.per_kg == null ? "—" : inr(b.buyback.per_kg)}</p>
                            <p className="text-xs tabular-nums">
                                Margin: {b.buyback.margin == null ? "— (no recycler sale booked)" : inr(b.buyback.margin)}
                            </p>
                        </div>
                    </div>
                ) : (
                    unavailable
                )}
            </Row>

            <Row n={5} title={p?.basis === "target" ? "SPOC league — by % of target" : "SPOC league — by conversions (no targets set)"}>
                {p ? (
                    p.rows.length === 0 ? (
                        <p className="text-xs text-gray-400">No SPOC activity in this period.</p>
                    ) : (
                        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                            {[
                                { t: "Top 5", list: p.rows.slice(0, 5) },
                                { t: "Bottom 5", list: p.rows.length > 5 ? p.rows.slice(-5).reverse() : [] },
                            ].map(({ t, list }) =>
                                list.length === 0 ? null : (
                                    <div key={t}>
                                        <p className="mb-1 text-[11px] font-semibold text-gray-600">{t}</p>
                                        <table className="w-full text-xs">
                                            <thead className="text-gray-400">
                                                <tr>
                                                    <th className="text-left font-medium">SPOC</th>
                                                    <th className="text-right font-medium">% target</th>
                                                    <th className="text-right font-medium">Converted</th>
                                                    <th className="text-right font-medium">Revenue</th>
                                                    <th className="text-right font-medium">Idle</th>
                                                    <th className="text-right font-medium">Engaged %</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {list.map((r) => (
                                                    <tr key={r.spoc_id} className="border-t border-gray-50">
                                                        <td className="py-1">{r.name}</td>
                                                        <td className="text-right tabular-nums">{r.pct_of_target == null ? "—" : `${r.pct_of_target}%`}</td>
                                                        <td className="text-right tabular-nums">{r.converted}</td>
                                                        <td className="text-right tabular-nums">{inr(r.revenue)}</td>
                                                        <td className={`text-right tabular-nums ${r.idle_leads > 50 ? "font-semibold text-rose-700" : ""}`}>{num(r.idle_leads)}</td>
                                                        <td className="text-right tabular-nums">{r.engaged_pct == null ? "—" : `${r.engaged_pct}%`}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                ),
                            )}
                        </div>
                    )
                ) : (
                    unavailable
                )}
            </Row>

            {x && x.idle_over_7d > 0 && (
                <p className="flex items-center gap-1.5 text-[11px] text-gray-500">
                    <AlertTriangle className="h-3 w-3" />
                    Row 6 (trust) is the Data health panel below — until it reads near 0 %, the figures above are under-counted.
                </p>
            )}
        </div>
    );
}
