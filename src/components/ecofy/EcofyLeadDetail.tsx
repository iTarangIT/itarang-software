"use client";

// One Ecofy lead, worked from the CRM (E-307). The same component serves the
// Sales Head (/sales-head/ecofy/leads/[id]) and the assigned ASM / ISR
// (/asm/ecofy-leads/[id], /inside-sales/ecofy-leads/[id]); what each can DO is
// decided by src/lib/ecofy/access.ts, and Ecofy re-checks every gate.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import { ecofyViewerKind } from "@/lib/ecofy/access";
import { formatIst, inr, StageBadge, StageRail, TemperatureBadge } from "./badges";
import { useLeadData, useRefreshLead, type EcofyCase } from "./client";
import { EcofyAssignBar } from "./EcofyAssignBar";
import { ErrorNote, KV, Loading, Panel } from "./ui";
import { CurrentStepTab } from "./tabs/CurrentStepTab";
import { ActivitiesTab, AppointmentsTab, TimelineTab } from "./tabs/FollowUpTabs";
import { AssessmentTab, OfferTab } from "./tabs/AssessmentOfferTabs";
import { AssignmentsTab, DocumentsTab, FinancingTab, InstallationTab, WithdrawalTab } from "./tabs/LaterStageTabs";
import type { TabProps } from "./tabs/shared";
import { CrmWorkLog, LocalActivityList, useLocalActivities } from "./CrmWorkLog";

const TABS = [
    "Current step",
    "Timeline",
    "Activities",
    "Appointments",
    "Assessment",
    "Offer",
    "Financing",
    "Installation",
    "Documents",
    "Withdrawal",
    "Assignment",
] as const;
type Tab = (typeof TABS)[number];

export interface EcofyLeadDetailProps {
    leadId: string;
    viewer: { id: string; role: string };
    backHref: string;
    ecofyUrl: string | null;
    /** From the CRM row, so the page renders before Ecofy answers. */
    local: {
        caseNo: string | null;
        customerName: string | null;
        stage: string | null;
        temperature: string | null;
        assignedTo: string | null;
        assigneeName: string | null;
        assignedAt: string | null;
        nextFollowUpAt: string | null;
        nextAppointmentAt: string | null;
        /** CRM copy of the customer / lead, shown when Ecofy cannot be reached. */
        snapshot: Array<[string, string | null]>;
    };
}

export function EcofyLeadDetail(props: EcofyLeadDetailProps) {
    const { leadId, viewer, local } = props;
    const router = useRouter();
    const caseQ = useLeadData<EcofyCase>(leadId, "case");
    const refreshLead = useRefreshLead(leadId);
    const [tab, setTab] = useState<Tab>("Current step");
    const manager = ecofyViewerKind(viewer.role) === "manager";
    const c = caseQ.data;

    const onDone = () => {
        refreshLead();
        router.refresh();
    };

    const tabProps: TabProps | null = c ? { leadId, c, viewer, assignedTo: local.assignedTo, onDone } : null;

    return (
        <div className="mx-auto max-w-[1400px] space-y-5 px-4 py-6 sm:px-6 md:px-8">
            <Link href={props.backHref} className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900">
                <ArrowLeft className="h-4 w-4" /> Ecofy leads
            </Link>

            <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
                        {c?.customer?.fullName ?? local.customerName ?? "Unnamed customer"}
                    </h1>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-600">
                        <span className="font-medium text-gray-900">{c?.caseNo ?? local.caseNo}</span>
                        {c?.segment && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">{c.segment}</span>}
                        <TemperatureBadge value={c?.temperature ?? local.temperature} />
                        <StageBadge value={c?.stage ?? local.stage} subStatus={c?.subStatus} />
                        {c && <span className="text-xs text-gray-400">v{c.version}</span>}
                    </div>
                    <p className="mt-2 text-sm text-gray-600">
                        {local.assigneeName ? (
                            <>
                                With <b>{local.assigneeName}</b> since {formatIst(local.assignedAt)}
                            </>
                        ) : (
                            "Not assigned yet"
                        )}
                        {local.nextFollowUpAt && <> · next follow-up {formatIst(local.nextFollowUpAt)}</>}
                        {local.nextAppointmentAt && <> · meeting {formatIst(local.nextAppointmentAt)}</>}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={onDone}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50"
                    >
                        <RefreshCw className="h-4 w-4" /> Refresh
                    </button>
                    {props.ecofyUrl && (
                        <a
                            href={props.ecofyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
                        >
                            Open in Ecofy <ExternalLink className="h-4 w-4" />
                        </a>
                    )}
                </div>
            </header>

            {manager && (c?.stage ?? local.stage) && !["S0", "CLOSED"].includes((c?.stage ?? local.stage) as string) && (
                <Panel title={local.assignedTo ? "Reassign" : "Assign to an ASM or ISR"} right="the owner works the lead from their dashboard">
                    <EcofyAssignBar leadIds={[leadId]} reassign={Boolean(local.assignedTo)} compact onDone={onDone} />
                </Panel>
            )}

            <Panel
                title="Case timeline"
                right={c ? `in stage ${c.ageing.inStageWorkingHours} wh · open ${c.ageing.openWorkingHours} wh` : undefined}
            >
                <StageRail stage={c?.stage ?? local.stage} />
                {c?.stage === "CLOSED" && (
                    <p className="mt-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
                        Closed: {c.closureReason} {c.closureNote ? `— ${c.closureNote}` : ""} on {formatIst(c.closedAt)}
                    </p>
                )}
            </Panel>

            {caseQ.isLoading && <Loading />}
            {caseQ.error && (
                <div className="space-y-4">
                    <ErrorNote error={caseQ.error} />
                    <p className="text-sm text-gray-600">
                        Ecofy could not be reached. You can still work the lead: calls, remarks, follow-ups and meeting bookings are saved
                        in the CRM and sent to Ecofy automatically once it is back. Assessment, offer and OTP need Ecofy.
                    </p>
                    <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
                        <CrmWorkLog leadId={leadId} viewer={viewer} assignedTo={local.assignedTo} stage={local.stage} />
                        <Panel title="Customer & lead (CRM copy)">
                            <KV rows={local.snapshot} />
                        </Panel>
                    </div>
                </div>
            )}

            {c && tabProps && (
                <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
                    <div className="min-w-0 space-y-4">
                        <nav className="flex flex-wrap gap-1">
                            {TABS.map((t) => (
                                <button
                                    key={t}
                                    type="button"
                                    onClick={() => setTab(t)}
                                    className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                                        tab === t ? "bg-gray-900 text-white" : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                                    }`}
                                >
                                    {t}
                                </button>
                            ))}
                        </nav>
                        <PendingCrmEntries leadId={leadId} />
                        {tab === "Current step" && <CurrentStepTab {...tabProps} />}
                        {tab === "Timeline" && <TimelineTab {...tabProps} />}
                        {tab === "Activities" && <ActivitiesTab {...tabProps} />}
                        {tab === "Appointments" && <AppointmentsTab {...tabProps} />}
                        {tab === "Assessment" && <AssessmentTab {...tabProps} />}
                        {tab === "Offer" && <OfferTab {...tabProps} />}
                        {tab === "Financing" && <FinancingTab {...tabProps} />}
                        {tab === "Installation" && <InstallationTab {...tabProps} />}
                        {tab === "Documents" && <DocumentsTab {...tabProps} />}
                        {tab === "Withdrawal" && <WithdrawalTab {...tabProps} />}
                        {tab === "Assignment" && <AssignmentsTab {...tabProps} />}
                    </div>
                    <div className="space-y-4">
                        <Panel title="Customer">
                            <KV
                                rows={[
                                    ["Mobile", [c.customer?.mobile, c.customer?.altMobile].filter(Boolean).join(" / ") || null],
                                    ["Email", c.customer?.email ?? null],
                                    ["Type", [c.customer?.customerType, c.customer?.businessName].filter(Boolean).join(" · ") || null],
                                    [
                                        "Address",
                                        [c.customer?.address, c.customer?.city, c.customer?.state, c.customer?.pincode].filter(Boolean).join(", ") || null,
                                    ],
                                    ["Language", c.customer?.preferredLanguage ?? null],
                                    ["Property", c.customer?.propertyType ?? null],
                                    ["Consent", [c.customer?.consentSource, c.customer?.consentDate].filter(Boolean).join(" · ") || null],
                                ]}
                            />
                        </Panel>
                        <Panel title="Lead details">
                            <KV
                                rows={[
                                    ["Source", `${c.source ?? "—"} · owner ${c.owner === "ECOFY" ? "Ecofy" : "iTarang"}`],
                                    ["Product interest", c.productInterest],
                                    ["Avg monthly bill", inr(c.avgMonthlyBillInr)],
                                    ["Sanctioned load", c.sanctionedLoadKw !== null ? `${c.sanctionedLoadKw} kW` : null],
                                    ["Existing backup", c.existingBackup],
                                    ["Call time", c.preferredCallTime],
                                    ["Qualified by", c.qualifiedByName],
                                    ["Financier", c.financierName],
                                    ["Hot → first call", c.hotToFirstCallHours !== null ? `${c.hotToFirstCallHours} h` : null],
                                    ["Created", formatIst(c.createdAt)],
                                ]}
                            />
                        </Panel>
                    </div>
                </div>
            )}
        </div>
    );
}

/** Entries kept in the CRM while Ecofy was unavailable and not yet sent. */
function PendingCrmEntries({ leadId }: { leadId: string }) {
    const q = useLocalActivities(leadId);
    return <LocalActivityList leadId={leadId} rows={q.data} onlyUnsynced />;
}
