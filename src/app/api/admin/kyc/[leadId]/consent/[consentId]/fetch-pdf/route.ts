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

        // Try the standard fetch + store flow first
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

        // Fallback: try to proxy the PDF directly from DigiO
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

        // Try download endpoint
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

            // Try getting document status to see what's available
            const statusUrl = `${digioBaseUrl}/v2/client/document/${encodeURIComponent(documentId)}`;
            const statusRes = await fetch(statusUrl, {
                method: "GET",
                headers: { Authorization: auth, Accept: "application/json" },
                cache: "no-store",
            });
            const statusData = statusRes.ok ? await statusRes.json().catch(() => null) : null;

            return NextResponse.json({
                success: false,
                error: {
                    message: `DigiO returned ${res.status} when downloading PDF. The document may not be fully signed yet.`,
                    digioStatus: statusData?.status || statusData?.agreement_status || "unknown",
                    documentId,
                },
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
