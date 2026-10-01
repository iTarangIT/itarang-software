"use client";

// The always-visible "where is this lead, whose turn is it, what do I do now"
// card at the top of an Ecofy lead. Replaces the old Current-step tab, the
// Case-timeline panel and the Assign panel: the stage rail, the party pill and
// the ONE form the lead needs next all live here, so nobody hunts through tabs.
// Who-acts logic is the pure stepBrief(); the forms are the same components the
// tabs render, gated by useCan and re-checked by Ecofy.

import { ECOFY_STAGE_LABELS, ecofyViewerKind } from "@/lib/ecofy/access";
import { eligibilitySentFromTimeline, stepBrief, type StepBrief, type StepFacts, type StepTone } from "@/lib/ecofy/stepBrief";
import { formatIst, StageRail } from "./badges";
import { useLeadData, type EcofyCase } from "./client";
import { EcofyAssignBar } from "./EcofyAssignBar";
import { Chip, Empty, Loading } from "./ui";
import { isActiveQuote, isLiveOffer, OfferOtpBlock, QuoteCard, QuoteUploadForm, QuoteRequestRow, EligibilityRequestRow, NewAssessmentForm, AssessmentCard, type Assessment, type Offer, type Quote } from "./tabs/AssessmentOfferTabs";
import { AppointmentCard, BookMeetingForm, LogActivityForm, type Appointment } from "./tabs/FollowUpTabs";
import {
    CreateInstallationRow,
    DisbursementForm,
    DocumentUploadRow,
    DownPaymentForm,
    FinancingDecisionForm,
    InstallationSummary,
    InstallationUpdateForm,
    isOpenDecision,
    type Decision,
    type Doc,
    type Installation,
    type PaymentStatus,
} from "./tabs/LaterStageTabs";
import { pretty, useCan, type TabProps } from "./tabs/shared";
import { AdvanceButton, CloseRow, ReopenRow, ReturnRow, RouteFinancierRow } from "./tabs/stepRows";

export interface CurrentStepCardProps {
    leadId: string;
    /** Live case from Ecofy, or null when Ecofy is unreachable (degraded: rail + party only). */
    c: EcofyCase | null;
    /** CRM stage, used when `c` is null. */
    localStage: string | null;
    viewer: { id: string; role: string };
    assignedTo: string | null;
    assigneeName: string | null;
    assigneeRole: string | null;
    assignedAt: string | null;
    onDone: () => void;
}

// Brand gradient (same token as the profile hero band: --gradient-primary).
const BRAND_GRADIENT = "bg-[image:var(--gradient-primary)]";

const TONE = {
    action: {
        card: "border-brand-200 from-brand-50/70",
        bar: BRAND_GRADIENT,
        pill: `${BRAND_GRADIENT} text-white shadow-md shadow-brand-300/50 ring-1 ring-brand-900/20`,
        railPill: "You are here",
    },
    waiting: { card: "border-amber-300 from-amber-50/70", bar: "bg-amber-400", pill: "bg-amber-500 text-white", railPill: "Pending" },
    done: {
        card: "border-brand-200 from-brand-50/70",
        bar: BRAND_GRADIENT,
        pill: `${BRAND_GRADIENT} text-white shadow-md shadow-brand-300/50 ring-1 ring-brand-900/20`,
        railPill: "Done",
    },
} satisfies Record<StepTone, { card: string; bar: string; pill: string; railPill: string }>;

export function CurrentStepCard(p: CurrentStepCardProps) {
    const stage = p.c?.stage ?? p.localStage;
    const viewerKind = ecofyViewerKind(p.viewer.role) ?? "worker";
    const viewerIsAssignee = Boolean(p.assignedTo) && p.assignedTo === p.viewer.id;
    const briefInput = {
        stage,
        subStatus: p.c?.subStatus ?? null,
        owner: p.c?.owner ?? null,
        financierName: p.c?.financierName ?? null,
        viewerKind,
        viewerIsAssignee,
        assigneeName: p.assigneeName,
        assigneeRole: p.assigneeRole,
    };

    if (!p.c) {
        // Ecofy unreachable: still say where the lead is and whose turn it is.
        const brief = stepBrief({ ...briefInput, facts: {} });
        return (
            <Shell brief={brief} stage={stage} ageing={null} closed={null}>
                <p className="text-sm text-gray-600">Ecofy could not be reached — actions return once it is back. Calls and follow-ups can still be logged below.</p>
            </Shell>
        );
    }

    return <LiveCard {...p} c={p.c} viewerKind={viewerKind} viewerIsAssignee={viewerIsAssignee} />;
}

function Shell({
    brief,
    stage,
    ageing,
    closed,
    children,
}: {
    brief: StepBrief;
    stage: string | null;
    ageing: EcofyCase["ageing"] | null;
    closed: { reason: string | null; note: string | null; at: string | null } | null;
    children: React.ReactNode;
}) {
    const t = TONE[brief.tone];
    const railPill = brief.tone === "waiting" ? partyShort(brief) : t.railPill;
    return (
        <section className={`relative overflow-hidden rounded-2xl border-2 bg-gradient-to-b to-white shadow-md ${t.card}`}>
            <span aria-hidden className={`absolute inset-y-0 left-0 w-1.5 ${t.bar}`} />
            <div className="space-y-4 px-5 py-4 pl-6">
                <header className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${t.pill}`}>{brief.partyLabel}</span>
                        {stage && (
                            <span className="text-sm text-gray-700">
                                <b>{stage}</b> · {ECOFY_STAGE_LABELS[stage] ?? stage}
                            </span>
                        )}
                    </div>
                    {ageing && (
                        <span className="text-xs text-gray-500">
                            in stage {ageing.inStageWorkingHours} wh · open {ageing.openWorkingHours} wh
                        </span>
                    )}
                </header>

                <StageRail stage={stage} tone={brief.tone} partyLabel={railPill} />

                {closed && (
                    <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
                        Closed: {pretty(closed.reason)} {closed.note ? `— ${closed.note}` : ""} on {formatIst(closed.at)}
                    </p>
                )}

                <div>
                    <h2 className="text-base font-semibold text-gray-900">{brief.title}</h2>
                    <p className="mt-0.5 text-sm text-gray-700">{brief.detail}</p>
                    {brief.gate && <p className="mt-1 text-xs text-gray-600">{brief.gate}</p>}
                    <p className="mt-1 text-xs font-medium text-blue-800">Next → {brief.next}</p>
                </div>

                {children}
            </div>
        </section>
    );
}

/** "Pending from Ecofy" → "Pending: Ecofy" for the little pill under the rail node. */
function partyShort(b: StepBrief): string {
    if (b.party === "ecofy") return "Pending: Ecofy";
    if (b.party === "sales_head") return "Pending: Sales Head";
    if (b.party === "epc") return "With EPC";
    if (b.party === "owner") return "With owner";
    return "You are here";
}

function LiveCard(
    p: Omit<CurrentStepCardProps, "c"> & { c: EcofyCase; viewerKind: "manager" | "worker"; viewerIsAssignee: boolean },
) {
    const { c, leadId } = p;
    const s = c.stage;
    const tab: TabProps = { leadId, c, viewer: p.viewer, assignedTo: p.assignedTo, onDone: p.onDone };
    const can = useCan(tab);
    const manager = p.viewerKind === "manager";

    // Only the reads this stage's brief needs (they are shared with the tabs' queries).
    const appointments = useLeadData<Appointment[]>(leadId, "appointments", s === "S2");
    const assessments = useLeadData<Assessment[]>(leadId, "assessments", s === "S3" || s === "S4");
    const quotes = useLeadData<Quote[]>(leadId, "quotes", s === "S4");
    const offers = useLeadData<Offer[]>(leadId, "offers", s === "S4" || s === "S5" || s === "S6");
    const timeline = useLeadData<Array<{ at: string; kind: string }>>(leadId, "timeline", s === "S4");
    const decisions = useLeadData<Decision[]>(leadId, "decisions", s === "S6");
    const installation = useLeadData<Installation>(leadId, "installation", s === "S6" || s === "S7");
    const documents = useLeadData<Doc[]>(leadId, "documents", s === "S7");
    const payment = useLeadData<PaymentStatus>(leadId, "payment-status", s === "S7");
    const reacceptancePending = s === "S6" && c.subStatus === "REACCEPTANCE_PENDING";
    const reacceptance = useLeadData<{ challengeId: string } | null>(leadId, "reacceptance", reacceptancePending && can("verify_otp"));
    const loading = [appointments, assessments, quotes, offers, timeline, decisions, installation, documents, payment, reacceptance].some((q) => q.isLoading);

    const latestAssessment = assessments.data?.[0];
    const facts: StepFacts = {
        completedMeeting: appointments.data?.some((a) => a.status === "COMPLETED"),
        scheduledMeeting: appointments.data?.some((a) => a.status === "SCHEDULED"),
        latestAssessment: latestAssessment ? { confirmed: Boolean(latestAssessment.confirmedAt) } : null,
        eligibilitySent: eligibilitySentFromTimeline(timeline.data),
        activeQuote: quotes.data?.some(isActiveQuote),
        liveOffer: offers.data?.find(isLiveOffer) ?? null,
        reacceptanceLive: Boolean(reacceptance.data),
        openDecision: decisions.data?.some(isOpenDecision),
        installation: installation.data ?? null,
        photos: documents.data?.filter((d) => d.typeCode === "INSTALLATION_PHOTO").length,
        letters: documents.data?.filter((d) => d.typeCode === "CUSTOMER_ACCEPTANCE_LETTER").length,
        downPaymentRecorded: payment.data?.downPaymentRecorded,
    };
    const brief = stepBrief({
        stage: s,
        subStatus: c.subStatus,
        owner: c.owner,
        financierName: c.financierName,
        viewerKind: p.viewerKind,
        viewerIsAssignee: p.viewerIsAssignee,
        assigneeName: p.assigneeName,
        assigneeRole: p.assigneeRole,
        facts,
    });

    const inst = installation.data ?? null;
    const activeQuote = quotes.data?.find((q) => q.status === "ACTIVE");

    return (
        <Shell
            brief={brief}
            stage={s}
            ageing={c.ageing}
            closed={s === "CLOSED" ? { reason: c.closureReason, note: c.closureNote, at: c.closedAt } : null}
        >
            {/* ---- the one thing to do now ---- */}
            <div className="rounded-xl border border-gray-200 bg-white p-4">
                {loading ? (
                    <Loading />
                ) : (
                    <>
                        {brief.primary === "assign" && manager && (
                            <div className="space-y-3">
                                <EcofyAssignBar leadIds={[leadId]} reassign={Boolean(p.assignedTo)} compact onDone={p.onDone} />
                                <ReturnRow {...tab} />
                            </div>
                        )}
                        {brief.primary === "assign" && !manager && <Waiting>The Sales Head assigns this lead from the pickup queue.</Waiting>}

                        {brief.primary === "book_meeting" && (can("book_appointment") ? <BookMeetingForm {...tab} /> : <Waiting>The owner books the meeting.</Waiting>)}
                        {brief.primary === "complete_meeting" && (
                            <div className="space-y-3">
                                {(appointments.data ?? [])
                                    .filter((a) => a.status === "SCHEDULED")
                                    .map((a) => (
                                        <AppointmentCard key={a.id} {...tab} a={a} />
                                    ))}
                                {can("book_appointment") && (
                                    <details className="text-sm">
                                        <summary className="cursor-pointer text-gray-700">Book another meeting ▸</summary>
                                        <div className="mt-2">
                                            <BookMeetingForm {...tab} />
                                        </div>
                                    </details>
                                )}
                            </div>
                        )}
                        {brief.primary === "advance" && (
                            <div className="flex flex-wrap items-center gap-3">
                                <AdvanceButton {...tab} />
                                <span className="text-xs text-gray-500">
                                    Completed: {(appointments.data ?? []).filter((a) => a.status === "COMPLETED").map((a) => `${a.meetingType.replace("_", " ")} ${formatIst(a.actualAt ?? a.scheduledAt)}`).join(" · ")}
                                </span>
                            </div>
                        )}

                        {brief.primary === "new_assessment" && (can("save_assessment") ? <NewAssessmentForm {...tab} /> : <Waiting>The owner records the assessment.</Waiting>)}
                        {brief.primary === "confirm_assessment" && latestAssessment && <AssessmentCard {...tab} a={latestAssessment} latest />}

                        {brief.primary === "send_eligibility" && (can("request_eligibility") ? <EligibilityRequestRow {...tab} /> : <Waiting>The owner sends the lead for eligibility.</Waiting>)}
                        {brief.primary === "await_eligibility" && (
                            <Waiting>
                                Sent for eligibility. {manager ? "Decisions for other financiers are recorded from the Eligibility queue." : "You will be notified when it is decided."}
                            </Waiting>
                        )}
                        {brief.primary === "route_financier" && (can("route_financier") ? <RouteFinancierRow {...tab} /> : <Waiting>The Sales Head routes the lead to the next financier.</Waiting>)}
                        {brief.primary === "upload_quote" && (
                            <div className="space-y-3">
                                {can("upload_quote") ? <QuoteUploadForm {...tab} /> : <Waiting>The owner uploads the EPC quote.</Waiting>}
                                {can("quote_request") && (
                                    <details className="text-sm">
                                        <summary className="cursor-pointer text-gray-700">Log a quote request to an EPC partner ▸</summary>
                                        <div className="mt-2">
                                            <QuoteRequestRow {...tab} />
                                        </div>
                                    </details>
                                )}
                            </div>
                        )}
                        {brief.primary === "compose_offer" && (activeQuote ? <QuoteCard {...tab} q={activeQuote} /> : <Empty>No ACTIVE quote.</Empty>)}
                        {(brief.primary === "send_otp" || brief.primary === "verify_otp" || brief.primary === "verify_reacceptance") && <OfferOtpBlock {...tab} />}

                        {(brief.primary === "financing_decision" || brief.primary === "await_decision") && (
                            <div className="space-y-3">
                                {brief.primary === "financing_decision" ? (
                                    <FinancingDecisionForm {...tab} />
                                ) : (
                                    <Waiting>
                                        {facts.openDecision === false
                                            ? "No decision is open with the financier yet."
                                            : "The financier is deciding. You will be notified on sanction or rejection."}
                                    </Waiting>
                                )}
                                {can("create_installation") && (
                                    <details className="text-sm">
                                        <summary className="cursor-pointer text-gray-700">Installation can start in parallel ▸</summary>
                                        <div className="mt-2 space-y-3">
                                            {inst ? (
                                                <>
                                                    <InstallationSummary inst={inst} />
                                                    <InstallationUpdateForm {...tab} inst={inst} />
                                                </>
                                            ) : (
                                                <CreateInstallationRow {...tab} />
                                            )}
                                        </div>
                                    </details>
                                )}
                            </div>
                        )}

                        {brief.primary === "create_installation" && (can("create_installation") ? <CreateInstallationRow {...tab} /> : <Waiting>The owner creates the installation.</Waiting>)}
                        {brief.primary === "installation_progress" && inst && (
                            <div className="space-y-3">
                                <InstallationSummary inst={inst} />
                                <ProofChecklist photos={facts.photos ?? 0} letters={facts.letters ?? 0} />
                                {can("upload_document") && (
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <DocumentUploadRow {...tab} fixedType="INSTALLATION_PHOTO" label="Installation photo (JPG / PNG / PDF)" hint="At least one is required before INSTALLED." />
                                        <DocumentUploadRow {...tab} fixedType="CUSTOMER_ACCEPTANCE_LETTER" label="Customer acceptance letter (PDF / photo)" hint="Required before INSTALLED." />
                                    </div>
                                )}
                                <InstallationUpdateForm {...tab} inst={inst} />
                            </div>
                        )}
                        {brief.primary === "disbursement" && (
                            <div className="space-y-3">
                                {inst && <InstallationSummary inst={inst} />}
                                {can("down_payment") && !facts.downPaymentRecorded && <DownPaymentForm {...tab} />}
                                {can("disbursement") ? <DisbursementForm {...tab} /> : <Waiting>The disbursement is recorded by Ecofy (or the Sales Head for other financiers).</Waiting>}
                            </div>
                        )}

                        {brief.primary === "reopen" && <ReopenRow {...tab} />}
                        {brief.primary === "none" && <Waiting>{brief.tone === "done" ? "Nothing to do in the CRM." : "Nothing to do in the CRM right now."}</Waiting>}
                    </>
                )}
            </div>

            {/* ---- secondary, always reachable without leaving the card ---- */}
            <div className="space-y-2 border-t border-gray-200/70 pt-3">
                {can("log_activity") && (
                    <details className="text-sm">
                        <summary className="cursor-pointer font-medium text-gray-700">Log a call / remark / follow-up ▸</summary>
                        <div className="mt-2">
                            <LogActivityForm {...tab} />
                        </div>
                    </details>
                )}
                {manager && brief.primary !== "assign" && !["S0", "CLOSED"].includes(s) && (
                    <details className="text-sm">
                        <summary className="cursor-pointer font-medium text-gray-700">
                            {p.assignedTo ? "Reassign" : "Assign to an ASM or ISR"} ▸
                            {p.assigneeName && (
                                <span className="ml-2 font-normal text-gray-500">
                                    with {p.assigneeName} since {formatIst(p.assignedAt)}
                                </span>
                            )}
                        </summary>
                        <div className="mt-2">
                            <EcofyAssignBar leadIds={[leadId]} reassign={Boolean(p.assignedTo)} compact onDone={p.onDone} />
                        </div>
                    </details>
                )}
                {brief.primary !== "assign" && <ReturnRow {...tab} />}
                <CloseRow {...tab} />
            </div>
        </Shell>
    );
}

function Waiting({ children }: { children: React.ReactNode }) {
    return <p className="text-sm text-gray-600">{children}</p>;
}

function ProofRow({ ok, label, n }: { ok: boolean; label: string; n: number }) {
    return (
        <li className="flex items-center gap-2">
            <Chip tone={ok ? "green" : "amber"}>{ok ? "✓" : "✗"}</Chip>
            <span>
                {label} <span className="text-gray-500">({n} uploaded)</span>
            </span>
        </li>
    );
}

function ProofChecklist({ photos, letters }: { photos: number; letters: number }) {
    return (
        <ul className="space-y-1 text-sm">
            <ProofRow ok={photos >= 1} label="Installation photo" n={photos} />
            <ProofRow ok={letters >= 1} label="Customer acceptance letter" n={letters} />
        </ul>
    );
}
