// The contract between a write tool and the executor. The tool PROPOSES (plan +
// preview + pending row); its applier APPLIES that plan inside the executor's
// transaction, after the executor has locked the lead and re-checked ownership
// (or claim eligibility) and staleness. Appliers only compose existing CRM
// writers (writeTouchpoint and the functions extracted from the routes) — they
// never re-implement a business rule.

import type { z } from "zod";
import type { db } from "@/lib/db";
import type { AssistantUser } from "./types";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ApplyContext = {
    tx: Tx;
    user: AssistantUser;
    step: 1 | 2;
    /** The confirmed action — recorded on the attachments it consumes (E-311). */
    actionId?: string;
};

export type RejectReason =
    | "stale"
    | "not_owner"
    | "writes_disabled"
    | "lead_missing"
    | "not_claimable"
    | "duplicate_phone"
    | "target_unavailable"
    /** A hand-back to an ISR while the ASM has a visit booked (ID 121). */
    | "visit_booked"
    /** A second Transfer to ASM on a lead already awaiting the visit (ID 120). */
    | "already_transferred"
    /** A photo / file on the plan was consumed by another confirmed action meanwhile (E-311). */
    | "attachment_used"
    /**
     * The CRM writer refused the change with its own sentence (StatusGuardError,
     * WithdrawQuoteError, … — any error carrying an HTTP 4xx status). The
     * sentence travels on the outcome as `message`; it is what the rep reads.
     */
    | "refused";

/** A rejection the executor maps to a reply; the action is marked failed with it. Appliers may throw it too. */
export class ActionRejected extends Error {
    constructor(
        readonly reason: RejectReason,
        /** The writer's own sentence, for reason "refused". */
        readonly detail: string | null = null,
    ) {
        super(`rejected: ${reason}${detail ? ` — ${detail}` : ""}`);
    }
}

/**
 * What `apply` returns: ids/values for the audit's `after`, plus optionally a
 * step to run AFTER the transaction commits (notifications, an outbound
 * WhatsApp send) — best-effort, it can never undo or fail the write. What it
 * resolves to is handed back on the confirmed outcome as `extra`.
 */
export type ApplyOutput = Record<string, unknown> & {
    afterCommit?: () => Promise<Record<string, unknown> | void>;
};

export type Applier<P> = {
    /** The stored plan's shape — parsed again at execute time. */
    schema: z.ZodType<P>;
    /**
     * "owner": assertOwner. "claim": the lead must be in the user's claim pool.
     * "none": the action has no existing lead (create_lead) — no lock, no
     * ownership or staleness check; the applier guards its own invariants.
     */
    ownership: "owner" | "claim" | "none";
    /** Only for ownership "claim": is the (locked) lead still claimable by this user? */
    assertClaimable: (tx: Tx, leadId: string, user: AssistantUser) => Promise<boolean>;
    /** true → Confirm at step 1 creates a second confirmation instead of writing. */
    needsSecondConfirm: (plan: P) => boolean;
    secondConfirmWarning: (plan: P) => string;
    /** Every CRM write for this action. */
    apply: (ctx: ApplyContext, plan: P) => Promise<ApplyOutput>;
    /**
     * Only for an applier whose afterCommit is an external send (send_quote,
     * the dealer invite): did NOTHING go out? `extra` is what afterCommit
     * resolved to — null when it threw. The executor notes it on the confirmed
     * action, so a second Confirm tap says "ask again", never "Already saved."
     */
    sendFailed?: (extra: Record<string, unknown> | null) => boolean;
};

type ApplierInput<P> = Pick<Applier<P>, "schema" | "apply"> & Partial<Omit<Applier<P>, "schema" | "apply">>;

/** Fill the defaults (owner-checked, single confirm) and erase the plan type for the registry. */
export function defineApplier<P>(a: ApplierInput<P>): Applier<unknown> {
    const full: Applier<P> = {
        ownership: "owner",
        assertClaimable: async () => false,
        needsSecondConfirm: () => false,
        secondConfirmWarning: () => "",
        ...a,
    };
    // Sound: the executor always parses the stored plan with `schema` before apply.
    return full as unknown as Applier<unknown>;
}
