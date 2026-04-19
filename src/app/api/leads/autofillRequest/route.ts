export const runtime = "nodejs";

import { db } from '@/lib/db';
import { auditLogs } from '@/lib/db/schema';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { extractDocumentOcr } from '@/lib/decentro';

type AnyRec = Record<string, unknown>;

function collectTargets(data: AnyRec): AnyRec[] {
    const targets: AnyRec[] = [data];
    const keys = ['kycResult', 'extractedData', 'result', 'ocrResult', 'data', 'ocr_data'];
    for (const t of [...targets]) {
        for (const k of keys) {
            const v = t[k];
            if (v && typeof v === 'object' && !Array.isArray(v)) targets.push(v as AnyRec);
        }
    }
    // One more pass for deeply nested payloads
    for (const t of [...targets]) {
        for (const k of keys) {
            const v = t[k];
            if (v && typeof v === 'object' && !Array.isArray(v) && !targets.includes(v as AnyRec)) {
                targets.push(v as AnyRec);
            }
        }
    }
    return targets;
}

function getField(data: AnyRec, ...keys: string[]): string | undefined {
    for (const t of collectTargets(data)) {
        for (const key of keys) {
            const v = t[key];
            if (typeof v === 'string' && v.trim()) return v.trim();
            if (typeof v === 'number' && Number.isFinite(v)) return String(v);
        }
    }
    return undefined;
}

function getAddress(data: AnyRec): string | undefined {
    for (const t of collectTargets(data)) {
        for (const key of ['address', 'full_address', 'fullAddress', 'currentAddress', 'current_address', 'localAddress', 'addressLine']) {
            const v = t[key];
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
        for (const key of ['address', 'addressObject', 'address_object', 'addressData']) {
            const v = t[key];
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                const o = v as AnyRec;
                const parts = [
                    o.line1 || o.addressLine1 || o.address_line_1,
                    o.line2 || o.addressLine2 || o.address_line_2,
                    o.street,
                    o.locality || o.landmark,
                    o.vtc || o.village || o.town || o.city,
                    o.subdistrict || o.sub_district,
                    o.district,
                    o.state,
                    o.country,
                    o.pincode || o.pin || o.postalCode || o.zip,
                ].filter(p => typeof p === 'string' && (p as string).trim()).map(p => (p as string).trim());
                if (parts.length > 0) return parts.join(', ');
            }
        }
    }
    return undefined;
}

function parseDobToIso(raw?: string): string | undefined {
    if (!raw) return undefined;
    const s = raw.trim();
    const ddmmyyyy = s.match(/^(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})$/);
    if (ddmmyyyy) {
        const [, dd, mm, yyyy] = ddmmyyyy;
        return `${yyyy}-${mm}-${dd}`;
    }
    const yyyymmdd = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (yyyymmdd) return s;
    const d = new Date(s);
    if (Number.isFinite(d.getTime())) return d.toISOString().slice(0, 10);
    return undefined;
}

function sanitizeName(raw?: string): string | undefined {
    if (!raw) return undefined;
    // Strip everything except letters, spaces, dots, apostrophes, hyphens.
    // This prevents address tokens (numbers, commas, '/') from leaking into name fields.
    const cleaned = raw.replace(/[^A-Za-z\s.'-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) return undefined;
    // Guard against absurdly long "names" (address accidentally captured)
    if (cleaned.split(/\s+/).length > 6) return undefined;
    return cleaned;
}

const DECENTRO_OCR_TIMEOUT_MS = 12_000;

async function runDecentroSide(
    fileBlob: Blob,
    filename: string,
    side: 'FRONT' | 'BACK',
): Promise<AnyRec | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DECENTRO_OCR_TIMEOUT_MS);
    try {
        const res = await extractDocumentOcr('AADHAAR', fileBlob, filename, side, controller.signal);
        const success =
            res.responseStatus === 'SUCCESS' ||
            res.status === 'SUCCESS' ||
            res.status === 200 ||
            (!!res.data && typeof res.data === 'object');
        if (!success) {
            console.warn(`[Lead OCR] Decentro ${side} not success:`, JSON.stringify(res).slice(0, 500));
            return null;
        }
        return (res.data || res.result || res.kycResult || res) as AnyRec;
    } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') {
            console.error(`[Lead OCR] Decentro ${side} timed out after ${DECENTRO_OCR_TIMEOUT_MS}ms`);
        } else {
            console.error(`[Lead OCR] Decentro ${side} threw:`, e);
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['dealer']);

    let formData: FormData;
    try {
        formData = await req.formData();
    } catch {
        return errorResponse('Multipart form-data expected', 400);
    }

    const aadhaarFront = formData.get('aadhaarFront') as File | null;
    const aadhaarBack = formData.get('aadhaarBack') as File | null;

    if (!aadhaarFront || !aadhaarBack) {
        return errorResponse('Both Aadhaar Front and Back images are required', 400);
    }

    const MAX_SIZE = 6 * 1024 * 1024;
    if (aadhaarFront.size > MAX_SIZE || aadhaarBack.size > MAX_SIZE) {
        return errorResponse('File size exceeds 6MB limit', 400);
    }

    if (aadhaarFront.type === 'application/pdf' || aadhaarBack.type === 'application/pdf') {
        return errorResponse('PDF not supported. Please upload JPG/PNG.', 415);
    }

    const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/jpg'];
    if (!ALLOWED_TYPES.includes(aadhaarFront.type) || !ALLOWED_TYPES.includes(aadhaarBack.type)) {
        return errorResponse('Invalid file type. Allowed: PNG, JPEG, JPG', 400);
    }

    const requestId = `OCR-${Date.now()}`;

    try {
        await db.insert(auditLogs).values({
            id: `AUDIT-REQ-${requestId}`,
            entity_type: 'system',
            entity_id: requestId,
            action: 'OCR_REQUESTED',
            changes: { front: aadhaarFront.name, back: aadhaarBack.name, provider: 'decentro' },
            performed_by: user.id,
            timestamp: new Date(),
        });
    } catch (logErr) {
        console.error('[Lead OCR] Initial audit log failed:', logErr);
    }

    try {
        const frontBlob = new Blob([await aadhaarFront.arrayBuffer()], { type: aadhaarFront.type });
        const backBlob = new Blob([await aadhaarBack.arrayBuffer()], { type: aadhaarBack.type });

        // Run both sides in parallel — Decentro is I/O bound.
        const [frontData, backData] = await Promise.all([
            runDecentroSide(frontBlob, aadhaarFront.name || 'aadhaar_front.jpg', 'FRONT'),
            runDecentroSide(backBlob, aadhaarBack.name || 'aadhaar_back.jpg', 'BACK'),
        ]);

        if (!frontData && !backData) {
            try {
                await db.insert(auditLogs).values({
                    id: `AUDIT-FAIL-${requestId}`,
                    entity_type: 'system',
                    entity_id: requestId,
                    action: 'OCR_FAILED',
                    changes: { reason: 'Decentro returned no data for either side' },
                    performed_by: user.id,
                    timestamp: new Date(),
                });
            } catch { /* ignore */ }
            return errorResponse('Could not read document. Please upload clearer images.', 422);
        }

        // Front is authoritative for name/DOB/gender.
        // Back is authoritative for Aadhaar number, address, and care-of/father name.
        const nameRaw =
            (frontData && getField(frontData, 'nameOnDocument', 'name_on_document', 'name', 'fullName', 'full_name', 'holderName')) ||
            (backData && getField(backData, 'nameOnDocument', 'name_on_document', 'name', 'fullName', 'full_name', 'holderName'));

        const fatherRaw =
            (backData && getField(backData, 'fatherName', 'father_name', 'fathersName', 'fathers_name', 'fatherOrHusbandName', 'father_or_husband_name', 'careOf', 'careof', 'care_of', 'co', 'guardianName', 'guardian_name')) ||
            (frontData && getField(frontData, 'fatherName', 'father_name', 'fathersName', 'fathers_name', 'fatherOrHusbandName', 'father_or_husband_name', 'careOf', 'careof', 'care_of', 'co', 'guardianName', 'guardian_name'));

        const dobRaw =
            (frontData && getField(frontData, 'dob', 'dateOfBirth', 'date_of_birth', 'DOB')) ||
            (backData && getField(backData, 'dob', 'dateOfBirth', 'date_of_birth', 'DOB'));

        const address =
            (backData && getAddress(backData)) ||
            (frontData && getAddress(frontData));

        const pincode =
            (backData && getField(backData, 'pincode', 'pinCode', 'pin_code', 'pin', 'postalCode', 'postal_code', 'zip')) ||
            (frontData && getField(frontData, 'pincode', 'pinCode', 'pin_code', 'pin', 'postalCode', 'postal_code', 'zip'));

        const gender =
            (frontData && getField(frontData, 'gender', 'sex')) ||
            (backData && getField(backData, 'gender', 'sex'));

        const fullName = sanitizeName(nameRaw);
        const fatherName = sanitizeName(fatherRaw);
        const dobIso = parseDobToIso(dobRaw);
        const finalAddress = address && pincode && !address.includes(pincode)
            ? `${address}, ${pincode}`
            : address;

        console.log(
            `[Lead OCR] Decentro extraction: name=${fullName ? 'Y' : 'N'} father=${fatherName ? 'Y' : 'N'} dob=${dobIso || 'N'} addr=${finalAddress ? 'Y' : 'N'} gender=${gender || '—'}`,
        );

        try {
            await db.insert(auditLogs).values({
                id: `AUDIT-OK-${requestId}`,
                entity_type: 'system',
                entity_id: requestId,
                action: 'OCR_SUCCESS',
                changes: {
                    provider: 'decentro',
                    fields_found: {
                        full_name: !!fullName,
                        father_or_husband_name: !!fatherName,
                        dob: !!dobIso,
                        current_address: !!finalAddress,
                    },
                },
                performed_by: user.id,
                timestamp: new Date(),
            });
        } catch (logErr) {
            console.error('[Lead OCR] Success audit log failed:', logErr);
        }

        return successResponse({
            requestId,
            full_name: fullName ?? '',
            father_or_husband_name: fatherName ?? '',
            dob: dobIso ?? '',
            current_address: finalAddress ?? '',
            gender: gender ?? '',
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Lead OCR] Final error:', msg);
        try {
            await db.insert(auditLogs).values({
                id: `AUDIT-ERR-${requestId}`,
                entity_type: 'system',
                entity_id: requestId,
                action: 'OCR_FAILED',
                changes: { reason: msg || 'Processing failed' },
                performed_by: user.id,
                timestamp: new Date(),
            });
        } catch { /* ignore */ }
        return errorResponse('OCR failed to process images. Please enter details manually.', 500);
    }
});
