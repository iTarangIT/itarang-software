// Online store → CRM "Buy on finance" enquiry (Store R-15, decision D-12).
//
//   POST — x-store-key check → JSON → schema → lead on the iTarang house
//          dealer (idempotent on storeRef) → { ok, leadId, duplicate? }.
//
// The contract shop.itarang.com is built against:
//   headers  Content-Type: application/json, x-store-key: <ONLINE_STORE_API_KEY>
//   body     { storeRef, name, mobile (10 digits, no +91), pincode (6 digits),
//              productSku|null, productTitle|null, productUrl|null,
//              pricePaise|null, page: "product" | "checkout" }
//
// Unauthenticated by session on purpose: the store has no login. It is on the
// public list (src/lib/security/publicApi.ts) and the shared key IS the
// credential, compared in constant time.
//
// Status codes (the store retries anything but 2xx):
//   201 lead created
//   200 duplicate storeRef — the first lead's id, duplicate: true
//   400 body is not JSON or fails the schema
//   401 x-store-key missing or wrong
//   500 DB failure — nothing recorded, so the retry reprocesses it
//   503 ONLINE_STORE_API_KEY not set, or no house dealer on this environment

import { after, NextResponse } from "next/server";

import { errorMessage } from "@/lib/api-utils";
import { notifyOnlineStoreFinanceLead } from "@/lib/notifications/events";
import { HouseDealerMissingError, createOnlineStoreFinanceLead } from "@/lib/online-store/finance-lead";
import { STORE_KEY_HEADER, financeLeadSchema, getOnlineStoreKey, verifyStoreKey } from "@/lib/online-store/intake";
import { alertMissingSecret } from "@/lib/security/configAlert";

// Node runtime: node:crypto + the postgres pool.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/integrations/online-store/finance-lead";

export async function POST(req: Request): Promise<Response> {
    const key = getOnlineStoreKey();
    if (!key) {
        console.error("[OnlineStore/finance-lead] ONLINE_STORE_API_KEY is not set");
        alertMissingSecret(
            ROUTE,
            "Online store finance enquiries are being REFUSED because ONLINE_STORE_API_KEY is not set (>= 32 chars, same value as the store's CRM key).",
        );
        return NextResponse.json({ ok: false, error: "not configured" }, { status: 503 });
    }

    if (!verifyStoreKey(key, req.headers.get(STORE_KEY_HEADER))) {
        console.warn("[OnlineStore/finance-lead] rejected: bad or missing", STORE_KEY_HEADER);
        return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    let json: unknown;
    try {
        json = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "body is not valid JSON" }, { status: 400 });
    }

    const parsed = financeLeadSchema.safeParse(json);
    if (!parsed.success) {
        return NextResponse.json(
            { ok: false, error: "invalid enquiry", issues: parsed.error.issues.slice(0, 10) },
            { status: 400 },
        );
    }
    const input = parsed.data;

    try {
        const result = await createOnlineStoreFinanceLead(input, json);
        if (result.duplicate) {
            return NextResponse.json({ ok: true, leadId: result.leadId, duplicate: true }, { status: 200 });
        }
        // After the 201: a notification must never delay or fail the store's call.
        after(() =>
            notifyOnlineStoreFinanceLead({
                leadId: result.leadId,
                customerName: input.name,
                mobile: input.mobile,
                pincode: input.pincode,
                productTitle: input.productTitle,
                page: input.page,
            }),
        );
        return NextResponse.json({ ok: true, leadId: result.leadId }, { status: 201 });
    } catch (err) {
        if (err instanceof HouseDealerMissingError) {
            console.error("[OnlineStore/finance-lead]", err.message, "— run scripts/provision-house-dealer.mjs");
            return NextResponse.json({ ok: false, error: "not configured" }, { status: 503 });
        }
        console.error("[OnlineStore/finance-lead] store failed:", input.storeRef, errorMessage(err));
        return NextResponse.json({ ok: false, error: "store failed" }, { status: 500 });
    }
}
