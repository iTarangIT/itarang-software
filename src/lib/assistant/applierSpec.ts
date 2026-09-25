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

export type ApplyContext = { tx: Tx; user: AssistantUser; step: 1 | 2 };

export type Applier<P> = {
    /** The stored plan's shape — parsed again at execute time. */
    schema: z.ZodType<P>;
    /** "owner": assertOwner. "claim": the lead must be in the user's claim pool. */
    ownership: "owner" | "claim";
    /** Only for ownership "claim": is the (locked) lead still claimable by this user? */
    assertClaimable: (tx: Tx, leadId: string, user: AssistantUser) => Promise<boolean>;
    /** true → Confirm at step 1 creates a second confirmation instead of writing. */
    needsSecondConfirm: (plan: P) => boolean;
    secondConfirmWarning: (plan: P) => string;
    /** Every CRM write for this action. Returns ids/values for the audit's `after`. */
    apply: (ctx: ApplyContext, plan: P) => Promise<Record<string, unknown>>;
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
