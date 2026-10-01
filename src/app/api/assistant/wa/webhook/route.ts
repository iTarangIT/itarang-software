// WhatsApp Sales Assistant webhook (BRD §8.2) — a separate flow from the
// dealer bot at /api/whatsapp/webhook. Meta sends the Assistant number's events
// here through a number-level webhook override.
//
//   GET   subscription handshake (WA_ASSIST_VERIFY_TOKEN).
//   POST  1. x-hub-signature-256 over the raw body          → 401 if invalid
//         2. drop events for any other phone_number_id       → logged, ignored
//         3. insert each inbound MESSAGE (dedupe on provider_message_id)
//            BEFORE answering, so a restart after the 200 can't lose it; a DB
//            failure here answers 500 so Meta redelivers
//         4. 200
//         5. after(): delivery receipts update our outbound rows (no dedupe —
//            several receipts share a wamid), then each new message goes
//            through the router, in order.
//
// No model call and no awaited network call happen before the 200.

import { after, NextResponse } from "next/server";
import { log } from "@/lib/log";
import { readWaAssistEnv, type WaAssistEnv } from "@/lib/wa-assistant/env";
import { verifyHandshake, verifySignature } from "@/lib/wa-assistant/verify";
import { parseWebhook, type InboundMessage, type StatusEvent } from "@/lib/wa-assistant/parse";
import { applyStatus, insertInbound } from "@/lib/wa-assistant/messages";
import { routeMessage } from "@/lib/wa-assistant/router";
import { defaultRouterDeps } from "@/lib/wa-assistant/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function misconfigured(problems: string[]): Response {
    log.error("[wa-assist/webhook] not configured", { problems });
    return NextResponse.json({ error: "not configured" }, { status: 503 });
}

export async function GET(req: Request): Promise<Response> {
    const cfg = readWaAssistEnv();
    if (!cfg.ok) return misconfigured(cfg.problems);
    const challenge = verifyHandshake(new URL(req.url), cfg.env.WA_ASSIST_VERIFY_TOKEN);
    if (challenge === null) return new Response("Forbidden", { status: 403 });
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

export async function POST(req: Request): Promise<Response> {
    const cfg = readWaAssistEnv();
    if (!cfg.ok) return misconfigured(cfg.problems);
    const env = cfg.env;

    const rawBody = await req.text();
    if (!verifySignature(rawBody, req.headers.get("x-hub-signature-256"), env.WA_ASSIST_APP_SECRET)) {
        log.warn("[wa-assist/webhook] bad signature", { bytes: rawBody.length });
        return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }

    const parsed = parseWebhook(rawBody);
    if (!parsed.ok) {
        // 200 so Meta does not redeliver a payload that will never parse.
        log.warn("[wa-assist/webhook] unparseable payload", { error: parsed.error });
        return NextResponse.json({ status: "ignored" }, { status: 200 });
    }
    if (parsed.skipped > 0) log.warn("[wa-assist/webhook] skipped malformed items", { skipped: parsed.skipped });

    const statuses: StatusEvent[] = [];
    const inbound: { msg: InboundMessage; rowId: string }[] = [];
    for (const event of parsed.events) {
        if (event.phoneNumberId !== env.WA_ASSIST_PHONE_NUMBER_ID) {
            log.warn("[wa-assist/webhook] ignored event for another phone_number_id", {
                phoneNumberId: event.phoneNumberId,
            });
            continue;
        }
        if (event.kind === "status") {
            statuses.push(event);
            continue;
        }
        let rowId: string | null;
        try {
            rowId = await insertInbound(event);
        } catch (err) {
            log.error("[wa-assist/webhook] could not record inbound; asking Meta to redeliver", {
                waMessageId: event.providerMessageId,
                error: err instanceof Error ? err.message : String(err),
            });
            // Messages already recorded from this batch still get processed: on
            // redelivery they dedupe as duplicates and would otherwise be lost.
            processLater(env, statuses, inbound);
            return NextResponse.json({ error: "try again" }, { status: 500 });
        }
        if (rowId === null) {
            log.info("[wa-assist/webhook] duplicate delivery", { waMessageId: event.providerMessageId });
            continue;
        }
        inbound.push({ msg: event, rowId });
    }

    processLater(env, statuses, inbound);
    return NextResponse.json({ status: "ok" }, { status: 200 });
}

/** Receipts first, then each new message through the router, in order. */
function processLater(
    env: WaAssistEnv,
    statuses: StatusEvent[],
    inbound: { msg: InboundMessage; rowId: string }[],
): void {
    if (statuses.length === 0 && inbound.length === 0) return;
    after(async () => {
        for (const s of statuses) {
            try {
                await applyStatus(s.providerMessageId, s.status);
            } catch (err) {
                log.error("[wa-assist/webhook] status update failed", {
                    waMessageId: s.providerMessageId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        const deps = defaultRouterDeps(env);
        for (const { msg, rowId } of inbound) {
            await routeMessage(msg, rowId, deps);
        }
    });
}
