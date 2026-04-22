import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { consentRecords } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { fetchAndStoreSignedConsent } from "@/lib/digio/fetch-signed-consent";

function cleanEnv(value?: string) {
    return (value || "").trim().replace(/^["']|["']$/g, "");
}

function basicAuthHeader(clientId: string, clientSecret: string) {
    return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

/**
 * POST — Fetches the signed consent PDF from DigiO, stores in Supabase,
 * and updates the consent record. Returns the PDF URL.
 *
 * If Supabase storage fails, falls back to returning a direct DigiO proxy URL.
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

        // If we already have the PDF URL, return it
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

        const digioClientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
        const digioClientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
        const digioBaseUrl = cleanEnv(process.env.DIGIO_BASE_URL) || "https://api.digio.in";

        if (!digioClientId || !digioClientSecret) {
            return NextResponse.json({
                success: false,
                error: { message: "DigiO credentials not configured" },
            }, { status: 500 });
        }

        const auth = basicAuthHeader(digioClientId, digioClientSecret);

        // Pre-flight: check DigiO's current status for this document. DigiO's
        // /download endpoint returns an opaque 500 when the document isn't
        // signed yet, which makes debugging painful. The status endpoint tells
        // us the real state (requested / in_progress / signed / expired / ...)
        // so we can give the admin a precise error and also sync our local
        // consent_status row to match what DigiO believes.
        const statusUrl = `${digioBaseUrl}/v2/client/document/${encodeURIComponent(documentId)}`;
        let digioStatus: string | null = null;
        let digioStatusPayload: Record<string, unknown> | null = null;
        try {
            const statusRes = await fetch(statusUrl, {
                method: "GET",
                headers: { Authorization: auth, Accept: "application/json" },
                cache: "no-store",
            });
            if (statusRes.ok) {
                digioStatusPayload = (await statusRes.json().catch(() => null)) as Record<string, unknown> | null;
                const parties = Array.isArray(digioStatusPayload?.signing_parties)
                    ? (digioStatusPayload?.signing_parties as Array<Record<string, unknown>>)
                    : [];
                const raw =
                    (digioStatusPayload?.agreement_status as string | undefined) ||
                    (digioStatusPayload?.status as string | undefined) ||
                    (parties[0]?.status as string | undefined) ||
                    null;
                digioStatus = raw ? String(raw).toLowerCase() : null;
            } else {
                console.warn("[fetch-pdf] DigiO status check failed:", statusRes.status);
            }
        } catch (e) {
            console.warn("[fetch-pdf] DigiO status check error:", e);
        }

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

        // If DigiO says the document isn't signed, don't bother hitting the
        // download endpoint — tell the admin exactly what's happening and
        // sync our local consent_status so the badge stops lying.
        if (digioStatus && !SIGNED_STATES.has(digioStatus)) {
            const isFailed = FAILED_STATES.has(digioStatus);
            const isPending = PENDING_STATES.has(digioStatus);

            // Mirror DigiO's state into our DB so the UI badge reflects reality.
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

        // At this point either the status check confirmed signed, or the
        // status check itself failed and we proceed optimistically.
        const stored = await fetchAndStoreSignedConsent(documentId, leadId);
        if (stored?.publicUrl) {
            await db.update(consentRecords)
                .set({ signed_consent_url: stored.publicUrl, updated_at: new Date() })
                .where(eq(consentRecords.id, consentId));

            return NextResponse.json({
                success: true,
                pdfUrl: stored.publicUrl,
                source: "digio_stored",
            });
        }

        // Fallback: proxy the PDF directly from DigiO and persist on the fly.
        const downloadUrl = `${digioBaseUrl}/v2/client/document/download?document_id=${encodeURIComponent(documentId)}`;
        console.log("[fetch-pdf] Trying DigiO download:", downloadUrl);

        const res = await fetch(downloadUrl, {
            method: "GET",
            headers: { Authorization: auth, Accept: "application/pdf" },
            cache: "no-store",
        });

        if (!res.ok) {
            const errorText = await res.text().catch(() => "");
            console.error("[fetch-pdf] DigiO download failed:", res.status, errorText.slice(0, 300));

            const message = digioStatus && SIGNED_STATES.has(digioStatus)
                ? `DigiO says the document is '${digioStatus}' but the download endpoint returned ${res.status}. This looks like a DigiO-side issue — please retry in a minute.`
                : `DigiO returned ${res.status} when downloading PDF. The document may not be fully signed yet.`;

            return NextResponse.json({
                success: false,
                error: { message, digioStatus: digioStatus || "unknown", documentId },
            }, { status: 502 });
        }

        // We got the PDF — return it as a data URL so the admin can view it
        const pdfBuffer = await res.arrayBuffer();
        const pdfBase64 = Buffer.from(pdfBuffer).toString("base64");
        const dataUrl = `data:application/pdf;base64,${pdfBase64}`;

        // Also try to persist to Supabase in the background
        try {
            const { createClient } = await import("@supabase/supabase-js");
            const supabaseUrl = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
            const serviceRoleKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
            const bucket = cleanEnv(process.env.CONSENT_STORAGE_BUCKET) || "documents";

            if (supabaseUrl && serviceRoleKey) {
                const supabase = createClient(supabaseUrl, serviceRoleKey);
                const storagePath = `kyc/${leadId}/consent/signed-${Date.now()}.pdf`;

                const { error: upErr } = await supabase.storage
                    .from(bucket)
                    .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

                if (!upErr) {
                    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
                    if (urlData?.publicUrl) {
                        await db.update(consentRecords)
                            .set({ signed_consent_url: urlData.publicUrl, updated_at: new Date() })
                            .where(eq(consentRecords.id, consentId));
                        console.log("[fetch-pdf] PDF persisted to Supabase:", urlData.publicUrl);

                        return NextResponse.json({
                            success: true,
                            pdfUrl: urlData.publicUrl,
                            source: "digio_fresh_stored",
                        });
                    }
                } else {
                    console.warn("[fetch-pdf] Supabase upload failed:", upErr.message);
                }
            }
        } catch (e) {
            console.warn("[fetch-pdf] Background storage failed:", e);
        }

        // Return the data URL as fallback
        return NextResponse.json({
            success: true,
            pdfUrl: dataUrl,
            source: "digio_direct",
        });
    } catch (error) {
        console.error("[fetch-pdf] Error:", error);
        const message = error instanceof Error ? error.message : "Server error";
        return NextResponse.json(
            { success: false, error: { message } },
            { status: 500 }
        );
    }
}
