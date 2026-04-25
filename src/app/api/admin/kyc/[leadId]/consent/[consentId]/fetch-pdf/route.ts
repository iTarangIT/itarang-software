import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { consentRecords } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fetchAndStoreSignedConsent } from "@/lib/digio/fetch-signed-consent";
import { getDigioBaseUrl, getDigioBasicAuth } from "@/lib/digio/client";

const SIGNED_STATES = new Set(["signed", "completed", "executed", "success"]);
const PENDING_STATES = new Set([
    "requested",
    "pending",
    "sent",
    "in_progress",
    "opened",
    "viewed",
    "link_sent",
    "link_opened",
    "esign_in_progress",
]);
const FAILED_STATES = new Set(["expired", "failed", "rejected", "declined", "cancelled", "error"]);

/**
 * POST — Fetches the signed consent PDF from DigiO, stores in Supabase,
 * and updates the consent record. Returns the PDF URL.
 *
 * Flow:
 *   1. If signed_consent_url already cached, return it.
 *   2. Probe DigiO status; if not signed, surface a precise error and mirror
 *      state into consent_records so the UI badge stops lying.
 *   3. Delegate to fetchAndStoreSignedConsent (3-variant download + status-chase
 *      fallback + %PDF- validation). On success, persist the Supabase URL.
 */
export async function POST(
    _req: NextRequest,
    { params }: { params: Promise<{ leadId: string; consentId: string }> }
) {
    try {
        const { leadId, consentId } = await params;

        const [record] = await db
            .select()
            .from(consentRecords)
            .where(eq(consentRecords.id, consentId))
            .limit(1);

        if (!record) {
            return NextResponse.json(
                { success: false, error: { message: "Consent record not found" } },
                { status: 404 }
            );
        }

        if (record.signed_consent_url) {
            return NextResponse.json({
                success: true,
                pdfUrl: record.signed_consent_url,
                source: "cached",
            });
        }

        const documentId = record.esign_transaction_id;
        if (!documentId) {
            return NextResponse.json({
                success: false,
                error: { message: "No DigiO document ID found on this consent record. The consent may not have been sent via DigiO." },
            }, { status: 400 });
        }

        const auth = getDigioBasicAuth();
        if (!auth) {
            return NextResponse.json({
                success: false,
                error: { message: "DigiO credentials not configured" },
            }, { status: 500 });
        }

        const digioBaseUrl = getDigioBaseUrl();

        // Pre-flight: check DigiO's current status for this document. The
        // /download endpoint returns an opaque 500 when the document isn't
        // signed yet, which makes debugging painful. The status endpoint tells
        // us the real state so we can give the admin a precise error and also
        // sync our local consent_status row to match what DigiO believes.
        const statusUrl = `${digioBaseUrl}/v2/client/document/${encodeURIComponent(documentId)}`;
        let digioStatus: string | null = null;
        try {
            const statusRes = await fetch(statusUrl, {
                method: "GET",
                headers: { Authorization: auth, Accept: "application/json" },
                cache: "no-store",
            });
            if (statusRes.ok) {
                const payload = (await statusRes.json().catch(() => null)) as Record<string, unknown> | null;
                const parties = Array.isArray(payload?.signing_parties)
                    ? (payload?.signing_parties as Array<Record<string, unknown>>)
                    : [];
                const raw =
                    (payload?.agreement_status as string | undefined) ||
                    (payload?.status as string | undefined) ||
                    (parties[0]?.status as string | undefined) ||
                    null;
                digioStatus = raw ? String(raw).toLowerCase() : null;
            } else {
                console.warn("[fetch-pdf] DigiO status check failed:", statusRes.status);
            }
        } catch (e) {
            console.warn("[fetch-pdf] DigiO status check error:", e);
        }

        if (digioStatus && !SIGNED_STATES.has(digioStatus)) {
            const isFailed = FAILED_STATES.has(digioStatus);
            const isPending = PENDING_STATES.has(digioStatus);

            try {
                let localStatus: string | null = null;
                if (digioStatus === "expired") localStatus = "expired";
                else if (isFailed) localStatus = "esign_failed";
                else if (digioStatus === "viewed" || digioStatus === "opened") localStatus = "link_opened";

                if (localStatus && localStatus !== record.consent_status) {
                    await db.update(consentRecords)
                        .set({ consent_status: localStatus, updated_at: new Date() })
                        .where(eq(consentRecords.id, consentId));
                }
            } catch (e) {
                console.warn("[fetch-pdf] Failed to sync local consent_status:", e);
            }

            const message = isFailed
                ? `DigiO reports this consent as '${digioStatus}'. No signed PDF will be available.`
                : isPending
                    ? `Customer has not completed signing yet. DigiO status: '${digioStatus}'. Try again after the customer signs.`
                    : `DigiO reports status '${digioStatus}' — no signed PDF available yet.`;

            return NextResponse.json({
                success: false,
                error: { message, digioStatus, documentId },
            }, { status: 409 });
        }

        const stored = await fetchAndStoreSignedConsent(documentId, leadId);
        if (stored?.publicUrl) {
            const now = new Date();
            await db.update(consentRecords)
                .set({
                    signed_consent_url: stored.publicUrl,
                    signed_at: record.signed_at || now,
                    updated_at: now,
                })
                .where(eq(consentRecords.id, consentId));

            return NextResponse.json({
                success: true,
                pdfUrl: stored.publicUrl,
                source: "digio_stored",
            });
        }

        const message = digioStatus && SIGNED_STATES.has(digioStatus)
            ? `DigiO reports the document as '${digioStatus}' but every download variant failed. Check server logs for [fetchAndStoreSignedConsent] entries — most likely DIGIO_BASE_URL points at the wrong environment (sandbox vs prod) for this document.`
            : `Unable to download the signed PDF from DigiO. Check server logs for [fetchAndStoreSignedConsent] entries.`;

        return NextResponse.json({
            success: false,
            error: { message, digioStatus: digioStatus || "unknown", documentId },
        }, { status: 502 });
    } catch (error) {
        console.error("[fetch-pdf] Error:", error);
        const message = error instanceof Error ? error.message : "Server error";
        return NextResponse.json(
            { success: false, error: { message } },
            { status: 500 }
        );
    }
}
