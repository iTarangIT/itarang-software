// Inbound on the Vobiz number (Priya KPI tracker task 9) — the pure half.
//
// A dealer rings the number Priya called him from. The callback agent answers
// with what the CRM knows about him, in one of the tracker's branches:
//
//   confirm_slot  an ISR owes him a call at a time still ahead — confirm the
//                 slot, or do it now if he wants
//   do_it_now     the promised time has passed, or he spoke to Priya and has
//                 no callback booked — he is ready now
//   warm_opener   Priya dialled him but there was no conversation — the warm
//                 opener (this time HE called)
//   complaint     an open complaint, or his last call was one — no pitch, take
//                 it to Nidhi
//   unknown       the number matches no lead
//
// The first message must not need owner_name (the callback agent's opener
// names the shop or nobody), so it is never sent.
//
// Pure: no database, no clock of its own. The I/O is in inbound.ts.

export type InboundBranch = "confirm_slot" | "do_it_now" | "warm_opener" | "complaint" | "unknown";

export type InboundMatch = {
    lead: {
        id: string;
        shopName: string | null;
        dealerName: string | null;
        language: string | null;
        city: string | null;
    } | null;
    openCallback: {
        id: string;
        kind: string | null;
        dueAt: Date;
        timeNotSet: boolean;
        assignedName: string | null;
        requestedText: string | null;
    } | null;
    /** The lead's latest OUTBOUND dial verdict (ai_dial_dispositions). */
    lastOutcome: { l1: string; l2: string; l3: string | null; at: Date } | null;
};

export function inboundBranch(m: InboundMatch, now: Date): InboundBranch {
    if (!m.lead) return "unknown";
    const cb = m.openCallback;
    if (cb?.kind === "complaint" || m.lastOutcome?.l3 === "Bad Experience with Trontek") return "complaint";
    if (cb) {
        if (cb.timeNotSet) return "do_it_now";
        return cb.dueAt.getTime() > now.getTime() ? "confirm_slot" : "do_it_now";
    }
    const last = m.lastOutcome;
    const spoke = last != null && last.l1 === "Connected" && last.l2 !== "Machine";
    return spoke ? "do_it_now" : "warm_opener";
}

/** "Thu 6 Nov, 5:00 pm" in IST. */
function istSlot(t: Date): string {
    return t.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
    });
}

/**
 * The conversation-initiation dynamic variables. Every key is always present
 * (empty when unknown) so the agent prompt can read them unconditionally.
 */
export function inboundDynamicVariables(
    m: InboundMatch,
    callerPhone: string,
    now: Date,
): Record<string, string> {
    const branch = inboundBranch(m, now);
    const cb = m.openCallback;
    return {
        inbound: "1",
        inbound_branch: branch,
        lead_id: m.lead?.id ?? "",
        phone_number: callerPhone,
        shop_name: m.lead?.shopName?.trim() || "",
        location: m.lead?.city?.trim() || "",
        language: m.lead?.language?.trim() || "",
        callback_slot_text: cb && !cb.timeNotSet ? istSlot(cb.dueAt) : "",
        callback_time_set: cb ? (cb.timeNotSet ? "0" : "1") : "",
        isr_name: cb?.assignedName?.trim() || "",
        last_outcome: m.lastOutcome ? (m.lastOutcome.l3 ?? m.lastOutcome.l2) : "",
        // Keys the outbound prompt reads; harmless on the callback agent.
        owner_name: "",
        is_probe: "0",
    };
}

/** Last ten digits of a caller id ("+91 99710 27907", "09971027907", "9971027907"). */
export function callerKey(raw: string | null | undefined): string | null {
    const digits = (raw ?? "").replace(/\D/g, "");
    return digits.length >= 10 ? digits.slice(-10) : null;
}

export type InboundFollowUp =
    /** Nobody spoke, or the call failed: an ISR returns it within 10 minutes. */
    | { kind: "return_call"; dueAt: Date }
    /** A complaint: to Nidhi, no pitch. */
    | { kind: "complaint" }
    /** The dealer agreed a (new) time. */
    | { kind: "rebook"; dueAt: Date }
    /** The dealer confirmed the slot he already has. */
    | { kind: "confirmed" }
    /** He talked and wants the ISR now: the callback is due in 10 minutes. */
    | { kind: "call_now"; dueAt: Date };

/** An unanswered inbound must be returned within this. */
export const INBOUND_RETURN_MS = 10 * 60_000;

/**
 * What the CRM does after an inbound call ends. `answered` = the dealer spoke;
 * `agreedAt` = a time he agreed on this call (callbackDueDetail, only when set).
 */
export function inboundFollowUp(input: {
    branch: InboundBranch;
    answered: boolean;
    callResult: string | null;
    callbackAgreed: boolean | null;
    agreedAt: Date | null;
    now: Date;
}): InboundFollowUp {
    const returnBy = new Date(input.now.getTime() + INBOUND_RETURN_MS);
    if (!input.answered) return { kind: "return_call", dueAt: returnBy };
    if (input.branch === "complaint" || input.callResult === "complaint") return { kind: "complaint" };
    if (input.agreedAt && input.agreedAt.getTime() > input.now.getTime()) {
        return { kind: "rebook", dueAt: input.agreedAt };
    }
    if (input.branch === "confirm_slot" && input.callbackAgreed === true) return { kind: "confirmed" };
    return { kind: "call_now", dueAt: returnBy };
}
