// NeoDove inbound webhook (E-224). Mirrors src/app/api/whatsapp/webhook/route.ts.
//
//   GET  — connectivity check, so the endpoint can be verified from NeoDove's
//          UI (and by a human with a browser) before a real event is wired up.
//   POST — raw body → verify bearer → claim idempotency row → fast-ack 200,
//          then process in after().
//
// Configure in NeoDove: Workflows → Send Webhook, method POST, and a custom
// header `Authorization: Bearer <NEODOVE_WEBHOOK_SECRET>`.
//
// WHY THE 200 COMES BEFORE THE WORK. NeoDove's retry behaviour on a slow or
// failed response is undocumented. A handler that did its DB writes inline
// would risk a timeout being read as a failure and redelivered, and with no
// read API we cannot reconcile a storm of duplicates after the fact. So: claim
// the idempotency row synchronously (cheap, one INSERT), ack, then work.
//
// WHY A MALFORMED BODY STILL RETURNS 200. A 4xx makes NeoDove retry the same
// unparseable payload forever. The bytes are already persisted in
// neodove_sync_events, so a human can re-parse them; retrying helps nobody.

import { after, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { errorMessage } from "@/lib/api-utils";
import { parseInboundEvent } from "@/lib/neodove/mapper";
import { handleNeodoveEvent } from "@/lib/neodove/inbound";
import {
    NeodoveWebhookInvalidError,
    NeodoveWebhookSecretMissingError,
    verifyNeodoveWebhook,
} from "@/lib/neodove/signature";

// Node runtime: Buffer + timingSafeEqual + the postgres pool.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(): Promise<Response> {
    return NextResponse.json({ ok: true, service: "neodove-webhook" });
}

export async function POST(req: Request): Promise<Response> {
    // Raw body first — required for signature verification if NeoDove ever
    // ships it, and it is the exact byte string we persist.
    const rawBody = await req.text();

    try {
        verifyNeodoveWebhook(req.headers, rawBody);
    } catch (err) {
        if (err instanceof NeodoveWebhookSecretMissingError) {
            console.error("[NeoDove/webhook] misconfigured:", err.message);
            return NextResponse.json({ error: "not configured" }, { status: 500 });
        }
        if (err instanceof NeodoveWebhookInvalidError) {
            console.error("[NeoDove/webhook]", err.message);
            return NextResponse.json({ error: "unauthorized" }, { status: 401 });
        }
        throw err;
    }

    let parsedBody: unknown;
    try {
        parsedBody = rawBody ? JSON.parse(rawBody) : {};
    } catch {
        // Not JSON. Keep the bytes so the real shape can be inspected, and ack
        // so NeoDove stops resending something we can never parse.
        await storeUnparseable(rawBody);
        return NextResponse.json({ status: "stored_unparseable" }, { status: 200 });
    }

    const event = parseInboundEvent(parsedBody);

    // Idempotency claim. The partial unique index on
    // (external_event_id) WHERE direction='inbound' makes this atomic: a
    // duplicate delivery inserts zero rows and we skip the work entirely.
    let isNew = false;
    try {
        const rows = await db.execute<{ id: string }>(sql`
            INSERT INTO neodove_sync_events
                (direction, event_type, dealer_lead_id, external_event_id, request_payload)
            VALUES ('inbound', ${event.eventType}, NULL, ${event.externalEventId},
                    ${rawBody}::jsonb)
            ON CONFLICT (external_event_id)
                WHERE direction = 'inbound' AND external_event_id IS NOT NULL
                DO NOTHING
            RETURNING id::text AS id
        `);
        isNew = rows.length > 0;
    } catch (err) {
        // If the ledger write fails we must NOT process: without the claim
        // there is no replay protection, and duplicate touchpoints are worse
        // than a delayed one. 500 so NeoDove retries.
        console.error("[NeoDove/webhook] ledger insert failed:", errorMessage(err));
        return NextResponse.json({ error: "ledger unavailable" }, { status: 500 });
    }

    if (!isNew) {
        return NextResponse.json({ status: "duplicate_ignored" }, { status: 200 });
    }

    after(async () => {
        try {
            await handleNeodoveEvent(event);
        } catch (err) {
            console.error("[NeoDove/webhook] handler threw:", errorMessage(err));
        }
    });

    return NextResponse.json({ status: "accepted" }, { status: 200 });
}

async function storeUnparseable(rawBody: string): Promise<void> {
    try {
        await db.execute(sql`
            INSERT INTO neodove_sync_events
                (direction, event_type, request_payload, error)
            VALUES ('inbound', 'unparseable',
                ${JSON.stringify({ body: rawBody.slice(0, 20000) })}::jsonb,
                'Body was not valid JSON')
        `);
    } catch (err) {
        console.error(
            "[NeoDove/webhook] could not store unparseable body:",
            errorMessage(err),
        );
    }
}
