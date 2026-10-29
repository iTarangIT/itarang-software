// POST /api/webhooks/msg91/dlr?key=<the MSG91 DLR secret> — tracker ID 204.
//
// MSG91 delivery reports for the EMI SMS (emi_customer_messages, E-365).
// Configure in MSG91 → Settings → Webhook (delivery report) with this URL and
// the key. MSG91 posts a JSON array (or a form field `data` holding one) of
// { requestId, numbers: [{ status, desc }] } — or flat { requestId, status }.
// The key is checked the shared way (src/lib/security/webhookAuth.ts): a wrong
// key is refused; with WEBHOOK_AUTH_STRICT on, so is a missing one.

import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { applyEmiDelivery } from "@/lib/emi-messages/store";
import { guardWebhook, type WebhookProof } from "@/lib/security/webhookAuth";

export const dynamic = "force-dynamic";

type Report = { requestId?: string; request_id?: string; status?: string | number; desc?: string; numbers?: Report[] };

function keyProof(secret: string | undefined, given: string | null): WebhookProof {
    if (!given) return "absent";
    if (!secret) return "invalid";
    const a = Buffer.from(given);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b) ? "valid" : "invalid";
}

/** MSG91 status → ours. 1 = delivered; 2, 9, 16, 17, 25, 26 = failed / rejected; 8 = with the operator. */
function mapStatus(r: Report): "delivered" | "failed" | "sent" | null {
    const desc = String(r.desc ?? "").toUpperCase();
    const code = String(r.status ?? "").toUpperCase();
    if (desc.includes("DELIVERED") || code === "1" || code === "DELIVERED") return "delivered";
    if (/FAIL|REJECT|NDNC|BLOCK|EXPIRED/.test(desc) || ["2", "9", "16", "17", "25", "26", "FAILED", "REJECTED"].includes(code)) return "failed";
    if (code === "8" || desc.includes("SUBMITTED") || desc.includes("SENT")) return "sent";
    return null;
}

async function readReports(req: Request): Promise<Report[]> {
    const type = req.headers.get("content-type") ?? "";
    let raw: unknown;
    if (type.includes("application/json")) {
        raw = await req.json().catch(() => null);
    } else {
        const form = await req.formData().catch(() => null);
        const data = form?.get("data");
        raw = typeof data === "string" ? JSON.parse(data) : null;
    }
    if (typeof raw === "object" && raw && "data" in (raw as object) && typeof (raw as { data: unknown }).data === "string") {
        raw = JSON.parse((raw as { data: string }).data);
    }
    return Array.isArray(raw) ? (raw as Report[]) : raw ? [raw as Report] : [];
}

export async function POST(req: Request) {
    const secret = process.env.MSG91_DLR_SECRET?.trim();
    const refused = guardWebhook({
        route: "/api/webhooks/msg91/dlr",
        secret,
        proof: keyProof(secret, new URL(req.url).searchParams.get("key")),
        configure: "Set MSG91_DLR_SECRET and add ?key=<that value> to the MSG91 delivery-report URL.",
    });
    if (refused) return refused;
    let updated = 0;
    try {
        for (const r of await readReports(req)) {
            const id = r.requestId ?? r.request_id;
            if (!id) continue;
            for (const n of r.numbers?.length ? r.numbers : [r]) {
                const s = mapStatus(n);
                if (s && (await applyEmiDelivery(String(id), s))) updated++;
            }
        }
    } catch (err) {
        console.error("[msg91-dlr] could not read the report:", err instanceof Error ? err.message : err);
        return NextResponse.json({ ok: false }, { status: 400 });
    }
    return NextResponse.json({ ok: true, updated });
}
