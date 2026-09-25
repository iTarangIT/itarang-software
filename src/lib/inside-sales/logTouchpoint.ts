// Log a touchpoint on a lead, optionally with a status change and a follow-up
// date (BRD §0.5 — the primary action on Lead Detail). Extracted from
// POST /api/inside-sales/lead/[id]/touchpoint so the screen and the WhatsApp
// Assistant's log_call / set_follow_up log a call exactly the same way.
//
// ONE transaction: the touchpoint, any status change, and next_follow_up_at
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
import { TOUCHPOINT_TYPE, CALL_STATUS, NEXT_ACTION, shouldAutoEngage } from "@/lib/lifecycle/touchpointTypes";
import { LEAD_STATUS, type LeadStatus } from "@/lib/lifecycle/transitions";
import {
    callStatusForDisposition,
    classifyDisposition,
    CONNECT_STATUS,
    DISPOSITION_BUCKETS,
    resolveBucket,
    type ClassifiedDisposition,
} from "@/lib/leads/dispositions";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
    status_change: z
        .object({
            to: z.enum(LEAD_STATUS),
            reason_notes: z.string().max(2000).nullable().optional(),
        })
        .optional(),
    follow_up_at: z.string().datetime().nullable().optional(),
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
): WriteTouchpointInput {
    const { leadId, fromStatus, actorId } = lead;
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

    // Auto-engage when applicable (BRD §0.1 Glossary).
    const isEngaged =
        body.is_engaged ??
        shouldAutoEngage(body.touchpoint_type, { callStatus: derivedCallStatus, visitOutcome: null });

    // Whatever status the rep picked is what the lead gets: no transition map,
    // no engaged-touchpoint gate, no final_price gate (see the lifecycle
    // engine), and a lead that never had a status can be given one —
    // from_status is nullable on the history row. Every change still writes
    // dealer_lead_status_history, which is what the reporting reads.
    let statusChange: WriteTouchpointInput["statusChange"];
    if (body.status_change) {
        statusChange = {
            from: fromStatus,
            to: body.status_change.to,
            reasonNotes: body.status_change.reason_notes ?? null,
            closingRole:
                body.status_change.to === "Converted" || body.status_change.to === "Lost"
                    ? "is_phone"
                    : undefined,
        };
    }

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
        statusChange,
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
        const input = planTouchpoint(body, {
            leadId,
            fromStatus: (state.lead_status as LeadStatus | null) ?? null,
            actorId,
        });
        const result = await writeTouchpoint(input, { tx });

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
