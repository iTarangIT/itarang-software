// "Dealer said yes, not marked Won" (tracker ID 75.4) — the list the CEO
// card's "Open list" opens. Rows come from listSaidYesNotWon(), the same query
// the card sums, so the card's count / ₹ / oldest wait are exactly this page.

import Link from "next/link";
import { ArrowLeft, FileText } from "lucide-react";

import { requireRole } from "@/lib/auth-utils";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import type { LeadStatus } from "@/lib/lifecycle/transitions";
import {
    SAID_YES_LIMIT_WORKING_DAYS,
    listSaidYesNotWon,
    summarizeSaidYes,
    type SaidYesRow,
} from "@/lib/leads/saidYesNotWon";

export const dynamic = "force-dynamic";

const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// Same compact form as the CEO card (primitives.inr — a client module, so not
// importable into this server page).
const inr = (n: number) =>
    n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(2)} L` : rupees(Math.round(n));

const when = (iso: string | null) =>
    iso
        ? new Date(iso).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
              day: "2-digit",
              month: "short",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
          })
        : "—";

const VIA_LABEL: Record<string, string> = { whatsapp: "WhatsApp button", link: "approval link" };

const days = (n: number) => `${n} working day${n === 1 ? "" : "s"}`;

function Chip({ label, value }: { label: string; value: string }) {
    return (
        <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600">
            {label} <span className="font-medium text-gray-900">{value}</span>
        </span>
    );
}

function LeadCard({ r }: { r: SaidYesRow }) {
    const over = r.working_days_waiting > SAID_YES_LIMIT_WORKING_DAYS;
    const owner = r.owner_name ? `${r.owner_name}${r.owner_role ? ` (${r.owner_role.replace(/_/g, " ")})` : ""}` : "No owner";
    return (
        <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <Link
                        href={`/leads/${encodeURIComponent(r.lead_id)}`}
                        className="text-base font-semibold text-gray-900 hover:text-brand-sky hover:underline"
                    >
                        {r.dealer}
                    </Link>
                    <p className="mt-0.5 text-xs text-gray-500">
                        {[r.city, r.state].filter(Boolean).join(", ") || "City not set"} · Owner: {owner}
                        {r.lead_status &&
                            ` · ${LEAD_STATUS_LABEL[r.lead_status as LeadStatus] ?? r.lead_status.replace(/_/g, " ")}`}
                    </p>
                </div>
                <div className="text-right">
                    <p className="text-lg font-bold text-gray-900">{rupees(r.value)}</p>
                    <p className={`text-xs font-semibold ${over ? "text-red-600" : "text-amber-600"}`}>
                        waiting {days(r.working_days_waiting)}
                        {over && ` · ${days(r.working_days_waiting - SAID_YES_LIMIT_WORKING_DAYS)} over limit`}
                    </p>
                </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
                <Chip label="Quote" value={`${r.quote_number ?? "no number"}${r.version_no ? ` · v${r.version_no}` : ""}`} />
                <Chip label="Credit" value={r.credit_terms ?? "—"} />
                <Chip label="Customer finance" value={r.customer_finance == null ? "—" : r.customer_finance ? "Yes" : "No"} />
                {r.delivery_terms && <Chip label="Delivery" value={r.delivery_terms} />}
                {r.warranty_terms && <Chip label="Warranty" value={r.warranty_terms} />}
            </div>

            <p className="text-sm text-gray-700">
                <span className="text-gray-500">Products: </span>
                {r.lines.length
                    ? r.lines.map((l) => `${l.product_name} × ${l.quantity}`).join(", ")
                    : "no product lines"}
            </p>

            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                <div>
                    <dt className="inline text-gray-500">Quote released: </dt>
                    <dd className="inline text-gray-800">
                        {when(r.released_at)}
                        {r.approval_mode === "auto" ? " (auto-approved)" : r.approval_mode === "manual" ? " (approved by CEO)" : ""}
                    </dd>
                </div>
                <div>
                    <dt className="inline text-gray-500">Dealer said yes: </dt>
                    <dd className="inline text-gray-800">
                        {when(r.dealer_yes_at)}
                        {r.dealer_yes_via && ` via ${VIA_LABEL[r.dealer_yes_via] ?? r.dealer_yes_via}`}
                    </dd>
                </div>
                {r.phone && (
                    <div>
                        <dt className="inline text-gray-500">Dealer phone: </dt>
                        <dd className="inline text-gray-800">{r.phone}</dd>
                    </div>
                )}
            </dl>

            {r.dealer_note && (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    <span className="font-semibold">Dealer&rsquo;s note:</span> {r.dealer_note}
                </p>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-1">
                <Link
                    href={`/leads/${encodeURIComponent(r.lead_id)}`}
                    className="rounded-lg bg-brand-navy px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                >
                    Open lead
                </Link>
                {r.quote_pdf_url && (
                    <a
                        href={r.quote_pdf_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-semibold text-brand-sky hover:underline"
                    >
                        <FileText className="h-3.5 w-3.5" /> Quotation PDF
                    </a>
                )}
            </div>
        </div>
    );
}

export default async function SaidYesNotWonPage() {
    await requireRole(["ceo", "admin"]);
    const rows = await listSaidYesNotWon();
    const s = summarizeSaidYes(rows);
    const overLimit = rows.filter((r) => r.working_days_waiting > SAID_YES_LIMIT_WORKING_DAYS).length;

    return (
        <div className="space-y-6 pb-12">
            <div>
                <Link href="/ceo" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-sky hover:underline">
                    <ArrowLeft className="h-3.5 w-3.5" /> CEO overview
                </Link>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-brand-navy">Dealer said yes, not marked Won</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    The dealer approved the quote, but its owner has not pressed Mark Won. The limit is{" "}
                    {days(SAID_YES_LIMIT_WORKING_DAYS)} from the dealer&rsquo;s yes (Mon–Sat).
                </p>
            </div>

            <div className="max-w-3xl space-y-4">
                {rows.length > 0 && (
                    <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-700">
                        <span className="font-semibold">
                            {s.count} lead{s.count === 1 ? "" : "s"}
                        </span>{" "}
                        · {inr(s.value)} in approved quotes · {overLimit} over the limit
                        {s.oldestDays != null && ` · oldest ${days(s.oldestDays)}`}
                    </div>
                )}

                {rows.length === 0 ? (
                    <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">
                        Nothing waiting — every quote a dealer approved has been marked Won.
                    </p>
                ) : (
                    rows.map((r) => <LeadCard key={r.lead_id} r={r} />)
                )}
            </div>
        </div>
    );
}
