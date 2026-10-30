// POST /api/webhooks/exotel/sms-status?key=<EXOTEL_SMS_STATUS_SECRET> — tracker ID 204.
//
// Exotel's StatusCallback for the EMI SMS (emi_customer_messages, E-365). The
// URL is set on each SMS by src/lib/exotel.ts when EXOTEL_SMS_STATUS_SECRET is
// set. Exotel posts a form with SmsSid, Status (queued | sending | submitted |
// sent | failed | failed-dnd) and DetailedStatus. Exotel's "sent" means the
// handset got it, so it maps to our "delivered". The key is checked the shared
// way (src/lib/security/webhookAuth.ts).

import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { applyEmiDelivery } from "@/lib/emi-messages/store";
import { guardWebhook, type WebhookProof } from "@/lib/security/webhookAuth";

export const dynamic = "force-dynamic";

function keyProof(secret: string | undefined, given: string | null): WebhookProof {
    if (!given) return "absent";
    if (!secret) return "invalid";
    const a = Buffer.from(given);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(new Uint8Array(a), new Uint8Array(b)) ? "valid" : "invalid";
}

function mapStatus(status: string): "delivered" | "failed" | "sent" | null {
    const s = status.toLowerCase();
    if (s === "sent") return "delivered";
    if (s.startsWith("failed")) return "failed";
    if (s === "submitted" || s === "sending") return "sent";
    return null;
}

export async function POST(req: Request) {
    const secret = process.env.EXOTEL_SMS_STATUS_SECRET?.trim();
    const refused = guardWebhook({
        route: "/api/webhooks/exotel/sms-status",
        secret,
        proof: keyProof(secret, new URL(req.url).searchParams.get("key")),
        configure: "Set EXOTEL_SMS_STATUS_SECRET; the SMS carry the callback URL with ?key=<that value>.",
    });
    if (refused) return refused;
    try {
        const type = req.headers.get("content-type") ?? "";
        const body: Record<string, unknown> = type.includes("application/json")
            ? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
            : Object.fromEntries(((await req.formData().catch(() => null)) ?? new FormData()).entries());
        const sid = String(body.SmsSid ?? body.Sid ?? "");
        const s = mapStatus(String(body.Status ?? ""));
        const updated = sid && s ? await applyEmiDelivery(sid, s) : false;
        return NextResponse.json({ ok: true, updated });
    } catch (err) {
        console.error("[exotel-sms-status] could not read the report:", err instanceof Error ? err.message : err);
        return NextResponse.json({ ok: false }, { status: 400 });
    }
}
