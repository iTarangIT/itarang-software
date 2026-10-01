// The scope predicates — Invariant 1, BRD §2.1 / §5.
//
// Every predicate here is a union of the tabFilter() clauses the ISR and ASM
// queue screens run, imported, never restated — so a change to a tab's
// definition moves the Assistant with it, and a lead the rep cannot find in
// those tabs does not exist for the Assistant either.
//
//   scopePredicate (all tabs — the screens' full union):
//     inside_sales_rep  my_open ∪ follow_ups ∪ unassigned ∪ team ∪ my_closed
//     asm               my_visits ∪ today ∪ territory ∪ unclaimed ∪ my_closed
//   readScopePredicate (what the Assistant READS — findLeadInScope, ID 45):
//     inside_sales_rep  my_open ∪ follow_ups ∪ my_closed ∪ team (read-only)
//     asm               my_visits ∪ today ∪ my_closed
//   ownScopePredicate (what it LISTS / SEARCHES — my_queue, search_lead):
//     the OWN tabs only.
//
// ID 45 (reps cannot browse or read the pool): the pool tabs (ISR unassigned;
// ASM territory / unclaimed) are out of the read scope, so a pool lead's
// details cannot be read even by its exact id. A pool lead is claimed by its
// exact phone or id (claim_lead) and is shown only in the claim preview.
// The full scopePredicate is used for ONE thing: findClaimState, so claim_lead
// can say WHY a lead on the user's screens is not claimable ("already has an
// owner") without returning any of its details.
//
// In read scope but not owned (ISR team) = read-only; the write tools check
// ownership again. Anything else (including a role outside Phase 1) matches
// nothing.
//
// ⚠ The ASM `today` clause reads the `lv` lateral (latest visit), so every ASM
// query must carry LATEST_VISIT_JOIN — scopeFrom() does it for you.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { tabFilter as isrTab } from "@/lib/inside-sales/queryBuilder";
import { tabFilter as asmTab, LATEST_VISIT_JOIN } from "@/lib/asm/queryBuilder";
import { QUEUE_TABS, type QueueTab } from "@/lib/inside-sales/types";
import { ASM_QUEUE_TABS, type AsmQueueTab } from "@/lib/asm/types";
import type { AssistantUser } from "./types";

type ScopeUser = Pick<AssistantUser, "id"> & { role: string };

function union(clauses: SQL[]): SQL {
    return sql`(${sql.join(
        clauses.map((c) => sql`(${c})`),
        sql` OR `,
    )})`;
}

/** WHERE fragment over `dealer_leads dl` (+ `lv` for ASM). Unknown role → FALSE. */
export function scopePredicate(user: ScopeUser): SQL {
    switch (user.role) {
        case "inside_sales_rep":
            return union(QUEUE_TABS.map((t) => isrTab(t, user.id)));
        case "asm":
            return union(ASM_QUEUE_TABS.map((t) => asmTab(t, user.id)));
        default:
            return sql`FALSE`;
    }
}

/** ID 45: the tabs that hold only the user's OWN leads — what my_queue lists. */
export const ISR_OWN_TABS = ["my_open", "follow_ups", "my_closed"] as const satisfies readonly QueueTab[];
export const ASM_OWN_TABS = ["my_visits", "today", "my_closed"] as const satisfies readonly AsmQueueTab[];

/**
 * ID 45: the tabs whose leads the Assistant may READ by id — the own tabs plus
 * the ISR team tab (read-only: colleagues' leads, never the pool). No pool tab
 * (ISR unassigned; ASM territory / unclaimed).
 */
export const ISR_READ_TABS = [...ISR_OWN_TABS, "team"] as const satisfies readonly QueueTab[];
export const ASM_READ_TABS = ASM_OWN_TABS;

/**
 * ID 45: WHERE fragment for what findLeadInScope may return — own tabs + ISR
 * team, no pool. Same joins as scopePredicate (scopeJoin). Unknown role → FALSE.
 */
export function readScopePredicate(user: ScopeUser): SQL {
    switch (user.role) {
        case "inside_sales_rep":
            return union(ISR_READ_TABS.map((t) => isrTab(t, user.id)));
        case "asm":
            return union(ASM_READ_TABS.map((t) => asmTab(t, user.id)));
        default:
            return sql`FALSE`;
    }
}

/**
 * ID 45: WHERE fragment for the user's OWN tabs only (no pool / team /
 * territory) — what search_lead searches. Same joins as scopePredicate
 * (scopeJoin). Unknown role → FALSE.
 */
export function ownScopePredicate(user: ScopeUser): SQL {
    switch (user.role) {
        case "inside_sales_rep":
            return union(ISR_OWN_TABS.map((t) => isrTab(t, user.id)));
        case "asm":
            return union(ASM_OWN_TABS.map((t) => asmTab(t, user.id)));
        default:
            return sql`FALSE`;
    }
}

/** The joins scopePredicate needs. */
export function scopeJoin(user: ScopeUser): SQL {
    return user.role === "asm" ? LATEST_VISIT_JOIN : sql``;
}

/**
 * Leads this user may CLAIM: any unowned, open lead — for an ISR and, since
 * 26 Sep 2026 (tracker ID 45), for an ASM too: claims are allowed in any
 * territory, and claimLead marks one outside the ASM's own for the Sales Head.
 * Unknown role → FALSE.
 */
export function claimPoolPredicate(user: ScopeUser): SQL {
    switch (user.role) {
        case "inside_sales_rep":
            return isrTab("unassigned", user.id);
        case "asm":
            return isrTab("unassigned", user.id);
        default:
            return sql`FALSE`;
    }
}

export type ScopedLead = {
    id: string;
    shop_name: string | null;
    dealer_name: string | null;
    /** 10 digits as stored — the dealer invite needs it. */
    phone: string | null;
    city: string | null;
    /** Territory match for the Transfer-to-ASM picker. */
    state: string | null;
    current_owner_id: string | null;
    /** The lead's field ASM — Today's Schedule keys on it. */
    asm_id: string | null;
    lead_status: string | null;
    interest_level: string | null;
    next_follow_up_at: Date | null;
    /** dealer_leads.updated_at — the version assertNotStale compares against. */
    updated_at: Date | null;
    owned: boolean;
};

/**
 * The lead if — and only if — it is in the user's READ scope (own tabs + ISR
 * team; never a pool tab, ID 45). null for BOTH "does not exist" and "exists
 * but you can't see it"; callers must not distinguish.
 */
export async function findLeadInScope(user: ScopeUser, leadId: string): Promise<ScopedLead | null> {
    const id = leadId.trim();
    if (!id) return null;
    const rows = await db.execute<{
        id: string;
        shop_name: string | null;
        dealer_name: string | null;
        phone: string | null;
        city: string | null;
        state: string | null;
        current_owner_id: string | null;
        asm_id: string | null;
        lead_status: string | null;
        interest_level: string | null;
        next_follow_up_at: string | Date | null;
        updated_at: string | Date | null;
    }>(sql`
        SELECT dl.id, dl.shop_name, dl.dealer_name, dl.phone, dl.city, dl.state, dl.current_owner_id, dl.asm_id, dl.lead_status,
               dl.interest_level, dl.next_follow_up_at, dl.updated_at
          FROM dealer_leads dl
          ${scopeJoin(user)}
         WHERE dl.id = ${id} AND ${readScopePredicate(user)}
         LIMIT 1
    `);
    const r = rows[0];
    if (!r) return null;
    return {
        id: r.id,
        shop_name: r.shop_name,
        dealer_name: r.dealer_name,
        phone: r.phone,
        city: r.city,
        state: r.state,
        current_owner_id: r.current_owner_id,
        asm_id: r.asm_id,
        lead_status: r.lead_status,
        interest_level: r.interest_level,
        next_follow_up_at: r.next_follow_up_at ? new Date(r.next_follow_up_at) : null,
        updated_at: r.updated_at ? new Date(r.updated_at) : null,
        owned: r.current_owner_id === user.id,
    };
}

/**
 * ID 45: what claim_lead may say about a lead that is NOT in the user's claim
 * pool. Looked up in the FULL tab union (scopePredicate — what the user can see
 * on their queue screens), but returns only booleans: no name, phone or status,
 * so a pool lead's details never leak through a claim attempt. `readable` says
 * whether the lead is also in the read scope (so a CRM link may be shown).
 * null = not on any of the user's tabs, or no such lead — indistinguishable.
 */
export async function findClaimState(
    user: ScopeUser,
    leadId: string,
): Promise<{ owned: boolean; has_owner: boolean; readable: boolean } | null> {
    const id = leadId.trim();
    if (!id) return null;
    const rows = await db.execute<{ owned: boolean; has_owner: boolean; readable: boolean }>(sql`
        SELECT (dl.current_owner_id = ${user.id}) IS TRUE AS owned,
               (dl.current_owner_id IS NOT NULL) AS has_owner,
               (${readScopePredicate(user)}) IS TRUE AS readable
          FROM dealer_leads dl
          ${scopeJoin(user)}
         WHERE dl.id = ${id} AND ${scopePredicate(user)}
         LIMIT 1
    `);
    const r = rows[0];
    if (!r) return null;
    return { owned: !!r.owned, has_owner: !!r.has_owner, readable: !!r.readable };
}
