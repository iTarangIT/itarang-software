"use client";

// Slide-in detail drawer. Branches on source: ai_dialer hits the detail
// endpoint that joins on phone (no FK on pre-promotion dialer rows); b2b
// hits the detail endpoint that joins on lead_id across deal/loan/KYC.

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, Phone, MapPin, Loader2, AlertCircle, Sparkles, Receipt, Landmark, ShieldCheck } from "lucide-react";
import type { ConvertedRow } from "@/lib/sales-insight/types";

type Props = {
    row: ConvertedRow | null;
    onClose: () => void;
};

type DetailResponse = { success: true; data: Record<string, unknown> };

function endpointFor(row: ConvertedRow): string {
    // Strip the "dl_"/"ld_" prefix to recover the raw table id.
    const rawId = row.id.replace(/^dl_|^ld_/, "");
    return row.source === "ai_dialer"
        ? `/api/sales-insight/detail/ai-dialer/${encodeURIComponent(rawId)}`
        : `/api/sales-insight/detail/b2b/${encodeURIComponent(rawId)}`;
}

function formatDate(value: unknown): string {
    if (!value) return "—";
    try {
        return new Date(String(value)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    } catch {
        return "—";
    }
}

function Field({ label, value }: { label: string; value: unknown }) {
    return (
        <div>
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-0.5">{label}</div>
            <div className="text-sm text-gray-900">{value === null || value === undefined || value === "" ? "—" : String(value)}</div>
        </div>
    );
}

function Section({ title, icon: Icon, children }: { title: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
    return (
        <div className="rounded-lg border border-gray-100 p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                <Icon className="h-4 w-4 text-gray-500" />
                {title}
            </div>
            <div className="grid grid-cols-2 gap-3">{children}</div>
        </div>
    );
}

export function DrillDrawer({ row, onClose }: Props) {
    useEffect(() => {
        if (!row) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [row, onClose]);

    const query = useQuery<DetailResponse>({
        queryKey: ["sales-insight-detail", row?.id],
        queryFn: async () => {
            if (!row) throw new Error("No row");
            const res = await fetch(endpointFor(row), { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load lead detail");
            return res.json();
        },
        enabled: Boolean(row),
    });

    if (!row) return null;

    const detail = query.data?.data as Record<string, unknown> | undefined;
    const isAi = row.source === "ai_dialer";

    const get = <T = unknown>(obj: unknown, path: string): T | undefined => {
        if (obj === null || obj === undefined) return undefined;
        return path.split(".").reduce<unknown>((acc, key) => {
            if (acc && typeof acc === "object" && key in (acc as object)) {
                return (acc as Record<string, unknown>)[key];
            }
            return undefined;
        }, obj) as T | undefined;
    };

    return (
        <div className="fixed inset-0 z-40">
            <div
                className="absolute inset-0 bg-black/30"
                onClick={onClose}
            />
            <div className="absolute right-0 top-0 h-full w-full max-w-2xl bg-white shadow-2xl flex flex-col">
                <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                            <span
                                className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
                                    isAi
                                        ? "bg-purple-50 text-purple-700 border border-purple-200"
                                        : "bg-blue-50 text-blue-700 border border-blue-200"
                                }`}
                            >
                                {isAi ? "AI Dialer" : "B2B"}
                            </span>
                            {row.also_in.map((s) => (
                                <span key={s} className="text-[10px] uppercase text-gray-400">also: {s}</span>
                            ))}
                        </div>
                        <h2 className="text-lg font-semibold text-gray-900 truncate">{row.display_name}</h2>
                        <div className="text-xs text-gray-500 flex items-center gap-3 mt-1">
                            <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{row.phone || "—"}</span>
                            <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{row.region ?? "—"}</span>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1 rounded hover:bg-gray-100 text-gray-500"
                        aria-label="Close"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                    {query.isLoading && (
                        <div className="flex items-center justify-center py-12 text-gray-400">
                            <Loader2 className="h-5 w-5 animate-spin mr-2" />
                            Loading…
                        </div>
                    )}

                    {query.error && (
                        <div className="flex items-center gap-2 p-3 rounded bg-red-50 text-red-700 text-sm">
                            <AlertCircle className="h-4 w-4" />
                            {(query.error as Error).message}
                        </div>
                    )}

                    {detail && isAi && (
                        <>
                            <Section title="Lead" icon={Sparkles}>
                                <Field label="Shop name" value={get(detail, "lead.shop_name")} />
                                <Field label="Dealer name" value={get(detail, "lead.dealer_name")} />
                                <Field label="Status" value={get(detail, "lead.current_status")} />
                                <Field label="Final intent" value={get(detail, "lead.final_intent_score")} />
                                <Field label="Total attempts" value={get(detail, "lead.total_attempts")} />
                                <Field label="Created" value={formatDate(get(detail, "lead.created_at"))} />
                            </Section>

                            {detail.latest_follow_up != null && (
                                <Section title="Latest follow-up" icon={Sparkles}>
                                    <Field label="Timestamp" value={formatDate(get(detail, "latest_follow_up.timestamp"))} />
                                    <Field label="Outcome" value={get(detail, "latest_follow_up.outcome")} />
                                    <div className="col-span-2">
                                        <Field
                                            label="Intent score"
                                            value={get(detail, "latest_follow_up.analysis.intent_score")}
                                        />
                                    </div>
                                </Section>
                            )}

                            {get<string>(detail, "lead.overall_summary") && (
                                <div className="rounded-lg border border-gray-100 p-4">
                                    <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Overall summary</div>
                                    <p className="text-sm text-gray-800 whitespace-pre-wrap">{get<string>(detail, "lead.overall_summary")}</p>
                                </div>
                            )}

                            {get<string>(detail, "latest_call.transcript") && (
                                <div className="rounded-lg border border-gray-100 p-4">
                                    <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Latest call transcript</div>
                                    <pre className="text-xs text-gray-800 whitespace-pre-wrap font-sans max-h-96 overflow-y-auto">{get<string>(detail, "latest_call.transcript")}</pre>
                                </div>
                            )}

                            {get<string>(detail, "latest_call.recording_url") && (
                                <a
                                    href={get<string>(detail, "latest_call.recording_url")}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-block text-sm text-blue-600 hover:underline"
                                >
                                    Open recording
                                </a>
                            )}
                        </>
                    )}

                    {detail && !isAi && (
                        <>
                            <Section title="Lead" icon={Sparkles}>
                                <Field label="Business name" value={get(detail, "lead.business_name")} />
                                <Field label="Owner" value={get(detail, "lead.owner_name") ?? get(detail, "lead.full_name")} />
                                <Field label="Status" value={get(detail, "lead.lead_status") ?? get(detail, "lead.status")} />
                                <Field label="KYC status" value={get(detail, "lead.kyc_status")} />
                                <Field label="Intent score" value={get(detail, "lead.intent_score")} />
                                <Field label="Converted at" value={formatDate(get(detail, "lead.converted_at"))} />
                            </Section>

                            {detail.deal != null && (
                                <Section title="Deal" icon={Receipt}>
                                    <Field label="Total payable" value={get(detail, "deal.total_payable")} />
                                    <Field label="Line total" value={get(detail, "deal.line_total")} />
                                    <Field label="GST" value={get(detail, "deal.gst_amount")} />
                                    <Field label="Payment term" value={get(detail, "deal.payment_term")} />
                                    <Field label="Deal status" value={get(detail, "deal.deal_status")} />
                                    <Field label="Invoice" value={get(detail, "deal.invoice_number")} />
                                </Section>
                            )}

                            {detail.loan_application != null && (
                                <Section title="Loan application" icon={Landmark}>
                                    <Field label="Amount" value={get(detail, "loan_application.loan_amount")} />
                                    <Field label="EMI" value={get(detail, "loan_application.emi_amount")} />
                                    <Field label="Tenure (months)" value={get(detail, "loan_application.tenure_months")} />
                                    <Field label="Rate %" value={get(detail, "loan_application.interest_rate")} />
                                    <Field label="NBFC" value={get(detail, "loan_application.nbfc_name")} />
                                    <Field label="Status" value={get(detail, "loan_application.application_status") ?? get(detail, "loan_application.status")} />
                                    <Field label="Submitted" value={formatDate(get(detail, "loan_application.submitted_at"))} />
                                    <Field label="Disbursed" value={formatDate(get(detail, "loan_application.disbursed_at"))} />
                                </Section>
                            )}

                            {Array.isArray(detail.kyc_verifications) && (detail.kyc_verifications as unknown[]).length > 0 && (
                                <Section title="KYC verifications" icon={ShieldCheck}>
                                    {(detail.kyc_verifications as Array<Record<string, unknown>>).map((k) => (
                                        <div key={String(k.id)} className="col-span-2 flex items-center justify-between text-sm">
                                            <span className="text-gray-700">{String(k.verification_type ?? "")}</span>
                                            <span className="text-gray-500">{String(k.status ?? "")}</span>
                                        </div>
                                    ))}
                                </Section>
                            )}

                            {get<string>(detail, "latest_call.summary") && (
                                <div className="rounded-lg border border-gray-100 p-4">
                                    <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Latest call summary</div>
                                    <p className="text-sm text-gray-800 whitespace-pre-wrap">{get<string>(detail, "latest_call.summary")}</p>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
