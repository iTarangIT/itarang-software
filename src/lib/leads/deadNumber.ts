/**
 * When does a call outcome make a number DEAD? (tracker ID 36 / 36.1)
 *
 *   A person's call    one "Incorrect / Invalid number" (or "Number not in
 *                      use") is enough — the rep heard it.
 *   The AI dialer      it needs TWO: at least 2 ai_call touchpoints with
 *                      call_status 'incorrect_number' since the lead's last
 *                      connected call. One AI misread must not pull a working
 *                      number out of every queue.
 *
 * Counting touchpoint ROWS is retry-safe: a webhook retry or poll tick reuses
 * the call's touchpoint (lead_touchpoints_external_uniq), so one call is one
 * row however often it is reported. "Connected" is call_status = 'connected',
 * as in nonResponsive.ts, from a person's call or the AI's.
 *
 * isAiDeadNumber() and contactabilityAction() are the pure twins used by the
 * unit tests; aiDeadNumberSql() is what reviewLeadContactability runs. Keep
 * them in step.
 */
import { sql, type SQL } from "drizzle-orm";

export const DEAD_NUMBER_REASONS: readonly string[] = [
    "Incorrect / Invalid number",
    "Number not in use / does not exist / out of service",
];

export const AI_DEAD_NUMBER_MIN_CALLS = 2;

/** Who made the call. A missing source means a person (the original rule). */
export type CallSource = "human" | "ai";

/**
 * Boolean SQL: has the AI dialer heard "incorrect number" on lead `leadId`
 * (an SQL expression) at least AI_DEAD_NUMBER_MIN_CALLS times since the
 * lead's last connected call?
 */
export function aiDeadNumberSql(leadId: SQL): SQL {
    return sql`(
        SELECT COUNT(*) >= ${AI_DEAD_NUMBER_MIN_CALLS}::int
          FROM lead_touchpoints dn
         WHERE dn.dealer_lead_id = ${leadId}
           AND dn.touchpoint_type = 'ai_call'
           AND dn.call_status = 'incorrect_number'
           AND dn.performed_at > COALESCE((
                   SELECT MAX(lc.performed_at)
                     FROM lead_touchpoints lc
                    WHERE lc.dealer_lead_id = ${leadId}
                      AND lc.touchpoint_type IN ('inside_sales_call', 'ai_call')
                      AND lc.call_status = 'connected'
               ), '-infinity'::timestamptz)
    )`;
}

export type CallForDeadNumber = {
    touchpoint_type: string;
    performed_at: Date;
    call_status: string | null;
};

/** Pure twin of aiDeadNumberSql — for tests and any in-memory caller. */
export function isAiDeadNumber(calls: CallForDeadNumber[]): boolean {
    let lastConnected = -Infinity;
    for (const c of calls) {
        if (
            (c.touchpoint_type === "inside_sales_call" || c.touchpoint_type === "ai_call") &&
            c.call_status === "connected"
        ) {
            lastConnected = Math.max(lastConnected, c.performed_at.getTime());
        }
    }
    const dead = calls.filter(
        (c) =>
            c.touchpoint_type === "ai_call" &&
            c.call_status === "incorrect_number" &&
            c.performed_at.getTime() > lastConnected,
    );
    return dead.length >= AI_DEAD_NUMBER_MIN_CALLS;
}

/**
 * What reviewLeadContactability does after a call:
 *   clear          the call connected
 *   dead_number    a person's dead-number outcome, or the AI's second one
 *   non_responsive check the 6-in-45 rule (nonResponsive.ts)
 * `aiDeadNumber` is the result of aiDeadNumberSql / isAiDeadNumber for this
 * lead, the current call included; it is only consulted for an AI call.
 */
export function contactabilityAction(input: {
    connected: boolean;
    reasonLabel: string | null;
    source?: CallSource;
    aiDeadNumber?: boolean;
}): "clear" | "dead_number" | "non_responsive" {
    if (input.connected) return "clear";
    if (input.reasonLabel && DEAD_NUMBER_REASONS.includes(input.reasonLabel)) {
        if (input.source !== "ai" || input.aiDeadNumber) return "dead_number";
    }
    return "non_responsive";
}

/** The flag's reason text for a dead number. */
export function deadNumberReason(reasonLabel: string, source?: CallSource): string {
    return source === "ai" ? `${AI_DEAD_NUMBER_MIN_CALLS} AI calls: ${reasonLabel}` : reasonLabel;
}
