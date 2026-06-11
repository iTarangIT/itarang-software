// Meta WhatsApp Cloud API webhook (design §9).
//
//   GET  — Meta subscription handshake: echo hub.challenge when the verify
//          token matches (you set the same token in env + Meta's webhook config).
//   POST — Ingress: verify x-hub-signature-256 → dedupe → fast-ack 200, then
//          process each message in after() (download media, Gemini, Decentro,
//          DB writes). All heavy work happens OUT of the request path so Meta
//          always gets its 200 within the timeout.

import { after, NextResponse } from "next/server";

import { getAdapter } from "@/lib/whatsapp";
import { recordInbound, runTurn } from "@/lib/whatsapp/orchestrator";

// Node runtime: we use Buffer + crypto (HMAC) and the postgres pool.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const adapter = getAdapter();
  const challenge = adapter.verifyChallenge(new URL(req.url));
  if (challenge !== null) {
    // Meta requires the raw challenge string echoed back, not JSON.
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(req: Request): Promise<Response> {
  const adapter = getAdapter();

  // Raw body is required for HMAC verification — read it before parsing.
  const rawBody = await req.text();

  if (!adapter.verifyInbound(req.headers, rawBody)) {
    console.error("[WhatsApp/webhook] signature verification failed");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let events;
  try {
    events = adapter.parseInbound(rawBody);
  } catch (err) {
    console.error("[WhatsApp/webhook] parse error:", err);
    // 200 so Meta doesn't retry an unparseable payload forever.
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  for (const event of events) {
    if (event.type === "status") {
      // Delivery receipt — cheap, process inline.
      after(() => runTurn(event));
      continue;
    }
    if (!event.providerMessageId) continue;

    // Dedupe: a duplicate webhook delivery returns false → skip.
    let isNew = false;
    try {
      isNew = await recordInbound(event);
    } catch (err) {
      console.error("[WhatsApp/webhook] recordInbound failed:", err);
    }
    if (!isNew) continue;

    after(() => runTurn(event));
  }

  return NextResponse.json({ status: "ok" }, { status: 200 });
}
