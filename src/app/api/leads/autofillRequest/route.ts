export const runtime = "nodejs";

import { db } from '@/lib/db';
import { auditLogs, leadDocuments } from '@/lib/db/schema';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { extractTextFromImageBuffer } from '@/lib/ocr/tesseractOcr';
import { parseAadhaarText } from '@/lib/ocr/aadhaarParser';
import { extractDocumentOcr } from '@/lib/decentro';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { inArray } from 'drizzle-orm';

const BUCKET = 'private-documents';

async function fetchDocumentBuffer(
    storagePath: string,
): Promise<{ buffer: Buffer; contentType: string }> {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(storagePath);
    if (error || !data) {
        throw new Error(`Failed to fetch document: ${error?.message ?? 'unknown'}`);
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    // Supabase Blob.type is usually set from the upload; default to jpeg.
    const contentType = data.type || 'image/jpeg';
    return { buffer, contentType };
}

// Walk Decentro's nested response shapes for a string field under any of
// the given keys. Decentro's OCR payload can be at .data, .data.kycResult,
// .result, or similar — same pattern as the admin KYC OCR route.
function getField(
    res: Record<string, unknown> | null | undefined,
    ...keys: string[]
): string | undefined {
    if (!res) return undefined;
    const targets: Record<string, unknown>[] = [res];
    for (const k of ['data', 'result', 'kycResult', 'extractedData', 'ocrResult']) {
        const v = res[k];
        if (v && typeof v === 'object') targets.push(v as Record<string, unknown>);
        // one level deeper
        if (v && typeof v === 'object') {
            for (const k2 of ['kycResult', 'extractedData', 'result']) {
                const inner = (v as Record<string, unknown>)[k2];
                if (inner && typeof inner === 'object') targets.push(inner as Record<string, unknown>);
            }
        }
    }
    for (const t of targets) {
        for (const key of keys) {
            const val = t[key];
            if (typeof val === 'string' && val.trim()) return val.trim();
        }
    }
    return undefined;
}

// Decentro returns DOB in several formats: "DD/MM/YYYY", "DD-MM-YYYY",
// "YYYY-MM-DD", or "DD.MM.YYYY". Normalize to ISO YYYY-MM-DD for the form.
function normalizeDob(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const s = raw.trim();
    // Already ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (!m) return undefined;
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

type OcrFields = {
    fullName?: string;
    fatherName?: string;
    dob?: string;
    address?: string;
    aadhaarNumber?: string;
};

function extractFromDecentro(res: any): OcrFields {
    return {
        fullName: getField(res, 'name', 'full_name', 'fullName', 'holderName'),
        fatherName: getField(
            res,
            'fatherName',
            'father_name',
            'fatherOrHusbandName',
            'careOf',
            'care_of',
        ),
        dob: normalizeDob(
            getField(res, 'dob', 'dateOfBirth', 'date_of_birth', 'birthDate'),
        ),
        address: getField(res, 'address', 'full_address', 'currentAddress'),
        aadhaarNumber: getField(res, 'aadhaar_number', 'aadhaarNumber', 'uid', 'aadhaar'),
    };
}

function isDecentroSuccess(res: any): boolean {
    if (!res) return false;
    const top = res.responseStatus ?? res.status;
    return top === 'SUCCESS' || top === 200 || top === 'success';
}

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['dealer']);

    let payload: { idType?: string; leadId?: string; frontId?: string; backId?: string };
    try {
        payload = await req.json();
    } catch {
        return errorResponse('JSON body expected with { frontId, backId }', 400);
    }

    const { frontId, backId, leadId } = payload;

    if (!frontId || !backId) {
        return errorResponse('Both frontId and backId are required', 400);
    }

    const docs = await db
        .select()
        .from(leadDocuments)
        .where(inArray(leadDocuments.id, [frontId, backId]));

    const frontDoc = docs.find((d) => d.id === frontId);
    const backDoc = docs.find((d) => d.id === backId);

    if (!frontDoc || !backDoc) {
        return errorResponse('One or both documents not found', 404);
    }
    if (
        frontDoc.dealer_id !== user.dealer_id ||
        backDoc.dealer_id !== user.dealer_id
    ) {
        return errorResponse('Not authorized for these documents', 403);
    }

    const requestId = `OCR-${Date.now()}`;

    try {
        await db.insert(auditLogs).values({
            id: `AUDIT-REQ-${requestId}`,
            entity_type: 'system',
            entity_id: requestId,
            action: 'OCR_REQUESTED',
            changes: { frontId, backId, leadId: leadId ?? null },
            performed_by: user.id,
            timestamp: new Date(),
        });
    } catch (logErr) {
        console.error('Initial OCR log failed:', logErr);
    }

    try {
        const [front, back] = await Promise.all([
            fetchDocumentBuffer(frontDoc.storage_path),
            fetchDocumentBuffer(backDoc.storage_path),
        ]);

        // Primary: Decentro AADHAAR OCR on both sides. Front usually returns
        // name/DOB/aadhaar#, back usually returns address. We merge.
        let decentroFields: OcrFields = {};
        let decentroSucceeded = false;

        try {
            const frontBlob = new Blob([new Uint8Array(front.buffer)], {
                type: front.contentType,
            });
            const backBlob = new Blob([new Uint8Array(back.buffer)], {
                type: back.contentType,
            });
            const frontName = frontDoc.storage_path.split('/').pop() ?? 'front.jpg';
            const backName = backDoc.storage_path.split('/').pop() ?? 'back.jpg';

            const [frontRes, backRes] = await Promise.all([
                extractDocumentOcr('AADHAAR', frontBlob, frontName).catch((e) => {
                    console.error('[Autofill] Decentro front OCR threw:', e?.message);
                    return null;
                }),
                extractDocumentOcr('AADHAAR', backBlob, backName).catch((e) => {
                    console.error('[Autofill] Decentro back OCR threw:', e?.message);
                    return null;
                }),
            ]);

            const frontFields = isDecentroSuccess(frontRes)
                ? extractFromDecentro(frontRes)
                : {};
            const backFields = isDecentroSuccess(backRes) ? extractFromDecentro(backRes) : {};

            // Prefer front for identity fields; back for address.
            decentroFields = {
                fullName: frontFields.fullName ?? backFields.fullName,
                fatherName: frontFields.fatherName ?? backFields.fatherName,
                dob: frontFields.dob ?? backFields.dob,
                address: backFields.address ?? frontFields.address,
                aadhaarNumber: frontFields.aadhaarNumber ?? backFields.aadhaarNumber,
            };

            decentroSucceeded = !!(
                decentroFields.fullName ||
                decentroFields.dob ||
                decentroFields.aadhaarNumber
            );

            console.log('[Autofill] Decentro result:', {
                succeeded: decentroSucceeded,
                fields: Object.keys(decentroFields).filter(
                    (k) => !!(decentroFields as any)[k],
                ),
            });
        } catch (e: any) {
            console.error('[Autofill] Decentro block failed:', e?.message);
        }

        // Fallback: Tesseract + regex parser if Decentro gave us nothing
        // useful. Far less accurate on Indian IDs but better than nothing.
        let finalFields: OcrFields = decentroFields;
        let source: 'decentro' | 'tesseract' = 'decentro';

        if (!decentroSucceeded) {
            console.log('[Autofill] Falling back to Tesseract');
            source = 'tesseract';
            try {
                const frontText = await extractTextFromImageBuffer(front.buffer);
                const backText = await extractTextFromImageBuffer(back.buffer);
                const combined = `${frontText}\n${backText}`.trim();

                if (combined.length < 20) {
                    try {
                        await db.insert(auditLogs).values({
                            id: `AUDIT-FAIL-LOW-${requestId}`,
                            entity_type: 'system',
                            entity_id: requestId,
                            action: 'OCR_FAILED',
                            changes: { reason: 'Low text content', chars: combined.length },
                            performed_by: user.id,
                            timestamp: new Date(),
                        });
                    } catch {
                        /* ignore */
                    }
                    return successResponse({
                        requestId,
                        ocrStatus: 'failed',
                        ocrError:
                            'Could not read enough text from the uploaded images. Please retake clearer photos.',
                        auto_filled: false,
                    });
                }

                const parsed = parseAadhaarText(combined);
                finalFields = {
                    fullName: parsed.fullName,
                    fatherName: parsed.fatherName,
                    dob: parsed.dob,
                    address: parsed.address,
                };
            } catch (tessErr: any) {
                console.error('[Autofill] Tesseract also failed:', tessErr?.message);
                // Fall through with empty finalFields → partial/failed response below
            }
        }

        const missing = (['fullName', 'fatherName', 'dob', 'address'] as const).filter(
            (k) => !finalFields[k],
        );
        const ocrStatus =
            missing.length === 4
                ? 'failed'
                : missing.length > 0
                    ? 'partial'
                    : 'success';

        try {
            await db.insert(auditLogs).values({
                id: `AUDIT-${ocrStatus.toUpperCase()}-${requestId}`,
                entity_type: 'system',
                entity_id: requestId,
                action: ocrStatus === 'failed' ? 'OCR_FAILED' : 'OCR_SUCCESS',
                changes: {
                    source,
                    fields_found: Object.keys(finalFields).filter(
                        (k) => !!(finalFields as any)[k],
                    ),
                    missing,
                },
                performed_by: user.id,
                timestamp: new Date(),
            });
        } catch (logErr) {
            console.error('Audit log failed:', logErr);
        }

        if (ocrStatus === 'failed') {
            return successResponse({
                requestId,
                ocrStatus: 'failed',
                ocrError:
                    'Could not detect fields from the Aadhaar images. Please retake clearer photos or enter details manually.',
                auto_filled: false,
            });
        }

        return successResponse({
            requestId,
            ocrStatus,
            missingFields: missing.length > 0 ? missing : undefined,
            source,
            fullName: finalFields.fullName ?? '',
            fatherName: finalFields.fatherName ?? '',
            dob: finalFields.dob ?? '',
            address: finalFields.address ?? '',
            aadhaarNumber: finalFields.aadhaarNumber ?? '',
            // Aliases for the lead form's expected field names
            full_name: finalFields.fullName ?? '',
            father_or_husband_name: finalFields.fatherName ?? '',
            current_address: finalFields.address ?? '',
            auto_filled: true,
        });
    } catch (err: any) {
        console.error('[Autofill] Final error:', err?.message, err?.stack);
        try {
            await db.insert(auditLogs).values({
                id: `AUDIT-ERR-${requestId}`,
                entity_type: 'system',
                entity_id: requestId,
                action: 'OCR_FAILED',
                changes: { reason: err?.message ?? 'Processing failed' },
                performed_by: user.id,
                timestamp: new Date(),
            });
        } catch {
            /* ignore */
        }

        return successResponse({
            requestId,
            ocrStatus: 'failed',
            ocrError: 'OCR failed to process images. Please enter details manually.',
            auto_filled: false,
        });
    }
});
