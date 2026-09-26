// The Assistant's closed vocabulary — BRD §9.3, frozen on Day 1 (Gate 1).
//
// The model maps a rep's words to a disposition from the CC sheet
// (src/lib/leads/dispositions.ts); THIS map decides which status, lost reason
// and extras may be PROPOSED for it. A combination the map does not list is
// never guessed: checkCallProposal / checkVisitProposal return a question for
// the model to put to the rep instead.
//
// Nothing here is new vocabulary. Every label, status, lost reason and visit
// outcome is a member of an existing enum — the test suite asserts it — so the
// map can only narrow what the screens already allow, never widen it.
//
// Hinglish aliases live HERE, not in dispositions.ts ALIASES: that table also
// classifies NeoDove's inbound webhook, and a phrase a rep types on WhatsApp is
// not something the calling vendor's settings will ever send. They are hints
// for the model and the prompt, never a write path on their own.

import {
    CONNECTED_DISPOSITIONS,
    NOT_CONNECTED_REASONS,
    type DispositionBucket,
} from "@/lib/leads/dispositions";
import type { LeadStatus, LostReason } from "@/lib/lifecycle/transitions";
import type { VisitOutcome } from "@/lib/asm/types";

/** "Leave the status as it is" — distinct from a status the rep never mentioned. */
export const NO_CHANGE = "no_change" as const;
export type StatusChoice = LeadStatus | typeof NO_CHANGE;

type StatusRule = {
    /** What may be proposed. */
    options: readonly StatusChoice[];
    /** Rep did not say: default to no change, or ask. */
    whenUnstated: "no_change" | "ask";
    /** Question to ask when the rep's words don't settle it. */
    question: string;
};

export type CallVocabRow = {
    id: string;
    /** The rep's words, as the BRD table has them (for the prompt). */
    said: string;
    connect: "connected" | "not_connected";
    /** Sheet labels this row may be logged with. */
    labels: readonly string[];
    /** Buckets allowed for a connected label; `ask` = the rep must say which. */
    buckets: readonly DispositionBucket[] | null;
    askBucket: boolean;
    status: StatusRule;
    /** Lost reason per label when the status is Lost. */
    lostReasonByLabel: Readonly<Record<string, readonly LostReason[]>>;
    /** Interest level proposed with this row, if any. */
    interest: "hot" | null;
    /** BRD "Proposed extra", for the prompt. */
    extra: string;
};

export type VisitVocabRow = {
    id: string;
    said: string;
    outcomes: readonly VisitOutcome[];
    /** Per outcome: what may be proposed. */
    statusByOutcome: Readonly<Record<string, StatusRule>>;
    lostReasons: readonly LostReason[];
    extra: string;
};

function deepFreeze<T>(o: T): T {
    if (o && typeof o === "object") {
        Object.freeze(o);
        for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    }
    return o;
}

// ── Calls (BRD §9.3 rows 1–6) ───────────────────────────────────────────────

export const CALL_VOCAB: readonly CallVocabRow[] = deepFreeze<CallVocabRow[]>([
    {
        id: "not_connected",
        said: "didn't pick, switched off, busy, wrong number",
        connect: "not_connected",
        labels: NOT_CONNECTED_REASONS,
        buckets: null,
        askBucket: false,
        status: { options: [NO_CHANGE], whenUnstated: "no_change", question: "" },
        lostReasonByLabel: {},
        interest: null,
        extra: "Follow-up if a time was given",
    },
    {
        id: "call_back",
        said: "call back later, needs time, shared details, meeting fixed",
        connect: "connected",
        labels: ["As to Call Back", "Need Some Time", "Details Shared", "Information Collected", "Meeting Scheduled"],
        buckets: ["Cold", "Warm"],
        askBucket: false,
        status: { options: ["Under_Discussion"], whenUnstated: "no_change", question: "" },
        lostReasonByLabel: {},
        interest: null,
        extra: "Follow-up date",
    },
    {
        id: "commercials_explained",
        said: "explained commercials, gave the price",
        connect: "connected",
        labels: ["Commercials Explained"],
        buckets: ["Warm", "Hot"],
        askBucket: true,
        status: { options: ["Commercials_Explained"], whenUnstated: "no_change", question: "" },
        lostReasonByLabel: {},
        interest: null,
        extra: "Ask temperature (warm or hot) if not stated",
    },
    {
        id: "price_high",
        said: "price too high (still talking / not interested)",
        connect: "connected",
        labels: ["Price High"],
        buckets: ["Warm"],
        askBucket: false,
        status: {
            options: ["Awaiting_Customer_Decision", "Lost"],
            whenUnstated: "ask",
            question: "Is the dealer still considering it, or not interested at all (mark Lost — price too high)?",
        },
        lostReasonByLabel: { "Price High": ["price_high"] },
        interest: null,
        extra: "Follow-up / Mark Lost preview",
    },
    {
        id: "quote_negotiation",
        said: "quote sent, negotiating, deal final",
        connect: "connected",
        labels: ["Quotation Sent", "Under Negotiation", "Commercials Finalised"],
        buckets: ["Hot"],
        askBucket: false,
        status: {
            options: ["Awaiting_Customer_Decision", "Commercials_Finalised"],
            whenUnstated: "no_change",
            question: "",
        },
        lostReasonByLabel: {},
        interest: "hot",
        extra: "Interest hot; link to Transfer or Mark Converted",
    },
    {
        id: "lost",
        said: "not interested; went elsewhere; shop closed",
        connect: "connected",
        labels: ["Not Interested", "Lost to Competition", "Business Closed"],
        buckets: ["Lost"],
        askBucket: false,
        status: {
            options: ["Lost"],
            whenUnstated: "ask",
            question: "Should I mark this lead Lost?",
        },
        lostReasonByLabel: {
            "Not Interested": ["not_interested"],
            "Lost to Competition": ["other"],
            "Business Closed": ["business_closed"],
        },
        interest: null,
        extra: "Mark Lost preview; high-impact confirm for closed",
    },
]);

// ── Visits (BRD §9.3 rows 7–8, ASM only) ────────────────────────────────────

export const VISIT_VOCAB: readonly VisitVocabRow[] = deepFreeze<VisitVocabRow[]>([
    {
        id: "visit_progress",
        said: "ASM: productive visit; commercials progressed",
        outcomes: ["productive", "commercials_progressed"],
        statusByOutcome: {
            productive: { options: [NO_CHANGE], whenUnstated: "no_change", question: "" },
            commercials_progressed: {
                options: ["Commercials_Explained", "Commercials_Finalised"],
                whenUnstated: "ask",
                question: "Were the commercials explained, or finalised?",
            },
        },
        lostReasons: [],
        extra: "Interest as stated; next visit date",
    },
    {
        id: "visit_no_progress",
        said: "ASM: dealer not there; dealer not interested",
        outcomes: ["dealer_not_present", "dealer_uninterested"],
        statusByOutcome: {
            dealer_not_present: { options: [NO_CHANGE], whenUnstated: "no_change", question: "" },
            dealer_uninterested: {
                options: [NO_CHANGE, "Lost"],
                whenUnstated: "ask",
                question: "Keep the lead open, or mark it Lost?",
            },
        },
        lostReasons: ["not_interested", "other"],
        extra: "Reschedule: next visit date",
    },
]);

// ── Hinglish aliases (Roman script) → sheet label or visit outcome ──────────
// Checked against 30 real call notes in Gate 6 (BRD §9.3 / Day 6).

export const HINGLISH_CALL_ALIASES: Readonly<Record<string, string>> = deepFreeze({
    "nahi uthaya": "Did not pick",
    "phone nahi uthaya": "Did not pick",
    "uthaya nahi": "Did not pick",
    "switch off tha": "Switch off",
    "phone band tha": "Switch off",
    "busy tha": "Busy in another call",
    "galat number": "Incorrect / Invalid number",
    "baad mein call karo": "As to Call Back",
    "baad me call karna": "As to Call Back",
    "call back karna": "As to Call Back",
    "time chahiye": "Need Some Time",
    "soch ke batayenge": "Need Some Time",
    "details bhej di": "Details Shared",
    "details share kar di": "Details Shared",
    "meeting fix": "Meeting Scheduled",
    "rate bata diya": "Commercials Explained",
    "price bata diya": "Commercials Explained",
    "rate zyada hai": "Price High",
    "price zyada hai": "Price High",
    "mehenga hai": "Price High",
    "quotation bhej diya": "Quotation Sent",
    "negotiation chal raha hai": "Under Negotiation",
    "deal final": "Commercials Finalised",
    "interest nahi hai": "Not Interested",
    "nahi chahiye": "Not Interested",
    "mana kar diya": "Not Interested",
    "dusri company se le liya": "Lost to Competition",
    "competitor se le liya": "Lost to Competition",
    "dukaan band": "Business Closed",
    "dhandha band": "Business Closed",
});

export const HINGLISH_VISIT_ALIASES: Readonly<Record<string, VisitOutcome>> = deepFreeze({
    "achhi meeting": "productive",
    "mil ke aaya": "productive",
    "rate pe baat hui": "commercials_progressed",
    "dealer nahi mila": "dealer_not_present",
    "dukaan pe nahi tha": "dealer_not_present",
    "dealer ko interest nahi": "dealer_uninterested",
});

// ── Checks the write tools run at their boundary ────────────────────────────

export type ProposalCheck =
    | { ok: true; status: StatusChoice; lostReason: LostReason | null; interest: "hot" | null }
    | { ok: false; question: string };

const ask = (question: string): ProposalCheck => ({ ok: false, question });

function settleStatus(
    rule: StatusRule,
    status: StatusChoice | undefined,
): { ok: true; status: StatusChoice } | { ok: false; question: string } {
    if (status === undefined) {
        return rule.whenUnstated === "ask"
            ? { ok: false, question: rule.question }
            : { ok: true, status: NO_CHANGE };
    }
    if (status === NO_CHANGE && rule.whenUnstated === "no_change") return { ok: true, status };
    if (!rule.options.includes(status)) {
        return {
            ok: false,
            question: rule.question || "That status doesn't fit what was said. What should the lead's status be?",
        };
    }
    return { ok: true, status };
}

/** The §9.3 row a sheet label belongs to, if any. */
export function callRowFor(label: string, connect: "connected" | "not_connected"): CallVocabRow | null {
    return CALL_VOCAB.find((r) => r.connect === connect && r.labels.includes(label)) ?? null;
}

/**
 * May this call be proposed as described? `status` undefined = the rep did not
 * say; `lostReason` only matters when the status is Lost.
 */
export function checkCallProposal(input: {
    label: string;
    connect: "connected" | "not_connected";
    bucket?: DispositionBucket | null;
    status?: StatusChoice;
    lostReason?: LostReason | null;
}): ProposalCheck {
    const row = callRowFor(input.label, input.connect);
    if (!row) {
        return ask("I couldn't match that to a call outcome. What happened on the call?");
    }
    if (row.buckets) {
        if (!input.bucket) {
            if (row.askBucket) return ask("Is the dealer warm or hot?");
        } else if (
            !row.buckets.includes(input.bucket) ||
            !CONNECTED_DISPOSITIONS[input.bucket].includes(input.label)
        ) {
            return ask(`Is the dealer ${row.buckets.map((b) => b.toLowerCase()).join(" or ")}?`);
        }
    }
    const settled = settleStatus(row.status, input.status);
    if (!settled.ok) return settled;

    let lostReason: LostReason | null = null;
    if (settled.status === "Lost") {
        const allowed = row.lostReasonByLabel[input.label] ?? [];
        if (allowed.length === 0) return ask("Why is the lead lost?");
        if (input.lostReason && !allowed.includes(input.lostReason)) {
            return ask("That lost reason doesn't match what was said. Why is the lead lost?");
        }
        lostReason = input.lostReason ?? (allowed.length === 1 ? allowed[0] : null);
        if (!lostReason) return ask("Why is the lead lost?");
    }
    return { ok: true, status: settled.status, lostReason, interest: row.interest };
}

/** May this visit be proposed as described? Outcomes outside the map → a question. */
export function checkVisitProposal(input: {
    outcome: VisitOutcome;
    status?: StatusChoice;
    lostReason?: LostReason | null;
}): ProposalCheck {
    const row = VISIT_VOCAB.find((r) => r.outcomes.includes(input.outcome));
    const rule = row?.statusByOutcome[input.outcome];
    if (!row || !rule) return ask("How did the visit go?");

    const settled = settleStatus(rule, input.status);
    if (!settled.ok) return settled;

    let lostReason: LostReason | null = null;
    if (settled.status === "Lost") {
        if (!input.lostReason) return ask("Why is the lead lost?");
        if (!row.lostReasons.includes(input.lostReason)) {
            return ask("That lost reason doesn't match the visit. Why is the lead lost?");
        }
        lostReason = input.lostReason;
    }
    return { ok: true, status: settled.status, lostReason, interest: null };
}
