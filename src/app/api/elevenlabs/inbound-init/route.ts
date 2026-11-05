// POST /api/elevenlabs/inbound-init — ElevenLabs' conversation-initiation
// webhook for INBOUND calls on the Vobiz number (Priya KPI tracker task 9).
//
// ElevenLabs calls this before the callback agent speaks, with the caller's
// number; we answer with the dealer's context as dynamic variables
// (src/lib/ai-dialer/inboundContext.ts): which branch to open with
// (confirm_slot / do_it_now / warm_opener / complaint / unknown), the shop, the
// ISR who owns his callback, the promised slot and his last outcome. The call
// is logged in inbound_calls (E-376) here; the post-call webhook finishes it.
//
// Auth: a shared secret in the `x-itarang-secret` header (set on the agent's
// webhook in ElevenLabs), ELEVENLABS_INIT_WEBHOOK_SECRET on the server. Fails
// closed (503) when the server has no secret. Must answer fast: one lookup.

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { inboundBranch, inboundDynamicVariables } from "@/lib/ai-dialer/inboundContext";
import { lookupInbound, recordInboundInit } from "@/lib/ai-dialer/inbound";
import { alertMissingSecret } from "@/lib/security/configAlert";

export const dynamic = "force-dynamic";

function sameSecret(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
    const expected = process.env.ELEVENLABS_INIT_WEBHOOK_SECRET?.trim();
    if (!expected) {
        alertMissingSecret(
            "/api/elevenlabs/inbound-init",
            "ELEVENLABS_INIT_WEBHOOK_SECRET is not set, so inbound callers on the AI number get no context.",
        );
        return NextResponse.json({ error: "not configured" }, { status: 503 });
    }
    const given = req.headers.get("x-itarang-secret") ?? "";
    if (!sameSecret(given, expected)) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown> = {};
    try {
        body = (await req.json()) as Record<string, unknown>;
    } catch {
        return NextResponse.json({ error: "bad json" }, { status: 400 });
    }
    const caller = String(body.caller_id ?? body.from ?? "").trim();
    const callSid = typeof body.call_sid === "string" && body.call_sid.trim() ? body.call_sid.trim() : null;
    const now = new Date();
    const match = caller ? await lookupInbound(caller) : { lead: null, openCallback: null, lastOutcome: null };
    const branch = inboundBranch(match, now);
    // Logged before answering, but never allowed to delay or fail the answer.
    void recordInboundInit({ callSid, callerPhone: caller, match, branch });

    return NextResponse.json({
        type: "conversation_initiation_client_data",
        dynamic_variables: inboundDynamicVariables(match, caller, now),
    });
}
