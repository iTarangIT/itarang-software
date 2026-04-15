import { createClient as createSupabaseClient } from "@supabase/supabase-js";

function cleanEnv(value?: string) {
    return (value || "").trim().replace(/^["']|["']$/g, "");
}

function basicAuthHeader(clientId: string, clientSecret: string) {
    return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

/**
 * Downloads the signed consent PDF from Digio for a given document ID,
 * uploads it to Supabase storage, and returns the public URL.
 *
 * Path convention (per BRD §2.2): /kyc/{leadId}/consent/signed-{timestamp}.pdf
 *
 * Returns null on any failure (caller should preserve existing URL if any).
 */
export async function fetchAndStoreSignedConsent(
    documentId: string,
    leadId: string,
): Promise<{ publicUrl: string; storagePath: string } | null> {
    const digioBaseUrl = cleanEnv(process.env.DIGIO_BASE_URL) || "https://ext.digio.in:444";
    const digioClientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
    const digioClientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
    const supabaseUrl = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
    const serviceRoleKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
    const bucket = cleanEnv(process.env.CONSENT_STORAGE_BUCKET) || "documents";

    if (!documentId || !leadId || !digioClientId || !digioClientSecret || !supabaseUrl || !serviceRoleKey) {
        console.warn("[fetchAndStoreSignedConsent] missing env or args", {
            hasDocId: !!documentId,
            hasLeadId: !!leadId,
            hasDigioCreds: !!(digioClientId && digioClientSecret),
            hasSupabase: !!(supabaseUrl && serviceRoleKey),
        });
        return null;
    }

    try {
        const auth = basicAuthHeader(digioClientId, digioClientSecret);
        const downloadUrl = `${digioBaseUrl}/v2/client/document/download?document_id=${encodeURIComponent(documentId)}`;

        const res = await fetch(downloadUrl, {
            method: "GET",
            headers: { Authorization: auth, Accept: "application/pdf" },
            cache: "no-store",
        });

        if (!res.ok) {
            console.warn("[fetchAndStoreSignedConsent] Digio download failed", res.status);
            return null;
        }

        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("pdf") && !contentType.includes("octet-stream")) {
            const text = await res.text().catch(() => "");
            console.warn("[fetchAndStoreSignedConsent] unexpected content type:", contentType, text.slice(0, 200));
            return null;
        }

        const pdfBuffer = await res.arrayBuffer();
        if (pdfBuffer.byteLength < 100) {
            console.warn("[fetchAndStoreSignedConsent] PDF too small:", pdfBuffer.byteLength);
            return null;
        }

        const supabase = createSupabaseClient(supabaseUrl, serviceRoleKey);
        const timestamp = Date.now();
        const storagePath = `kyc/${leadId}/consent/signed-${timestamp}.pdf`;

        const { error: upErr } = await supabase.storage
            .from(bucket)
            .upload(storagePath, pdfBuffer, {
                contentType: "application/pdf",
                upsert: true,
            });

        if (upErr) {
            console.error("[fetchAndStoreSignedConsent] Supabase upload error:", upErr.message);
            return null;
        }

        const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
        if (!urlData?.publicUrl) {
            console.warn("[fetchAndStoreSignedConsent] no public URL returned");
            return null;
        }

        console.log("[fetchAndStoreSignedConsent] stored signed consent:", storagePath);
        return { publicUrl: urlData.publicUrl, storagePath };
    } catch (err) {
        console.error("[fetchAndStoreSignedConsent] error:", err);
        return null;
    }
}
