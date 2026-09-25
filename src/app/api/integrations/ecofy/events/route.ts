// Ecofy → CRM inbound events — docs/ECOFY_INTEGRATION.md §3 (E-305).
//
//   POST — raw body → HMAC verify (§2) → parse → claim eventId + upsert
//          ecofy_leads in one transaction → { crmLeadId }.
//
// Unauthenticated by session on purpose: middleware passes /api/* through and
// the HMAC signature IS the credential.
//
// WHY THE WORK IS INLINE (unlike the NeoDove webhook's fast-ack). Ecofy needs
// crmLeadId in the reply to link its case, retries any non-2xx with back-off,
// and delivers one lead's events strictly in order — so a 2xx must mean
// "stored". One small transaction fits well inside Ecofy's 10 s timeout.
//
// Status codes (Ecofy retries anything but 2xx, then parks it as DEAD):
//   200 stored / duplicate (replays the first reply) / unknown type ignored
//   401 bad, stale or missing signature
//   422 body is not JSON or not the §3 envelope
//   500 DB failure — nothing recorded, so the retry reprocesses it
//   503 ECOFY_SYNC_SECRET not set

import { after, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { errorMessage } from "@/lib/api-utils";
import { getEcofyConfig } from "@/lib/ecofy/config";
import { ecofyEventSchema, handleEcofyEvent } from "@/lib/ecofy/inbound";
import { notifyEcofyInbound, notifyEcofySyncFailed } from "@/lib/ecofy/notify";
import { ECOFY_SIGNATURE_HEADER, verifyEcofySignature } from "@/lib/ecofy/signature";

// Node runtime: node:crypto + the postgres pool.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
    const { secret } = getEcofyConfig();
    if (!secret) {
        console.error("[Ecofy/events] ECOFY_SYNC_SECRET is not set");
        return NextResponse.json({ error: "not configured" }, { status: 503 });
    }

    // HMAC over the bytes exactly as received, before any decoding.
    const rawBytes = Buffer.from(await req.arrayBuffer());
    const check = verifyEcofySignature(secret, req.headers.get(ECOFY_SIGNATURE_HEADER), rawBytes);
    if (!check.ok) {
        console.warn(
            "[Ecofy/events] rejected:",
            check.reason,
            req.headers.get("x-itarang-event-id") ?? "",
        );
        return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }

    const rawBody = rawBytes.toString("utf8");
    let json: unknown;
    try {
        json = JSON.parse(rawBody);
    } catch {
        return NextResponse.json({ error: "body is not valid JSON" }, { status: 422 });
    }

    const parsed = ecofyEventSchema.safeParse(json);
    if (!parsed.success) {
        return NextResponse.json(
            { error: "invalid event", issues: parsed.error.issues.slice(0, 10) },
            { status: 422 },
        );
    }

    try {
        const { duplicate, reply, lead } = await handleEcofyEvent(parsed.data, rawBody);
        if (!duplicate && lead) {
            const event = parsed.data;
            // After the 200: a notification must never delay or fail Ecofy's delivery.
            after(async () => {
                const reason = typeof event.change?.reason === "string" ? event.change.reason : null;
                await notifyEcofyInbound({
                    leadId: lead.id,
                    eventType: event.type,
                    previousStage: lead.previousStage,
                    stage: lead.stage,
                    created: lead.created,
                    reason,
                });
                // E-307 — back with Ecofy (S0) or re-pushed into the pickup
                // queue (S1): the CRM owner no longer applies; the Sales Head
                // assigns again. History stays in ecofy_lead_assignments.
                if (lead.previousStage !== lead.stage && (lead.stage === "S0" || lead.stage === "S1")) {
                    try {
                        await db.execute(sql`
                            UPDATE ecofy_leads
                            SET assigned_to_user_id = NULL, assigned_role = NULL,
                                next_follow_up_at = NULL, next_appointment_at = NULL,
                                updated_at = now()
                            WHERE id = ${lead.id}::uuid
                        `);
                    } catch (err) {
                        console.error("[Ecofy/events] clear owner failed:", errorMessage(err));
                    }
                }
            });
        }
        return NextResponse.json(reply, {
            status: 200,
            headers: duplicate ? { "x-itarang-duplicate": "true" } : undefined,
        });
    } catch (err) {
        console.error("[Ecofy/events] store failed:", parsed.data.eventId, errorMessage(err));
        void notifyEcofySyncFailed({ kind: "Inbound Ecofy event not stored", detail: `${parsed.data.eventId}: ${errorMessage(err)}` });
        return NextResponse.json({ error: "store failed" }, { status: 500 });
    }
}
