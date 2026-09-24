// CRM → Ecofy events — docs/ECOFY_INTEGRATION.md §4.
//
// POSTs a signed event to ECOFY_EVENTS_URL and records every attempt in
// ecofy_sync_events (direction 'outbound'). A retry MUST reuse the eventId:
// pass the `eventId` returned by the failed call back in, and the ledger row's
// attempt counter moves instead of a new row appearing.
//
// Retry guidance from §4: only a 5xx / timeout / network error is retryable
// (`retryable: true`). 401 = our signing is wrong; 409 GATE_NOT_MET and
// 422 VALIDATION_FAILED are final for that eventId.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { errorMessage } from "@/lib/api-utils";
import { EcofyNotConfiguredError, getEcofyConfig } from "./config";
import { signEcofyPayload } from "./signature";

export type EcofyCallOutcome =
    | "CONNECTED"
    | "NO_ANSWER"
    | "BUSY"
    | "SWITCHED_OFF"
    | "WRONG_NUMBER"
    | "CALL_BACK";

export type EcofyReturnReason =
    | "WRONG_NUMBER"
    | "NOT_INTERESTED"
    | "WANTS_LATER"
    | "DUPLICATE"
    | "OUT_OF_AREA"
    | "REQUALIFY";

export type EcofyOutboundEvent =
    | { type: "lead.accepted"; data?: Record<string, never> }
    | { type: "lead.assigned"; data: { assigneeName: string; reason?: string } }
    | {
          type: "lead.activity";
          data:
              | { type: "CALL"; callOutcome: EcofyCallOutcome; note?: string }
              | { type: "REMARK" | "COMMENT"; note?: string }
              | { type: "FOLLOW_UP"; nextFollowUpAt: string; note?: string };
      }
    | { type: "lead.returned"; data: { reasonCode: EcofyReturnReason; note?: string } }
    | { type: "lead.closed"; data: { closureReason: string; note?: string } };

export type SendEcofyEventInput = EcofyOutboundEvent & {
    ecofyCaseId: string;
    crmLeadId: string;
    /** The CRM person, e.g. "Priya Sharma (Sales Head)". */
    actorName: string;
    /** Reuse on retry. Omit on the first send. */
    eventId?: string;
    occurredAt?: Date;
};

export interface SendEcofyEventResult {
    eventId: string;
    ok: boolean;
    status: number | null;
    duplicate: boolean;
    retryable: boolean;
    body: unknown;
}

const TIMEOUT_MS = 10_000;

export async function sendEcofyEvent(input: SendEcofyEventInput): Promise<SendEcofyEventResult> {
    const { secret, eventsUrl } = getEcofyConfig();
    if (!secret) throw new EcofyNotConfiguredError("ECOFY_SYNC_SECRET");
    if (!eventsUrl) throw new EcofyNotConfiguredError("ECOFY_EVENTS_URL");

    const eventId = input.eventId ?? `crm-${randomUUID()}`;
    const payload = {
        eventId,
        type: input.type,
        occurredAt: (input.occurredAt ?? new Date()).toISOString(),
        ecofyCaseId: input.ecofyCaseId,
        crmLeadId: input.crmLeadId,
        actorName: input.actorName,
        data: input.data ?? {},
    };
    const raw = JSON.stringify(payload);

    await db.execute(sql`
        INSERT INTO ecofy_sync_events (direction, event_id, event_type, ecofy_case_id, payload, attempts)
        VALUES ('outbound', ${eventId}, ${input.type}, ${input.ecofyCaseId}, ${raw}::jsonb, 1)
        ON CONFLICT (direction, event_id) DO UPDATE
            SET attempts = ecofy_sync_events.attempts + 1, updated_at = now()
    `);

    let status: number | null = null;
    let body: unknown = null;
    let duplicate = false;
    let error: string | null = null;
    try {
        const res = await fetch(eventsUrl, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-itarang-signature": signEcofyPayload(secret, raw),
            },
            body: raw,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        status = res.status;
        duplicate = res.headers.get("x-itarang-duplicate") === "true";
        const text = await res.text();
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = { raw: text.slice(0, 2000) };
        }
        if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
        error = errorMessage(err);
    }

    await db.execute(sql`
        UPDATE ecofy_sync_events
        SET http_status = ${status}, response = ${JSON.stringify(body)}::jsonb,
            error = ${error}, updated_at = now()
        WHERE direction = 'outbound' AND event_id = ${eventId}
    `);

    const ok = status !== null && status >= 200 && status < 300;
    return {
        eventId,
        ok,
        status,
        duplicate,
        retryable: status === null || status >= 500,
        body,
    };
}
