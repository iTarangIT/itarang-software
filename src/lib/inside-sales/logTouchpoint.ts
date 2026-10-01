// Log a touchpoint on a lead, optionally with a follow-up date (BRD §0.5 — the
// primary action on Lead Detail). The lead's status is never taken from the
// request (ID 80): it follows the call outcome, by the shared rule. Extracted from
// POST /api/inside-sales/lead/[id]/touchpoint so the screen and the WhatsApp
// Assistant's log_call / set_follow_up log a call exactly the same way.
//
// ONE transaction: the touchpoint, the status its outcome earns, and next_follow_up_at
// commit or roll back together. (The route used to set next_follow_up_at in a
// separate statement after the touchpoint had committed.) Pass `opts.tx` to
// fold it into a larger atomic write.
//
// Ownership is the CALLER's job (assertOwner before calling), as it was in the
// route. planTouchpoint() is the pure half, unit-tested without a DB.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
    writeTouchpoint,
    type WriteTouchpointInput,
    type WriteTouchpointResult,
} from "@/lib/touchpoints/write";
import {
    TOUCHPOINT_TYPE,
    CALL_STATUS,
    NEXT_ACTION,
    shouldAutoEngage,
    type EngagedCallRule,
} from "@/lib/lifecycle/touchpointTypes";
import { getEngagedCallRule } from "@/lib/reports/engagedCallRule";
import { LEAD_STATUS, type LeadStatus } from "@/lib/lifecycle/transitions";
import { reviewLeadContactability } from "@/lib/leads/contactability";
import type { DispositionBucket } from "@/lib/leads/dispositions";
import {
    callStatusForDisposition,
    classifyDisposition,
    CONNECT_STATUS,
    DISPOSITION_BUCKETS,
    resolveBucket,
    type ClassifiedDisposition,
} from "@/lib/leads/dispositions";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The touchpoint types a person may log by hand through POST …/touchpoint.
 * Every other value of TOUCHPOINT_TYPE is written by its own action — a visit
 * by the visit form (with its lead_visits row), an ownership hop by claim /
 * assign / transfer, a quote event by the commercials writers — and a
 * hand-crafted request must not be able to fabricate one: a bare "visit" would
 * count as work and reset the idle clock with no visit behind it (ID 80).
 */
export const MANUAL_TOUCHPOINT_TYPES = ["inside_sales_call", "whatsapp", "status_change_note"] as const;

export function isManualTouchpointType(type: string): boolean {
    return (MANUAL_TOUCHPOINT_TYPES as readonly string[]).includes(type);
}

export const TouchpointBodySchema = z.object({
    touchpoint_type: z.enum(TOUCHPOINT_TYPE),
    performed_at: z.string().datetime().optional(),
    // Retained for any caller still sending it. The disposition wins when both
    // are present.
    call_status: z.enum(CALL_STATUS).nullable().optional(),
    // The CC team's L1/L2/L3. `bucket` is sent explicitly so a rep who picked
    // "Commercials Explained" under Hot gets Hot — see resolveBucket.
    disposition: z
        .object({
            connect_status: z.enum(CONNECT_STATUS),
            bucket: z.enum(DISPOSITION_BUCKETS).nullable().optional(),
            label: z.string().trim().min(1).max(120),
        })
        .nullable()
        .optional(),
    call_duration_sec: z.number().int().min(0).max(36000).nullable().optional(),
    is_engaged: z.boolean().optional(),
    remarks: z.string().max(5000).optional(),
    attachments: z.array(z.unknown()).max(20).optional(),
    next_action: z.enum(NEXT_ACTION).nullable().optional(),
    next_action_at: z.string().datetime().nullable().optional(),
    // NOT ACTED ON (ID 80): no status is settable from a touchpoint. The field
    // is still parsed so a caller that sends it gets its touchpoint saved —
    // the status simply follows the outcome — and so asking for Converted /
    // Lost / Transferred_to_ASM keeps its explicit refusal (ID 57): Mark
    // Converted, Mark Lost and Transfer are the only ways in.
    status_change: z
        .object({
            to: z.enum(LEAD_STATUS).refine(
                // Explicit boolean: an inferred type predicate would narrow the
                // type and break callers that pass a LeadStatus.
                (s): boolean => s !== "Converted" && s !== "Lost" && s !== "Transferred_to_ASM",
                { message: "Use Mark Converted, Mark Lost or Transfer to ASM." },
            ),
            reason_notes: z.string().max(2000).nullable().optional(),
        })
        .optional(),
    follow_up_at: z.string().datetime().nullable().optional(),
    // Temperature saved WITH the touchpoint (ID 114), in the same transaction:
    // a level = the rep chose it; null = leave it; absent = the server derives
    // it from the call outcome (see writeTouchpoint's `interest`).
    interest_level: z.enum(["hot", "warm", "cold"]).nullable().optional(),
    /** True when interest_level is the auto rule's value, untouched (audit reason). */
    interest_auto: z.boolean().optional(),
});
export type TouchpointBody = z.infer<typeof TouchpointBodySchema>;

/** The disposition is not in the CC sheet, or not under the stated connect status. */
export class UnknownDispositionError extends Error {
    constructor() {
        super("Unknown disposition for the selected call outcome.");
    }
}

export class LeadNotFoundError extends Error {
    constructor() {
        super("Lead not found");
    }
}

/**
 * Body + the lead's current status → the writeTouchpoint input. Pure.
 * Throws UnknownDispositionError for a disposition outside the sheet.
 */
export function planTouchpoint(
    body: TouchpointBody,
    lead: { leadId: string; fromStatus: LeadStatus | null; actorId: string },
    /** The saved engaged-call rule; the default (30 s, NeoDove durations) when omitted. */
    opts: { engagedRule?: EngagedCallRule } = {},
): WriteTouchpointInput {
    const { leadId, actorId } = lead;
    // Classify the disposition BEFORE isEngaged, which depends on the derived
    // call status, which depends on this.
    //
    // A manual pick MUST be in the sheet — the OPPOSITE of the inbound rule.
    // mapper.ts must never reject, because a refused NeoDove delivery cannot be
    // re-fetched; here the input is a closed dropdown, so a value outside the
    // sheet can only come from a hand-crafted request, and letting one through
    // would poison the /leads disposition facet, which reads DISTINCT from the
    // data rather than from the sheet.
    let classified: ClassifiedDisposition | null = null;
    if (body.disposition) {
        const hit = classifyDisposition(body.disposition.label, {
            callConnected: body.disposition.connect_status === "connected",
        });
        if (!hit?.isKnown || hit.connectStatus !== body.disposition.connect_status) {
            throw new UnknownDispositionError();
        }
        classified = {
            ...hit,
            bucket: resolveBucket(hit.label, hit.bucket, { stage: body.disposition.bucket ?? null }),
        };
    }

    // One vocabulary, derived server-side: the client can be stale, and the
    // rule belongs next to the sheet. call_status keeps being written with
    // exactly the same five values as before, because five things key off it
    // — shouldAutoEngage → is_engaged, two report figures and two dashboard
    // timings — and 2,445 historical rows already have it.
    const derivedCallStatus = callStatusForDisposition(classified) ?? body.call_status ?? null;

    // Auto-engage when applicable (BRD §0.1 Glossary). A CALL is never engaged
    // by a tick: it follows the ID 59 rule (connected, at least the threshold
    // of measured duration — a hand-logged call has no measured duration
    // unless the saved rule counts rep-entered ones). Other types keep the
    // rep's tick.
    const autoEngaged = shouldAutoEngage(body.touchpoint_type, {
        callStatus: derivedCallStatus,
        visitOutcome: null,
        callDurationSec: body.call_duration_sec ?? null,
        externalSystem: null,
        engagedRule: opts.engagedRule,
    });
    // Nor is a WhatsApp entry logged here (ID 79): a chat counts as contact only
    // with its screenshot, through recordWhatsappContact — this path saves a note.
    const isEngaged =
        body.touchpoint_type === "inside_sales_call"
            ? autoEngaged
            : body.touchpoint_type === "whatsapp"
              ? false
              : body.is_engaged ?? autoEngaged;

    // ID 80 / 114: no manual status — at all. The status (and the temperature)
    // come from the call outcome by the shared rule, applied by writeTouchpoint
    // itself against the row it locks, so the API, the forms, the Assistant and
    // NeoDove cannot disagree. `status_change` in the request is NOT read: a
    // note saying "spoke to the dealer" is not an event, and first contact is
    // earned by a logged call (here), a visit, or a WhatsApp chat with its
    // screenshot (recordWhatsappContact). Commercials stages come only from
    // quote events (ID 75); Won / Lost / transfer from their own actions; an
    // admin can use Correct status.
    const outcome: WriteTouchpointInput["outcome"] =
        classified && body.touchpoint_type === "inside_sales_call"
            ? {
                  kind: "call",
                  connected: classified.connectStatus === "connected",
                  label: classified.label,
                  bucket: classified.bucket as DispositionBucket | null,
              }
            : undefined;

    return {
        dealerLeadId: leadId,
        touchpointType: body.touchpoint_type,
        performedBy: actorId,
        performedAt: body.performed_at ? new Date(body.performed_at) : undefined,
        callStatus: derivedCallStatus,
        callDurationSec: body.call_duration_sec ?? null,
        disposition: classified
            ? { label: classified.label, bucket: classified.bucket, connectStatus: classified.connectStatus! }
            : null,
        dispositionSource: "inside_sales",
        isEngaged,
        remarks: body.remarks ?? null,
        attachments: body.attachments ?? null,
        nextAction: body.next_action ?? null,
        nextActionAt: body.next_action_at ? new Date(body.next_action_at) : null,
        outcome,
        // Absent stays absent (derive); null and a level pass through.
        ...(body.interest_level !== undefined
            ? {
                  interest: body.interest_level,
                  interestReason: body.interest_auto ? "Auto: from call outcome" : "Set with touchpoint",
              }
            : {}),
    };
}

/**
 * Write the touchpoint (+ status change + follow-up) in one transaction.
 * Throws LeadNotFoundError / UnknownDispositionError; a database without
 * E-236 surfaces as the driver's 42703 when a disposition is sent.
 */
export async function logLeadTouchpoint(
    args: { leadId: string; actorId: string; body: TouchpointBody },
    opts?: { tx?: Tx },
): Promise<WriteTouchpointResult> {
    const { leadId, actorId, body } = args;
    const run = async (tx: Tx): Promise<WriteTouchpointResult> => {
        const rows = await tx.execute<{ lead_status: string | null }>(sql`
            SELECT lead_status FROM dealer_leads WHERE id = ${leadId} LIMIT 1
        `);
        const state = rows[0];
        if (!state) throw new LeadNotFoundError();
        const input = planTouchpoint(
            body,
            { leadId, fromStatus: (state.lead_status as LeadStatus | null) ?? null, actorId },
            { engagedRule: await getEngagedCallRule() },
        );
        const result = await writeTouchpoint(input, { tx });

        // ID 36: every logged call re-checks contactability (dead number from
        // the outcome, non-responsive from the call log; a connect clears it).
        if (input.touchpointType === "inside_sales_call") {
            await reviewLeadContactability(
                {
                    leadId,
                    connected: input.callStatus === "connected",
                    reasonLabel: input.disposition?.label ?? null,
                    actorId,
                },
                { tx },
            );
        }

        // Caller wants to set / clear next_follow_up_at (BRD §0.5 form field).
        if (body.follow_up_at !== undefined) {
            await tx.execute(sql`
                UPDATE dealer_leads
                SET next_follow_up_at = ${body.follow_up_at ?? null},
                    updated_at = NOW()
                WHERE id = ${leadId}
            `);
        }
        return result;
    };
    return opts?.tx ? run(opts.tx) : db.transaction(run);
}
