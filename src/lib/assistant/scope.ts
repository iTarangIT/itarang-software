// The scope predicate — Invariant 1, BRD §2.1 / §5.
//
// What the Assistant can read for a user is EXACTLY the union of that user's
// own queue tabs: the tabFilter() clauses the ISR and ASM screens run, imported,
// never restated. So a lead the rep cannot find in any of their tabs does not
// exist for the Assistant either, and a change to a tab's definition moves the
// Assistant with it.
//
//   inside_sales_rep  my_open ∪ follow_ups ∪ unassigned ∪ team ∪ my_closed
//   asm               my_visits ∪ today ∪ territory ∪ unclaimed ∪ my_closed
//
// In scope but not owned = read-only; the write tools check ownership again.
// Anything else (including a role outside Phase 1) matches nothing.
//
// ⚠ The ASM `today` clause reads the `lv` lateral (latest visit), so every ASM
// query must carry LATEST_VISIT_JOIN — scopeFrom() does it for you.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { tabFilter as isrTab } from "@/lib/inside-sales/queryBuilder";
import { tabFilter as asmTab, LATEST_VISIT_JOIN } from "@/lib/asm/queryBuilder";
import { QUEUE_TABS } from "@/lib/inside-sales/types";
import { ASM_QUEUE_TABS } from "@/lib/asm/types";
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

/** The joins scopePredicate needs. */
export function scopeJoin(user: ScopeUser): SQL {
    return user.role === "asm" ? LATEST_VISIT_JOIN : sql``;
}

/**
 * Leads this user may CLAIM: ISR — the global unassigned pool; ASM — unowned
 * AND inside their territory (the Territory Feed's "or unowned anywhere" is for
 * reading, not claiming). Unknown role → FALSE.
 */
export function claimPoolPredicate(user: ScopeUser): SQL {
    switch (user.role) {
        case "inside_sales_rep":
            return isrTab("unassigned", user.id);
        case "asm":
            return asmTab("unclaimed", user.id);
        default:
            return sql`FALSE`;
    }
}

export type ScopedLead = {
    id: string;
    shop_name: string | null;
    dealer_name: string | null;
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
 * The lead if — and only if — it is in the user's scope. null for BOTH "does
 * not exist" and "exists but you can't see it"; callers must not distinguish.
 */
export async function findLeadInScope(user: ScopeUser, leadId: string): Promise<ScopedLead | null> {
    const id = leadId.trim();
    if (!id) return null;
    const rows = await db.execute<{
        id: string;
        shop_name: string | null;
        dealer_name: string | null;
        current_owner_id: string | null;
        asm_id: string | null;
        lead_status: string | null;
        interest_level: string | null;
        next_follow_up_at: string | Date | null;
        updated_at: string | Date | null;
    }>(sql`
        SELECT dl.id, dl.shop_name, dl.dealer_name, dl.current_owner_id, dl.asm_id, dl.lead_status,
               dl.interest_level, dl.next_follow_up_at, dl.updated_at
          FROM dealer_leads dl
          ${scopeJoin(user)}
         WHERE dl.id = ${id} AND ${scopePredicate(user)}
         LIMIT 1
    `);
    const r = rows[0];
    if (!r) return null;
    return {
        id: r.id,
        shop_name: r.shop_name,
        dealer_name: r.dealer_name,
        current_owner_id: r.current_owner_id,
        asm_id: r.asm_id,
        lead_status: r.lead_status,
        interest_level: r.interest_level,
        next_follow_up_at: r.next_follow_up_at ? new Date(r.next_follow_up_at) : null,
        updated_at: r.updated_at ? new Date(r.updated_at) : null,
        owned: r.current_owner_id === user.id,
    };
}
