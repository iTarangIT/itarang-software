import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { requireRole } from "@/lib/auth-utils";
import { getEcofyLead, safeEcofyUrl } from "@/lib/ecofy/queries";
import { formatIst, formatQueueAge, StageBadge, TemperatureBadge } from "../_components/badges";

export const dynamic = "force-dynamic";

// E-305 — one Ecofy lead: customer, stage and a link to the case in Ecofy.
export default async function EcofyLeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
    await requireRole(["sales_head"]);
    const { id } = await params;
    const lead = await getEcofyLead(id);
    if (!lead) notFound();

    const ecofyUrl = safeEcofyUrl(lead.ecofy_url);
    const change = (lead.last_change ?? null) as {
        from?: string | null;
        to?: string | null;
        reason?: string | null;
    } | null;

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1200px]">
            <Link
                href="/sales-head/ecofy-leads"
                className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
            >
                <ArrowLeft className="h-4 w-4" /> Ecofy Leads
            </Link>

            <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                        {lead.customer_name ?? "Unnamed customer"}
                    </h1>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-600">
                        <span className="font-medium text-gray-900">{lead.case_no ?? lead.ecofy_case_id}</span>
                        <TemperatureBadge value={lead.temperature} />
                        <StageBadge value={lead.stage} />
                        {lead.sub_status && <span className="text-xs text-gray-500">{lead.sub_status}</span>}
                    </div>
                </div>
                {ecofyUrl && (
                    <a
                        href={ecofyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800"
                    >
                        Open in Ecofy <ExternalLink className="h-4 w-4" />
                    </a>
                )}
            </header>

            <div className="grid gap-5 md:grid-cols-2">
                <Card title="Customer">
                    <Field label="Name" value={lead.customer_name} />
                    <Field label="Mobile" value={lead.customer_mobile} />
                    <Field label="Alt. mobile" value={lead.customer_alt_mobile} />
                    <Field label="Email" value={lead.customer_email} />
                    <Field label="Customer type" value={lead.customer_type} />
                    <Field label="Business name" value={lead.business_name} />
                    <Field label="Address" value={lead.address} />
                    <Field
                        label="City / State / PIN"
                        value={[lead.city, lead.state, lead.pincode].filter(Boolean).join(", ") || null}
                    />
                    <Field label="Preferred language" value={lead.preferred_language} />
                    <Field label="Property type" value={lead.property_type} />
                </Card>

                <Card title="Stage">
                    <Field label="Stage" value={lead.stage} />
                    <Field label="Sub-status" value={lead.sub_status} />
                    <Field
                        label="Last change"
                        value={
                            change?.from || change?.to
                                ? `${change.from ?? "?"} → ${change.to ?? "?"}${change.reason ? ` (${change.reason})` : ""}`
                                : null
                        }
                    />
                    <Field label="Closure reason" value={lead.closure_reason} />
                    <Field
                        label="In queue since"
                        value={
                            lead.queue_entered_at
                                ? `${formatIst(lead.queue_entered_at)} (${formatQueueAge(lead.queue_entered_at)})`
                                : null
                        }
                    />
                    <Field label="Qualified by" value={lead.qualified_by_name} />
                    <Field label="Ecofy version" value={String(lead.version)} />
                    <Field label="Last update" value={formatIst(lead.last_event_at)} />
                </Card>

                <Card title="Requirement">
                    <Field label="Segment" value={lead.segment} />
                    <Field label="Product interest" value={lead.product_interest} />
                    <Field
                        label="Avg. monthly bill"
                        value={lead.avg_monthly_bill_inr ? `₹${Number(lead.avg_monthly_bill_inr).toLocaleString("en-IN")}` : null}
                    />
                    <Field label="Sanctioned load" value={lead.sanctioned_load_kw ? `${lead.sanctioned_load_kw} kW` : null} />
                    <Field label="Existing backup" value={lead.existing_backup} />
                    <Field label="Preferred call time" value={lead.preferred_call_time} />
                    <Field label="Source" value={lead.lead_source} />
                </Card>
            </div>
        </div>
    );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
            <dl className="space-y-2 text-sm">{children}</dl>
        </section>
    );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
    return (
        <div className="grid grid-cols-[140px_1fr] gap-3">
            <dt className="text-gray-500">{label}</dt>
            <dd className="break-words text-gray-900">{value || "—"}</dd>
        </div>
    );
}
