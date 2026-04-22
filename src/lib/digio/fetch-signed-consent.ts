import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
    cleanEnv,
    getDigioBaseUrl,
    getDigioBasicAuth,
} from "./client";

function isValidPdfBuffer(buffer: ArrayBuffer | null | undefined): buffer is ArrayBuffer {
    if (!buffer || buffer.byteLength < 500) return false;
    const head = new Uint8Array(buffer, 0, 5);
    return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d;
}

async function fetchPdfVariant(
    url: string,
    auth: string,
): Promise<{ ok: true; buffer: ArrayBuffer } | { ok: false; reason: string }> {
    try {
        const res = await fetch(url, {
            method: "GET",
            headers: { Authorization: auth, Accept: "application/pdf, application/octet-stream, */*" },
            cache: "no-store",
        });

        if (!res.ok) {
            const snippet = await res.text().catch(() => "");
            return { ok: false, reason: `HTTP ${res.status}: ${snippet.slice(0, 200)}` };
        }

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("json")) {
            const snippet = await res.text().catch(() => "");
            return { ok: false, reason: `JSON instead of PDF: ${snippet.slice(0, 200)}` };
        }

        const buffer = await res.arrayBuffer();
        if (!isValidPdfBuffer(buffer)) {
            return { ok: false, reason: `Invalid PDF (size=${buffer.byteLength}, missing %PDF- prefix)` };
        }

        return { ok: true, buffer };
    } catch (err) {
        return { ok: false, reason: `fetch error: ${err instanceof Error ? err.message : String(err)}` };
    }
}

/**
 * Downloads the signed consent PDF from Digio for a given document ID,
 * uploads it to Supabase storage, and returns the public URL.
 *
 * Tries 3 endpoint shapes (Digio has changed these over time) before giving up:
 *   1. GET /v2/client/document/download?document_id={id}
 *   2. GET /v2/client/document/{id}/download
 *   3. GET /v2/client/document/{id}  → follow signed_file_url / executed_file_url / download_url
 *
 * Validates that each candidate response is an actual PDF (%PDF- magic, >500 bytes)
 * before uploading — prevents storing JSON error bodies as "signed.pdf".
 *
 * Path convention (per BRD §2.2): /kyc/{leadId}/consent/signed-{timestamp}.pdf
 *
 * Returns null on any failure with a detailed console.warn for each stage so
 * production traces pinpoint which variant broke.
 */
export async function fetchAndStoreSignedConsent(
    documentId: string,
    leadId: string,
): Promise<{ publicUrl: string; storagePath: string } | null> {
    const digioBaseUrl = getDigioBaseUrl();
    const auth = getDigioBasicAuth();
    const supabaseUrl = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
    const serviceRoleKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
    const bucket = cleanEnv(process.env.CONSENT_STORAGE_BUCKET) || "documents";

    if (!documentId || !leadId || !auth || !supabaseUrl || !serviceRoleKey) {
        console.warn("[fetchAndStoreSignedConsent] missing env or args", {
            hasDocId: !!documentId,
            hasLeadId: !!leadId,
            hasDigioAuth: !!auth,
            hasSupabase: !!(supabaseUrl && serviceRoleKey),
            digioBaseUrl,
        });
        return null;
    }

    const directVariants = [
        `${digioBaseUrl}/v2/client/document/download?document_id=${encodeURIComponent(documentId)}`,
        `${digioBaseUrl}/v2/client/document/${encodeURIComponent(documentId)}/download`,
    ];

    let pdfBuffer: ArrayBuffer | null = null;
    const failures: string[] = [];

    for (const url of directVariants) {
        const result = await fetchPdfVariant(url, auth);
        if (result.ok) {
            pdfBuffer = result.buffer;
            break;
        }
        failures.push(`${url} → ${result.reason}`);
    }

    if (!pdfBuffer) {
        // Final fallback — ask DigiO for the document status and chase
        // whatever signed-file URL it returns.
        const statusUrl = `${digioBaseUrl}/v2/client/document/${encodeURIComponent(documentId)}`;
        try {
            const statusRes = await fetch(statusUrl, {
                method: "GET",
                headers: { Authorization: auth, Accept: "application/json" },
                cache: "no-store",
            });
            if (statusRes.ok) {
                const statusData = (await statusRes.json().catch(() => null)) as Record<string, unknown> | null;
                const signedFileUrl =
                    (statusData?.signed_file_url as string | undefined) ||
                    (statusData?.signed_agreement_url as string | undefined) ||
                    (statusData?.executed_file_url as string | undefined) ||
                    (statusData?.file_url as string | undefined) ||
                    (statusData?.download_url as string | undefined) ||
                    null;
                if (signedFileUrl) {
                    const result = await fetchPdfVariant(signedFileUrl, auth);
                    if (result.ok) {
                        pdfBuffer = result.buffer;
                    } else {
                        failures.push(`status-chase ${signedFileUrl} → ${result.reason}`);
                    }
                } else {
                    failures.push(`status ${statusUrl} → no signed_file_url field in response`);
                }
            } else {
                failures.push(`status ${statusUrl} → HTTP ${statusRes.status}`);
            }
        } catch (err) {
            failures.push(`status ${statusUrl} → ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    if (!pdfBuffer) {
        console.error("[fetchAndStoreSignedConsent] all download variants failed", {
            documentId,
            leadId,
            digioBaseUrl,
            failures,
        });
        return null;
    }

    try {
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
            console.error("[fetchAndStoreSignedConsent] Supabase upload error", {
                documentId,
                leadId,
                storagePath,
                message: upErr.message,
            });
            return null;
        }

        const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
        if (!urlData?.publicUrl) {
            console.warn("[fetchAndStoreSignedConsent] no public URL returned", { storagePath });
            return null;
        }

        console.log("[fetchAndStoreSignedConsent] stored signed consent", { storagePath, documentId, leadId });
        return { publicUrl: urlData.publicUrl, storagePath };
    } catch (err) {
        console.error("[fetchAndStoreSignedConsent] supabase stage error", {
            documentId,
            leadId,
            err: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}
