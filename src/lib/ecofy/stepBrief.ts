// "Whose turn is it, what do I do now, what comes next" for one Ecofy lead,
// as seen by one CRM viewer. Pure: no React, no I/O — the CurrentStepCard
// feeds it the case fields plus whatever live facts it has loaded, and unit
// tests table it.
//
// Ecofy's case DTO carries no "who acts next" field, so this derives it from
// stage × sub-status × the facts (BRD §4.2 transitions; sub-statuses from the
// Ecofy m07/m09/m10/m11/m12 services). Ecofy still re-checks every gate.

import { ECOFY_ROLE_LABEL } from "./access";

export type StepParty = "you" | "owner" | "sales_head" | "ecofy" | "epc";
export type StepTone = "action" | "waiting" | "done";

export type StepPrimary =
    | "none"
    | "assign"
    | "book_meeting"
    | "complete_meeting"
    | "advance"
    | "new_assessment"
    | "confirm_assessment"
    | "send_eligibility"
    | "await_eligibility"
    | "route_financier"
    | "upload_quote"
    | "compose_offer"
    | "send_otp"
    | "verify_otp"
    | "verify_reacceptance"
    | "financing_decision"
    | "await_decision"
    | "create_installation"
    | "installation_progress"
    | "disbursement"
    | "reopen";

/** Live facts the card has loaded. Everything optional — unknown counts as "none yet". */
export interface StepFacts {
    completedMeeting?: boolean;
    scheduledMeeting?: boolean;
    latestAssessment?: { confirmed: boolean } | null;
    /** From the Ecofy timeline: an `eligibility.requested` after the last `eligibility.decided`. */
    eligibilitySent?: boolean;
    activeQuote?: boolean;
    liveOffer?: { status: string } | null;
    reacceptanceLive?: boolean;
    openDecision?: boolean;
    installation?: { status: string } | null;
    photos?: number;
    letters?: number;
    downPaymentRecorded?: boolean;
}

export interface StepBriefInput {
    stage: string | null;
    subStatus: string | null;
    /** Who sourced the lead in Ecofy: "ECOFY" | "ITARANG". */
    owner: string | null;
    financierName: string | null;
    viewerKind: "manager" | "worker";
    viewerIsAssignee: boolean;
    assigneeName: string | null;
    assigneeRole: string | null;
    facts: StepFacts;
}

export interface StepBrief {
    title: string;
    detail: string;
    next: string;
    gate?: string;
    party: StepParty;
    /** "Your action" · "Pending from Sales Head" · "Pending from Ecofy" · "With Rahul (ASM)" … */
    partyLabel: string;
    tone: StepTone;
    primary: StepPrimary;
}

/**
 * The seeded financier is named "Ecofy"; any other name is a lender the Sales
 * Head (iTarang Admin) records decisions for. A null name means the default,
 * which is Ecofy. Heuristic on purpose — Ecofy exposes no "is own financier"
 * flag on the case.
 */
export function isEcofyFinancier(name: string | null | undefined): boolean {
    return !name || /ecofy/i.test(name);
}

type Draft = Omit<StepBrief, "party" | "partyLabel" | "tone"> & { who: "owner" | "sales_head" | "ecofy" | "epc"; done?: boolean };

export function stepBrief(i: StepBriefInput): StepBrief {
    return resolveParty(i, draft(i));
}

function draft(i: StepBriefInput): Draft {
    const f = i.facts;
    const sub = i.subStatus ?? "";
    const ecofyLender = isEcofyFinancier(i.financierName);
    const lender = ecofyLender ? "Ecofy" : i.financierName ?? "the financier";

    switch (i.stage) {
        case "S0":
            return {
                who: "ecofy",
                title: "Ecofy is qualifying the lead",
                detail: "Ecofy sets the temperature. Nothing to do in the CRM until it comes back.",
                next: "Hot leads land in the pickup queue (S1) automatically; Warm ones when Ecofy pushes them.",
                primary: "none",
            };

        case "S1":
            return {
                who: "sales_head",
                title: "Assign to an ASM or ISR",
                detail: "New in the pickup queue. Assigning moves it to follow-up (S2) in Ecofy; or return it to Ecofy with a reason.",
                next: "Follow-up (S2): the owner calls the customer and books a meeting.",
                primary: "assign",
            };

        case "S2": {
            const next = "Assessment (S3) — record the sizing once a meeting or EPC visit is completed.";
            if (f.completedMeeting) {
                return {
                    who: "owner",
                    title: "Advance to assessment",
                    detail: "A meeting is completed, so the gate to S3 is met.",
                    next,
                    gate: "Gate met: at least one completed meeting or EPC visit.",
                    primary: "advance",
                };
            }
            if (f.scheduledMeeting) {
                return {
                    who: "owner",
                    title: "Complete the scheduled meeting",
                    detail: "After the meeting, mark it completed with the actual time and remarks (or no-show / reschedule).",
                    next,
                    gate: "Gate to S3: one completed meeting or EPC visit.",
                    primary: "complete_meeting",
                };
            }
            return {
                who: "owner",
                title: "Call the customer and book a meeting",
                detail: "Log the call, then book a phone / video / site meeting or an EPC visit.",
                next,
                gate: "Gate to S3: one completed meeting or EPC visit.",
                primary: "book_meeting",
            };
        }

        case "S3": {
            const next = "Offer (S4) — eligibility with the financier, then the EPC quote and the customer OTP.";
            if (f.latestAssessment && !f.latestAssessment.confirmed) {
                return {
                    who: "owner",
                    title: "Confirm the assessment",
                    detail: "The latest assessment is saved but not confirmed. Confirming moves the lead to the offer stage.",
                    next,
                    primary: "confirm_assessment",
                };
            }
            return {
                who: "owner",
                title: "Record the assessment",
                detail: "Size the system (calculator, manual or EPC) and save it; then confirm it.",
                next,
                gate: "Gate to S4: one confirmed assessment.",
                primary: "new_assessment",
            };
        }

        case "S4": {
            if (sub === "NOT_ELIGIBLE") {
                return {
                    who: "sales_head",
                    title: `Not eligible with ${lender} — route to the next financier`,
                    detail: "Pick another financier and note why; eligibility is then requested from them.",
                    next: "Eligibility with the next financier, then EPC quote → offer → OTP.",
                    primary: "route_financier",
                };
            }
            if (sub === "QUOTE_PENDING") {
                return {
                    who: "owner",
                    title: "Upload the EPC quote (PDF)",
                    detail: "Eligible. Upload the EPC partner's quote with its prices; it becomes the ACTIVE quote.",
                    next: "Compose the offer from the ACTIVE quote, then send the customer OTP (S5).",
                    primary: "upload_quote",
                };
            }
            if (sub === "OFFER_READY") {
                if (f.liveOffer) {
                    return {
                        who: "owner",
                        title: "Send the offer — SMS OTP to the customer",
                        detail: "The offer is composed. Sending it texts the customer a 6-digit OTP and moves the lead to S5.",
                        next: "File (S5): enter the customer's OTP to lock the File.",
                        primary: "send_otp",
                    };
                }
                if (f.activeQuote) {
                    return {
                        who: "owner",
                        title: "Compose the offer from the ACTIVE quote",
                        detail: "Eligibility and quote are in. Compose the offer (no EMI, no price override).",
                        next: "Send the offer → customer OTP (S5).",
                        primary: "compose_offer",
                    };
                }
                return {
                    who: "owner",
                    title: "Upload the EPC quote (PDF)",
                    detail: "Eligible, but no ACTIVE quote yet. Upload the EPC partner's quote.",
                    next: "Compose the offer, then send the customer OTP (S5).",
                    primary: "upload_quote",
                };
            }
            // ELIGIBILITY_PENDING (also the entry sub-status of S4, before anyone asked)
            if (f.eligibilitySent) {
                return {
                    who: ecofyLender ? "ecofy" : "sales_head",
                    title: `Waiting for ${lender}'s eligibility decision`,
                    detail: ecofyLender
                        ? "Sent for eligibility. Ecofy answers from its eligibility queue; callers only ever see within / above limit."
                        : `Sent for eligibility. The Sales Head records ${lender}'s answer from the Eligibility queue.`,
                    next: "Once eligible: EPC quote → offer → customer OTP (S5).",
                    primary: "await_eligibility",
                };
            }
            return {
                who: "owner",
                title: "Send for eligibility",
                detail: `Ask ${lender} whether the customer is eligible. The quote and offer follow.`,
                next: `${lender} answers; then EPC quote → offer → customer OTP (S5).`,
                primary: "send_eligibility",
            };
        }

        case "S5":
            return {
                who: "owner",
                title: "Enter the customer's OTP",
                detail: "The offer went out by SMS. Type the 6-digit code the customer reads out; on success the File is created and locked.",
                next: "Financing (S6) with the financier — the File goes for a decision.",
                gate: "OTP: 6 digits · 5 attempts · 10 minutes. Resend if it expired.",
                primary: "verify_otp",
            };

        case "S6": {
            if (sub === "REACCEPTANCE_PENDING") {
                return {
                    who: f.reacceptanceLive ? "owner" : "ecofy",
                    title: "Re-acceptance OTP — sanction below the accepted total",
                    detail: f.reacceptanceLive
                        ? "Ecofy sent the customer an OTP with the revised amounts. Enter the code the customer reads out."
                        : "Ecofy triggers the re-acceptance OTP from the case's Financing tab; the code is entered here once it is live.",
                    next: "Revised terms confirmed → Installation (S7).",
                    primary: "verify_reacceptance",
                };
            }
            if (sub === "REJECTED_ROUTING") {
                return {
                    who: "sales_head",
                    title: `Rejected by ${lender} — route to the next financier`,
                    detail: "Pick another financier and note why, or close as rejected by all financiers.",
                    next: "The next financier decides; a sanction moves the lead to Installation (S7).",
                    primary: "route_financier",
                };
            }
            return {
                who: ecofyLender ? "ecofy" : "sales_head",
                title: `File locked — waiting for ${lender}'s decision`,
                detail: ecofyLender
                    ? "Ecofy records the sanction or rejection. Installation may be created in parallel (with a warning while no sanction is recorded)."
                    : `The Sales Head records ${lender}'s sanction or rejection. Installation may be created in parallel.`,
                next: "Sanction → Installation (S7). A lower sanction → re-acceptance OTP. Rejection → next financier.",
                primary: i.viewerKind === "manager" && f.openDecision ? "financing_decision" : "await_decision",
            };
        }

        case "S7": {
            const inst = f.installation ?? null;
            if (!inst) {
                return {
                    who: "owner",
                    title: "Create the installation",
                    detail: "Sanction recorded. Pick the EPC partner who installs and, if known, the scheduled date.",
                    next: "EPC installs; upload photos and the acceptance letter, mark INSTALLED, then the disbursement (S8).",
                    primary: "create_installation",
                };
            }
            if (inst.status === "INSTALLED" || inst.status === "COMMISSIONED") {
                return {
                    who: ecofyLender ? "ecofy" : "sales_head",
                    title: "Installed — record the disbursement",
                    detail: ecofyLender
                        ? "Ecofy records the down payment and the disbursement; that moves the lead to Asset (S8)."
                        : "The Sales Head records the down payment and the disbursement; that moves the lead to Asset (S8).",
                    next: "Asset (S8): EMI status and asset events are recorded by Ecofy.",
                    gate: f.downPaymentRecorded === false ? "Down payment not recorded yet." : undefined,
                    primary: "disbursement",
                };
            }
            const photos = f.photos ?? 0;
            const letters = f.letters ?? 0;
            return {
                who: "epc",
                title: `Installation ${inst.status.replace(/_/g, " ").toLowerCase()} — record progress`,
                detail: "The EPC partner installs. Update the status here as it progresses.",
                next: "INSTALLED → disbursement → Asset (S8).",
                gate:
                    photos >= 1 && letters >= 1
                        ? "Proof uploaded: installation photo and customer acceptance letter."
                        : `Before INSTALLED, upload ${photos < 1 ? "an installation photo" : ""}${photos < 1 && letters < 1 ? " and " : ""}${letters < 1 ? "the customer acceptance letter" : ""}.`,
                primary: "installation_progress",
            };
        }

        case "S8":
            return {
                who: "ecofy",
                done: true,
                title: "Asset active — disbursed",
                detail: "EMI status, buyback and redeployment are recorded by Ecofy. After-sales stays outside the platform.",
                next: "Nothing further in the CRM.",
                primary: "none",
            };

        case "CLOSED":
            return {
                who: "sales_head",
                done: true,
                title: "Closed",
                detail: "The case is closed. It can be reopened at S0 with Ecofy unless it reached a File.",
                next: "Reopen → Ecofy re-qualifies (S0).",
                primary: i.viewerKind === "manager" ? "reopen" : "none",
            };

        default:
            return {
                who: "ecofy",
                title: "Waiting for Ecofy",
                detail: "The stage is not known yet.",
                next: "—",
                primary: "none",
            };
    }
}

function resolveParty(i: StepBriefInput, d: Draft): StepBrief {
    const manager = i.viewerKind === "manager";
    const roleLabel = i.assigneeRole ? ECOFY_ROLE_LABEL[i.assigneeRole] ?? i.assigneeRole : null;
    const withOwner = i.assigneeName ? `With ${i.assigneeName}${roleLabel ? ` (${roleLabel})` : ""}` : null;
    const base = { title: d.title, detail: d.detail, next: d.next, gate: d.gate, primary: d.primary };

    if (d.done) {
        return { ...base, party: d.who === "ecofy" ? "ecofy" : "sales_head", partyLabel: d.who === "ecofy" ? "Done — with Ecofy" : "Closed", tone: "done" };
    }

    switch (d.who) {
        case "owner":
            if (i.viewerIsAssignee) return { ...base, party: "you", partyLabel: "Your action", tone: "action" };
            if (manager) {
                return withOwner
                    ? { ...base, party: "owner", partyLabel: `${withOwner} · you can also act`, tone: "action" }
                    : { ...base, party: "you", partyLabel: "Your action · no owner yet", tone: "action" };
            }
            return { ...base, party: "owner", partyLabel: withOwner ?? "Pending from Sales Head", tone: "waiting" };

        case "sales_head":
            return manager
                ? { ...base, party: "you", partyLabel: "Your action", tone: "action" }
                : { ...base, party: "sales_head", partyLabel: "Pending from Sales Head", tone: "waiting" };

        case "ecofy":
            // A manager may still record on Ecofy's behalf (the form stays), but the ball is with Ecofy.
            return { ...base, party: "ecofy", partyLabel: "Pending from Ecofy", tone: "waiting" };

        case "epc":
            return {
                ...base,
                party: "epc",
                partyLabel: manager || i.viewerIsAssignee ? "With the EPC partner · you record progress" : "With the EPC partner",
                tone: manager || i.viewerIsAssignee ? "action" : "waiting",
            };
    }
}

/** The lead reads (`ECOFY_LEAD_READS`) the card needs to build the facts for a stage. */
export function factsNeededFor(stage: string | null): string[] {
    switch (stage) {
        case "S2":
            return ["appointments"];
        case "S3":
            return ["assessments"];
        case "S4":
            return ["assessments", "quotes", "offers", "timeline"];
        case "S5":
            return ["offers"];
        case "S6":
            return ["decisions", "offers", "installation"];
        case "S7":
            return ["installation", "documents", "payment-status"];
        default:
            return [];
    }
}

/** Derive "sent and not yet decided" from Ecofy timeline items (ascending or not). */
export function eligibilitySentFromTimeline(items: Array<{ at: string; kind: string }> | null | undefined): boolean {
    if (!items?.length) return false;
    let lastRequested = 0;
    let lastDecided = 0;
    for (const it of items) {
        const t = new Date(it.at).getTime();
        if (!Number.isFinite(t)) continue;
        if (it.kind === "eligibility.requested") lastRequested = Math.max(lastRequested, t);
        if (it.kind === "eligibility.decided") lastDecided = Math.max(lastDecided, t);
    }
    return lastRequested > 0 && lastRequested >= lastDecided;
}
