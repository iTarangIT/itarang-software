// S3 status rules — the ONE forward-only check every lead status write goes
// through (tracker ID 115, handover P0-11). Pure and client-safe: writeTouchpoint
// enforces it server-side for every entry point (web forms, APIs, WhatsApp
// Assistant, NeoDove, AI dialer, admin and bulk tools); screens may import it to
// hide moves that would be refused.
//
//   progress      an ordinary touchpoint (call, visit, follow-up). Moves an OPEN
//                 lead FORWARD only; never to Transferred_to_ASM, Converted or
//                 Lost, which have their own events.
//   transfer      Transfer to ASM — only from an open stage.
//   mark_won      the rep's Mark Won (GSTIN enforced by its writer) — from an
//                 open stage before Won (ID 74).
//   onboarding_approved
//                 the admin approving the dealer's onboarding sets Converted —
//                 from Won, or from any open stage for a lead that was never
//                 marked Won (direct onboardings, legacy rows).
//   mark_lost     the Mark Lost action (reason enforced by its writer) — from
//                 any open stage before Won. Won → Lost only with
//                 `adminOverride` (the admin onboarding drop-out resolution,
//                 ID 115.4 / 74.5): a rep cannot un-win a dealer.
//   visit         an ASM visit DONE, or "Visit not needed" with a reason — the
//                 only events that end Transferred_to_ASM ("Awaiting field
//                 visit", ID 77). Otherwise a forward move like progress.
//   quote_approved
//                 the dealer approved the quote (quoteStatus.ts) — sets
//                 Commercials_Finalised, forward only, and is the one event
//                 besides a visit that ends Transferred_to_ASM (ID 77 option
//                 A, 1 Oct): the lead moves at once and the ASM visit stays
//                 scheduled.
//   quote_withdrawn
//                 Withdraw quote (ID 78): a lead at Commercials explained or
//                 Awaiting customer decision goes back to Under_Discussion - the
//                 one backward move an event may make. NOT from Commercials
//                 finalised: the dealer said yes, and only Mark Won / Mark Lost
//                 leave that stage.
//   quote_rejected
//                 the CEO rejected a quote and no other version is approved or
//                 waiting for him (ID 135): the same backward move, and from
//                 the same two stages only, as quote_withdrawn.
//   reactivation  a closed lead re-enters the pipeline at New_Unassigned or
//                 Assigned_Not_Contacted (BRD §0.9 reactivation, drop-out re-engage).
//   dropout_lost  admin drop-out resolution: Converted → Lost.
//   won_undone    Undo Mark Won (ID 134): the Sales Head reverses a Won marked
//                 by mistake, before the dealer submitted onboarding. Won goes
//                 back to the open stage it came from — never to Won,
//                 Converted or Lost — with a reason. wonUndo.ts checks the
//                 onboarding and picks the stage from the status history.
//   correction    a SYSTEM move with a reason — assignOwner restoring a
//                 pre-transfer stage, logged one-time scripts. Since 9 Oct
//                 (ID 136) no screen, API or WhatsApp tool lets a person pick a
//                 status: "Correct status" is gone.
//
// A status equal to the current one is a no-op for every event (ID 115.6): the
// verdict is ok with `noop: true`, and the writer records the touchpoint but
// skips the move — two reps logging the same move a second apart must not see
// a 409 for a change that has, in fact, happened.

import type { LeadStatus } from "@/lib/lifecycle/transitions";

export const STATUS_EVENTS = [
    "progress",
    "transfer",
    "mark_won",
    "onboarding_approved",
    "mark_lost",
    "reactivation",
    "dropout_lost",
    "visit",
    "quote_approved",
    "quote_withdrawn",
    "quote_rejected",
    "won_undone",
    "correction",
] as const;
export type StatusEvent = (typeof STATUS_EVENTS)[number];

/**
 * How far along the funnel an open status is. Transferred_to_ASM sits just below
 * Under_Discussion so the ASM's first real conversation still moves it forward.
 * A quote awaiting the dealer's decision comes before commercials finalised.
 * Kept in step with autoProgress.ts.
 */
export const STATUS_RANK: Readonly<Partial<Record<LeadStatus, number>>> = {
    New_Unassigned: 0,
    Assigned_Not_Contacted: 1,
    Transferred_to_ASM: 1.5,
    Under_Discussion: 2,
    Commercials_Explained: 3,
    Awaiting_Customer_Decision: 4,
    Commercials_Finalised: 5,
    Won: 6,
};

const CLOSED = new Set<string>(["Converted", "Lost"]);
const REOPEN_TARGETS = new Set<string>(["New_Unassigned", "Assigned_Not_Contacted"]);

export type StatusGuardVerdict =
    | { ok: true; noop?: true }
    | { ok: false; reason: string };

/** Rank of a stored status; null / legacy values count as the start of the funnel. */
export function rankOf(status: string | null): number | null {
    if (status == null) return 0;
    if (CLOSED.has(status)) return null;
    return STATUS_RANK[status as LeadStatus] ?? 0;
}

/** True when `to` is further along the funnel than `from` (both open). */
export function isForward(from: string | null, to: LeadStatus): boolean {
    const a = rankOf(from);
    const b = STATUS_RANK[to];
    return a !== null && b !== undefined && b > a;
}

const label = (s: string | null) => (s ?? "no status").replace(/_/g, " ");

export function checkStatusMove(input: {
    from: string | null;
    to: LeadStatus;
    event: StatusEvent;
    /** Required for `correction` and `won_undone`. */
    reason?: string | null;
    /**
     * An admin-driven move (the onboarding drop-out resolution). Only `mark_lost`
     * reads it: Won → Lost is refused without it.
     */
    adminOverride?: boolean;
}): StatusGuardVerdict {
    const { from, to, event } = input;
    const open = from == null || !CLOSED.has(from);
    if (from === to) return { ok: true, noop: true };

    switch (event) {
        case "progress":
            if (!open) return { ok: false, reason: `The lead is ${label(from)}; it is closed.` };
            if (from === "Transferred_to_ASM") {
                return { ok: false, reason: "Only a visit, or 'Visit not needed' with a reason, ends Awaiting field visit." };
            }
            if (to === "Transferred_to_ASM") return { ok: false, reason: "Use Transfer to ASM." };
            if (to === "Won") return { ok: false, reason: "Use Mark Won." };
            if (to === "Converted") return { ok: false, reason: "Converted is set when the dealer's onboarding is approved." };
            if (to === "Lost") return { ok: false, reason: "Use Mark Lost." };
            if (!isForward(from, to)) {
                return { ok: false, reason: `A lead cannot move back from ${label(from)} to ${label(to)}.` };
            }
            return { ok: true };
        case "transfer":
            if (to !== "Transferred_to_ASM") return { ok: false, reason: "A transfer can only move to Transferred to ASM." };
            if (!open || from === "Won") return { ok: false, reason: `A ${label(from)} lead cannot be transferred.` };
            return { ok: true };
        case "mark_won":
            if (to !== "Won") return { ok: false, reason: "Mark Won can only set Won." };
            if (!open) return { ok: false, reason: `The lead is already ${label(from)}.` };
            return { ok: true };
        case "onboarding_approved":
            if (to !== "Converted") return { ok: false, reason: "Onboarding approval can only set Converted." };
            if (!open) return { ok: false, reason: `The lead is already ${label(from)}.` };
            return { ok: true };
        case "mark_lost":
            if (to !== "Lost") return { ok: false, reason: "Mark Lost can only set Lost." };
            if (!open) return { ok: false, reason: `The lead is already ${label(from)}.` };
            if (from === "Won" && !input.adminOverride) {
                return { ok: false, reason: "A Won lead can only be marked Lost by an admin, through the onboarding drop-out review." };
            }
            return { ok: true };
        case "visit":
            if (!open) return { ok: false, reason: `The lead is ${label(from)}; it is closed.` };
            if (to === "Transferred_to_ASM" || to === "Won" || to === "Converted" || to === "Lost") {
                return { ok: false, reason: `A visit cannot set ${label(to)}.` };
            }
            if (!isForward(from, to)) {
                return { ok: false, reason: `A lead cannot move back from ${label(from)} to ${label(to)}.` };
            }
            return { ok: true };
        case "quote_approved":
            if (to !== "Commercials_Finalised") return { ok: false, reason: "A dealer approval can only set Commercials finalised." };
            if (!open) return { ok: false, reason: `The lead is ${label(from)}; it is closed.` };
            if (from !== "Transferred_to_ASM" && !isForward(from, to)) {
                return { ok: false, reason: `A lead cannot move back from ${label(from)} to ${label(to)}.` };
            }
            return { ok: true };
        case "quote_withdrawn":
        case "quote_rejected": {
            if (from === "Commercials_Finalised") {
                return { ok: false, reason: "The dealer approved the quote; from Commercials finalised use Mark Won or Mark Lost." };
            }
            const commercials = ["Commercials_Explained", "Awaiting_Customer_Decision"];
            if (to !== "Under_Discussion" || !commercials.includes(from ?? "")) {
                const what = event === "quote_rejected" ? "Rejecting" : "Withdrawing";
                return { ok: false, reason: `${what} a quote moves a commercials-stage lead back to Under discussion only.` };
            }
            return { ok: true };
        }
        case "reactivation":
            // Won is open, but an onboarding that fell through re-engages the
            // dealer from the start (drop-out "re-engage", ID 84) — the one
            // open status a reactivation may leave.
            if (open && from !== "Won") return { ok: false, reason: "Only a closed or Won lead can be reactivated." };
            if (!REOPEN_TARGETS.has(to)) return { ok: false, reason: "A reactivated lead restarts at New or Assigned." };
            return { ok: true };
        case "dropout_lost":
            if (from !== "Converted" || to !== "Lost") {
                return { ok: false, reason: "Drop-out resolution moves Converted to Lost only." };
            }
            return { ok: true };
        case "won_undone":
            if (from !== "Won") return { ok: false, reason: "Only a Won lead can have its Mark Won undone." };
            if (!input.reason || !input.reason.trim()) return { ok: false, reason: "Undo Mark Won needs a reason." };
            if (to === "Converted" || to === "Lost") {
                return { ok: false, reason: `Undo Mark Won returns the lead to an open stage, not ${label(to)}.` };
            }
            return { ok: true };
        case "correction":
            if (!input.reason || !input.reason.trim()) {
                return { ok: false, reason: "A status correction needs a reason." };
            }
            // ID 133 (business rule, 3 Oct): every onboarding goes the same
            // path. A correction to Converted skipped documents, verification,
            // agreement and approval; to Won it skipped Mark Won's checks.
            if (to === "Converted") {
                return { ok: false, reason: "Converted is set when the dealer's onboarding is approved." };
            }
            if (to === "Won") return { ok: false, reason: "Use Mark Won." };
            return { ok: true };
    }
}
