// What the CEO overview's "Batteries to dealers" card is made of, row by row,
// with the same rule as salesDashboard.ts queryOutcome's `batteries` CTE:
// battery invoice LINES (E-322) on non-void invoices matched to a dealer, dated
// in [from, to]; or, on a database without E-322, battery stock allocated to a
// dealer account in the period. The total at the top is the card's number.

import Link from "next/link";
import { sql } from "drizzle-orm";
import { ArrowLeft, FileText } from "lucide-react";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { matchedLinesUnion, REVENUE_NOT_VOID } from "@/lib/dashboard/revenueSource";

export const dynamic = "force-dynamic";

const IST = "Asia/Kolkata";

type LineRow = {
    id: string;
    source: string;
    invoice_number: string | null;
    invoice_date: string;
    document_url: string | null;
    item_name: string | null;
    quantity: number;
    dealer_lead_id: string | null;
    account_id: string | null;
    dealer_name: string | null;
    owner_name: string | null;
};

type StockRow = {
    id: string;
    allocated_on: string;
    serial_number: string | null;
    model_type: string | null;
    oem_name: string | null;
    account_id: string;
    dealer_name: string | null;
};

const SOURCE_LABEL: Record<string, string> = { zoho: "Zoho", drive: "Drive", credit: "Credit note" };

const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const fmtDate = (d: string) =>
    new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
    });
const num = (n: number) => n.toLocaleString("en-IN");

function DealerCell({ name, accountId, leadId }: { name: string | null; accountId: string | null; leadId: string | null }) {
    if (!name) return <span className="text-gray-500">—</span>;
    const href = accountId
        ? `/admin/accounts/${encodeURIComponent(accountId)}`
        : leadId
          ? `/leads/${encodeURIComponent(leadId)}`
          : null;
    return href ? (
        <Link href={href} className="text-gray-900 hover:text-brand-sky hover:underline">
            {name}
        </Link>
    ) : (
        <span className="text-gray-900">{name}</span>
    );
}

export default async function CeoBatteriesPage({
    searchParams,
}: {
    searchParams: Promise<{ from?: string; to?: string; label?: string }>;
}) {
    await requireRole(["ceo", "admin"]);
    const sp = await searchParams;

    const today = new Date().toLocaleDateString("en-CA", { timeZone: IST });
    let from = isDate(sp.from) ? sp.from : `${today.slice(0, 7)}-01`;
    let to = isDate(sp.to) ? sp.to : today;
    if (from > to) [from, to] = [to, from];
    const label = sp.label?.trim() || null;

    const lines = await matchedLinesUnion();

    let lineRows: LineRow[] = [];
    let stockRows: StockRow[] = [];
    if (lines) {
        lineRows = (
            (await db.execute(sql`
                SELECT r.id, r.source, r.invoice_number, r.invoice_date::text AS invoice_date, r.document_url,
                       r.item_name, COALESCE(r.quantity, 0) AS quantity,
                       r.dealer_lead_id, r.account_id, r.dealer_name, u.name AS owner_name
                  FROM ${lines} AS r
                  LEFT JOIN users u ON u.id::text = r.dealer_owner_id::text
                 WHERE r.product_class = 'battery'
                   AND ${REVENUE_NOT_VOID}
                   AND (r.account_id IS NOT NULL OR r.dealer_lead_id IS NOT NULL)
                   AND r.invoice_date >= ${from}::date
                   AND r.invoice_date <= ${to}::date
                 ORDER BY r.invoice_date DESC, r.invoice_number DESC
            `)) as unknown as Array<Record<string, unknown>>
        ).map((r) => ({ ...r, quantity: Number(r.quantity) }) as LineRow);
    } else {
        stockRows = (await db.execute(sql`
            SELECT i.id::text AS id,
                   (i.allocated_to_dealer_at AT TIME ZONE ${IST})::date::text AS allocated_on,
                   i.serial_number, i.model_type, i.oem_name,
                   a.id AS account_id, a.business_entity_name AS dealer_name
              FROM inventory i
              JOIN accounts a ON a.id = i.dealer_id
             WHERE i.asset_type = 'battery'
               AND i.allocated_to_dealer_at IS NOT NULL
               AND (i.allocated_to_dealer_at AT TIME ZONE ${IST})::date >= ${from}::date
               AND (i.allocated_to_dealer_at AT TIME ZONE ${IST})::date <= ${to}::date
             ORDER BY i.allocated_to_dealer_at DESC
        `)) as unknown as StockRow[];
    }

    const total = lines ? lineRows.reduce((a, r) => a + r.quantity, 0) : stockRows.length;

    // By dealer, biggest first — the question the card usually raises.
    const byDealer = new Map<string, { name: string; accountId: string | null; leadId: string | null; n: number }>();
    if (lines) {
        for (const r of lineRows) {
            const key = r.account_id ?? r.dealer_lead_id ?? r.dealer_name ?? "?";
            const d = byDealer.get(key) ?? { name: r.dealer_name ?? "(unnamed)", accountId: r.account_id, leadId: r.dealer_lead_id, n: 0 };
            d.n += r.quantity;
            byDealer.set(key, d);
        }
    } else {
        for (const r of stockRows) {
            const d = byDealer.get(r.account_id) ?? { name: r.dealer_name ?? r.account_id, accountId: r.account_id, leadId: null, n: 0 };
            d.n += 1;
            byDealer.set(r.account_id, d);
        }
    }
    const dealers = [...byDealer.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    const invoiceCount = new Set(lineRows.map((r) => `${r.source}:${r.id}`)).size;

    return (
        <div className="space-y-6 pb-12">
            <div>
                <Link href="/ceo" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-sky hover:underline">
                    <ArrowLeft className="h-3.5 w-3.5" /> CEO overview
                </Link>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-brand-navy">Batteries to dealers</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    {label ? `${label} · ` : ""}
                    {fmtDate(from)} – {fmtDate(to)}.{" "}
                    {lines
                        ? "Battery lines on non-void invoices matched to a dealer, dated in the period. Credit notes subtract."
                        : "Batteries allocated to a dealer account in the period. Invoice lines are not set up on this database, so stock allocation is used instead."}
                </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                    { k: "Batteries", v: num(total), s: lines ? `${invoiceCount} invoice${invoiceCount === 1 ? "" : "s"}` : `${stockRows.length} units` },
                    { k: "Dealers", v: num(dealers.length), s: "Received at least one" },
                    {
                        k: "Top dealer",
                        v: dealers[0] ? num(dealers[0].n) : "—",
                        s: dealers[0]?.name ?? "No batteries in this period",
                    },
                ].map((t) => (
                    <div key={t.k} className="rounded-xl border border-gray-200 bg-white p-4">
                        <p className="text-xs font-semibold text-gray-500">{t.k}</p>
                        <p className="mt-1 text-xl font-bold text-brand-navy">{t.v}</p>
                        <p className="truncate text-xs text-gray-500">{t.s}</p>
                    </div>
                ))}
            </div>

            {total === 0 && dealers.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">
                    No batteries went to dealers in this period.
                </p>
            ) : (
                <>
                    <section className="space-y-2">
                        <h2 className="text-sm font-semibold text-gray-900">By dealer</h2>
                        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                            <table className="min-w-full text-sm">
                                <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                                    <tr>
                                        <th className="px-4 py-3">Dealer</th>
                                        <th className="px-4 py-3 text-right">Batteries</th>
                                        <th className="px-4 py-3 text-right">Share</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                    {dealers.map((d) => (
                                        <tr key={`${d.accountId ?? ""}:${d.leadId ?? ""}:${d.name}`}>
                                            <td className="px-4 py-3">
                                                <DealerCell name={d.name} accountId={d.accountId} leadId={d.leadId} />
                                            </td>
                                            <td className="px-4 py-3 text-right font-semibold tabular-nums text-gray-900">{num(d.n)}</td>
                                            <td className="px-4 py-3 text-right tabular-nums text-gray-600">
                                                {total ? `${Math.round((d.n / total) * 100)}%` : "—"}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <section className="space-y-2">
                        <h2 className="text-sm font-semibold text-gray-900">{lines ? "Invoice lines" : "Units allocated"}</h2>
                        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                            {lines ? (
                                <table className="min-w-full text-sm">
                                    <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                                        <tr>
                                            <th className="px-4 py-3">Date</th>
                                            <th className="px-4 py-3">Invoice</th>
                                            <th className="px-4 py-3">Item</th>
                                            <th className="px-4 py-3">Dealer</th>
                                            <th className="px-4 py-3">Owner</th>
                                            <th className="px-4 py-3 text-right">Qty</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                        {lineRows.map((r, i) => (
                                            <tr key={`${r.source}:${r.id}:${i}`} className="align-top">
                                                <td className="whitespace-nowrap px-4 py-3 text-gray-700">{fmtDate(r.invoice_date)}</td>
                                                <td className="whitespace-nowrap px-4 py-3">
                                                    {r.document_url ? (
                                                        <a
                                                            href={r.document_url}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="inline-flex items-center gap-1 font-medium text-brand-sky hover:underline"
                                                        >
                                                            <FileText className="h-3.5 w-3.5" />
                                                            {r.invoice_number ?? "(no number)"}
                                                        </a>
                                                    ) : (
                                                        <span className="font-medium text-gray-900">{r.invoice_number ?? "(no number)"}</span>
                                                    )}
                                                    <span className="block text-xs text-gray-500">{SOURCE_LABEL[r.source] ?? r.source}</span>
                                                </td>
                                                <td className="px-4 py-3 text-gray-800">{r.item_name ?? "—"}</td>
                                                <td className="px-4 py-3">
                                                    <DealerCell name={r.dealer_name} accountId={r.account_id} leadId={r.dealer_lead_id} />
                                                </td>
                                                <td className="px-4 py-3 text-gray-700">{r.owner_name ?? "—"}</td>
                                                <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums text-gray-900">
                                                    {num(r.quantity)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                    <tfoot className="bg-gray-50 text-sm font-semibold">
                                        <tr>
                                            <td className="px-4 py-3" colSpan={5}>
                                                Total ({lineRows.length} line{lineRows.length === 1 ? "" : "s"})
                                            </td>
                                            <td className="px-4 py-3 text-right text-brand-navy">{num(total)}</td>
                                        </tr>
                                    </tfoot>
                                </table>
                            ) : (
                                <table className="min-w-full text-sm">
                                    <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                                        <tr>
                                            <th className="px-4 py-3">Allocated on</th>
                                            <th className="px-4 py-3">Serial</th>
                                            <th className="px-4 py-3">Model</th>
                                            <th className="px-4 py-3">OEM</th>
                                            <th className="px-4 py-3">Dealer</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                        {stockRows.map((r) => (
                                            <tr key={r.id}>
                                                <td className="whitespace-nowrap px-4 py-3 text-gray-700">{fmtDate(r.allocated_on)}</td>
                                                <td className="px-4 py-3 font-mono text-xs text-gray-800">{r.serial_number ?? "—"}</td>
                                                <td className="px-4 py-3 text-gray-800">{r.model_type ?? "—"}</td>
                                                <td className="px-4 py-3 text-gray-700">{r.oem_name ?? "—"}</td>
                                                <td className="px-4 py-3">
                                                    <DealerCell name={r.dealer_name ?? r.account_id} accountId={r.account_id} leadId={null} />
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </section>
                </>
            )}
        </div>
    );
}
