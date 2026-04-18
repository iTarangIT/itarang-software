import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import { kycDocuments, personalDetails } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { extractDocumentOcr, type OcrDocType } from '@/lib/decentro';
import { extractTextFromImageBuffer } from '@/lib/ocr/tesseractOcr';
import { parseBankDocument } from '@/lib/ocr/bankDocParser';

// Map internal doc types to Decentro OCR doc types
const DECENTRO_OCR_MAP: Record<string, OcrDocType> = {
    pan_card: 'PAN',
    aadhaar_front: 'AADHAAR',
    aadhaar_back: 'AADHAAR',
};

// Doc types that use Tesseract fallback
const TESSERACT_TYPES = ['bank_statement', 'cheque_1', 'cheque_2', 'cheque_3', 'cheque_4', 'rc_copy'];

/** Helper: extract a string field from nested OCR response. Walks common nesting levels
 *  (kycResult, extractedData, result, ocrResult, data) and accepts both strings and numbers.
 */
function getField(data: Record<string, unknown>, ...keys: string[]): string | undefined {
    const targets: Record<string, unknown>[] = [data];
    for (const k of ['kycResult', 'extractedData', 'result', 'ocrResult', 'data', 'ocr_data']) {
        if (data[k] && typeof data[k] === 'object') targets.push(data[k] as Record<string, unknown>);
    }
    // Also look inside nested kycResult.extractedData etc.
    for (const t of [...targets]) {
        for (const k of ['kycResult', 'extractedData', 'result', 'ocrResult', 'data']) {
            if (t[k] && typeof t[k] === 'object') targets.push(t[k] as Record<string, unknown>);
        }
    }
    for (const t of targets) {
        for (const key of keys) {
            const v = t[key];
            if (typeof v === 'string' && v.trim()) return v.trim();
            if (typeof v === 'number' && Number.isFinite(v)) return String(v);
        }
    }
    return undefined;
}

/** Flatten address field that Decentro may return as an object {line1, line2, city, state, pincode}. */
function getAddress(data: Record<string, unknown>): string | undefined {
    // Traverse the same nesting levels as getField so addresses buried under
    // `ocr_data` (e.g. data.ocr_data.address) are discoverable.
    const targets: Record<string, unknown>[] = [data];
    for (const k of ['kycResult', 'extractedData', 'result', 'ocrResult', 'data', 'ocr_data']) {
        if (data[k] && typeof data[k] === 'object') targets.push(data[k] as Record<string, unknown>);
    }
    for (const t of [...targets]) {
        for (const k of ['kycResult', 'extractedData', 'result', 'ocrResult', 'data', 'ocr_data']) {
            if (t[k] && typeof t[k] === 'object') targets.push(t[k] as Record<string, unknown>);
        }
    }
    for (const t of targets) {
        // Case 1: plain string
        for (const key of ['address', 'full_address', 'fullAddress', 'currentAddress', 'current_address', 'localAddress', 'addressLine']) {
            const v = t[key];
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
        // Case 2: object — Decentro commonly returns { line1, line2, vtc, district, state, pincode, country }
        for (const key of ['address', 'addressObject', 'address_object', 'addressData']) {
            const v = t[key];
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                const o = v as Record<string, unknown>;
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
                ].filter((p) => typeof p === 'string' && (p as string).trim()).map((p) => (p as string).trim());
                if (parts.length > 0) return parts.join(', ');
            }
        }
    }
    return undefined;
}

/** Normalize a Decentro-returned Aadhaar ID into a clean 12-digit string (may be masked).
 *  Only accepts a full 12-digit number or the canonical masked shape (XXXX followed by 8 digits). */
function normalizeAadhaar(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const cleaned = raw.replace(/[^0-9Xx]/g, '');
    if (/^\d{12}$/.test(cleaned)) return cleaned;
    if (/^[Xx]{4}\d{8}$/.test(cleaned)) return cleaned;
    return undefined;
}

/** Parse various DOB formats Decentro may return into a Date, or null if unparseable.
 *  Rejects impossible calendar dates (e.g. 31-02-2024) via a round-trip check —
 *  JS normally silently shifts those instead of failing. */
function parseDob(raw: string | undefined): Date | null {
    if (!raw) return null;
    const s = raw.trim();

    const buildUtc = (y: number, m: number, d: number): Date | null => {
        if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
        if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
        const date = new Date(Date.UTC(y, m - 1, d));
        if (!Number.isFinite(date.getTime())) return null;
        // Round-trip: if JS normalised the components, this isn't a real calendar date.
        if (
            date.getUTCFullYear() !== y ||
            date.getUTCMonth() + 1 !== m ||
            date.getUTCDate() !== d
        ) return null;
        return date;
    };

    // DD-MM-YYYY or DD/MM/YYYY
    const ddmmyyyy = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
    if (ddmmyyyy) {
        const [, dd, mm, yyyy] = ddmmyyyy;
        return buildUtc(Number(yyyy), Number(mm), Number(dd));
    }

    // YYYY-MM-DD ISO
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
        const [, yyyy, mm, dd] = isoMatch;
        return buildUtc(Number(yyyy), Number(mm), Number(dd));
    }

    return null;
}

/** Upsert personalDetails — create if not exists, update only non-null fields */
async function saveToPersonalDetails(leadId: string, fields: Record<string, unknown>) {
    // Remove null/undefined values
    const cleanFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
        if (v !== null && v !== undefined && v !== '') cleanFields[k] = v;
    }
    if (Object.keys(cleanFields).length === 0) return;

    const existing = await db.select({ id: personalDetails.id })
        .from(personalDetails)
        .where(eq(personalDetails.lead_id, leadId))
        .limit(1);

    if (existing.length > 0) {
        await db.update(personalDetails)
            .set({ ...cleanFields, ocr_processed_at: new Date() })
            .where(eq(personalDetails.lead_id, leadId));
    } else {
        await db.insert(personalDetails).values({
            lead_id: leadId,
            ...cleanFields,
            ocr_processed_at: new Date(),
        });
    }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

        const { leadId } = await params;
        const { doc_type } = await req.json();

        if (!doc_type) {
            return NextResponse.json({ success: false, error: 'doc_type is required' }, { status: 400 });
        }

        // Find the document record by exact doc_type
        let [doc] = await db.select({
            id: kycDocuments.id,
            fileUrl: kycDocuments.file_url,
            fileName: kycDocuments.file_name,
            ocrData: kycDocuments.ocr_data,
        }).from(kycDocuments)
            .where(and(eq(kycDocuments.lead_id, leadId), eq(kycDocuments.doc_type, doc_type)))
            .limit(1);

        // Fallback: if no exact match, search all docs for this lead and try to identify the right one
        if (!doc) {
            console.log(`[OCR Fallback] No exact match for doc_type="${doc_type}" on lead=${leadId}. Searching all docs...`);
            const allDocs = await db.select({
                id: kycDocuments.id,
                fileUrl: kycDocuments.file_url,
                fileName: kycDocuments.file_name,
                ocrData: kycDocuments.ocr_data,
                docType: kycDocuments.doc_type,
            }).from(kycDocuments)
                .where(eq(kycDocuments.lead_id, leadId));

            console.log(`[OCR Fallback] Found ${allDocs.length} docs:`, allDocs.map(d => ({ id: d.id, docType: d.docType, fileName: d.fileName })));

            for (const candidate of allDocs) {
                if (!candidate.fileUrl) continue;
                try {
                    const fileRes = await fetch(candidate.fileUrl);
                    if (!fileRes.ok) { console.log(`[OCR Fallback] Failed to fetch file for doc ${candidate.id}: ${fileRes.status}`); continue; }
                    const buf = Buffer.from(await fileRes.arrayBuffer());
                    const ct = fileRes.headers.get('content-type') || 'image/jpeg';
                    const fname = candidate.fileName || 'doc.jpg';

                    // Strategy 1: Try Decentro OCR directly with expected type — if extraction succeeds, it's the right doc
                    const decentroOcrType = DECENTRO_OCR_MAP[doc_type];
                    if (decentroOcrType) {
                        try {
                            const blob = new Blob([buf], { type: ct });
                            const side: 'FRONT' | 'BACK' | undefined =
                                doc_type === 'aadhaar_front' ? 'FRONT'
                                : doc_type === 'aadhaar_back' ? 'BACK'
                                : undefined;
                            const ocrRes = await extractDocumentOcr(decentroOcrType, blob, fname, side);
                            // Decentro may use responseStatus or status field
                            const isSuccess = ocrRes.responseStatus === 'SUCCESS' || ocrRes.status === 'SUCCESS' || ocrRes.status === 200;
                            const ocrPayload = ocrRes.data || ocrRes.result || ocrRes.kycResult;
                            console.log(`[OCR Fallback] Decentro OCR for doc ${candidate.id}: isSuccess=${isSuccess}, hasData=${!!ocrPayload}`);
                            if (isSuccess && ocrPayload) {
                                await db.update(kycDocuments)
                                    .set({ doc_type: doc_type, ocr_data: ocrPayload, updated_at: new Date() })
                                    .where(eq(kycDocuments.id, candidate.id));
                                doc = { id: candidate.id, fileUrl: candidate.fileUrl, fileName: candidate.fileName, ocrData: ocrPayload };
                                console.log(`[OCR Fallback] Found match via Decentro OCR! Reclassified doc ${candidate.id} as ${doc_type}`);
                                break;
                            }
                        } catch (e) {
                            console.log(`[OCR Fallback] Decentro OCR failed for doc ${candidate.id}:`, e);
                        }
                    }

                    // Strategy 2: Tesseract-based detection for PAN (look for PAN number pattern)
                    if (!doc && doc_type === 'pan_card') {
                        console.log(`[OCR Fallback] Trying Tesseract PAN detection for doc ${candidate.id}...`);
                        try {
                            const text = await extractTextFromImageBuffer(buf);
                            console.log(`[OCR Fallback] Tesseract extracted ${text.length} chars from doc ${candidate.id}`);
                            const panMatch = text.match(/[A-Z]{5}\d{4}[A-Z]/);
                            if (panMatch) {
                                const ocrResult = { pan_number: panMatch[0], rawText: text, source: 'tesseract_fallback' };
                                await db.update(kycDocuments)
                                    .set({ doc_type: doc_type, ocr_data: ocrResult, updated_at: new Date() })
                                    .where(eq(kycDocuments.id, candidate.id));
                                doc = { id: candidate.id, fileUrl: candidate.fileUrl, fileName: candidate.fileName, ocrData: ocrResult };
                                console.log(`[OCR Fallback] Found PAN via Tesseract! PAN=${panMatch[0]}, reclassified doc ${candidate.id}`);
                                break;
                            } else {
                                console.log(`[OCR Fallback] No PAN pattern found in Tesseract text. First 200 chars: ${text.slice(0, 200)}`);
                            }
                        } catch (e) {
                            console.log(`[OCR Fallback] Tesseract PAN detection failed for doc ${candidate.id}:`, e);
                        }
                    }

                    // Strategy 3: Tesseract-based detection for RC (look for RC number pattern)
                    if (!doc && doc_type === 'rc_copy') {
                        try {
                            const text = await extractTextFromImageBuffer(buf);
                            const rcMatch = text.match(/[A-Z]{2}[\s\-.]?\d{1,2}[\s\-.]?[A-Z]{1,3}[\s\-.]?\d{1,4}/i);
                            if (rcMatch) {
                                const ocrResult = { rc_number: rcMatch[0].replace(/[\s.]/g, '-').toUpperCase(), rawText: text };
                                await db.update(kycDocuments)
                                    .set({ doc_type: doc_type, ocr_data: ocrResult, updated_at: new Date() })
                                    .where(eq(kycDocuments.id, candidate.id));
                                doc = { id: candidate.id, fileUrl: candidate.fileUrl, fileName: candidate.fileName, ocrData: ocrResult };
                                console.log(`[OCR Fallback] Found RC via Tesseract! RC=${rcMatch[0]}, reclassified doc ${candidate.id}`);
                                break;
                            }
                        } catch (e) {
                            console.log(`[OCR Fallback] Tesseract RC detection failed for doc ${candidate.id}:`, e);
                        }
                    }

                    // Strategy 4: Tesseract-based detection for bank docs (look for account/IFSC patterns)
                    if (!doc && ['bank_statement', 'cheque_1', 'cheque_2', 'cheque_3', 'cheque_4'].includes(doc_type)) {
                        try {
                            const text = await extractTextFromImageBuffer(buf);
                            const bankData = parseBankDocument(text);
                            if (bankData.accountNumber || bankData.ifsc) {
                                const ocrResult = {
                                    account_number: bankData.accountNumber || null,
                                    ifsc: bankData.ifsc || null,
                                    bank_name: bankData.bankName || null,
                                    branch: bankData.branch || null,
                                    rawText: text,
                                };
                                await db.update(kycDocuments)
                                    .set({ doc_type: doc_type, ocr_data: ocrResult, updated_at: new Date() })
                                    .where(eq(kycDocuments.id, candidate.id));
                                doc = { id: candidate.id, fileUrl: candidate.fileUrl, fileName: candidate.fileName, ocrData: ocrResult };
                                console.log(`[OCR Fallback] Found bank doc via Tesseract! reclassified doc ${candidate.id}`);
                                break;
                            }
                        } catch (e) {
                            console.log(`[OCR Fallback] Tesseract bank detection failed for doc ${candidate.id}:`, e);
                        }
                    }
                } catch (e) {
                    console.log(`[OCR Fallback] Error processing candidate doc ${candidate.id}:`, e);
                    continue;
                }
            }
        }

        if (!doc) {
            return NextResponse.json({ success: false, error: `No ${doc_type} document found for this lead` }, { status: 404 });
        }

        // Return cached OCR data if available (already saved to DB on first run)
        if (doc.ocrData && Object.keys(doc.ocrData as object).length > 0) {
            return NextResponse.json({
                success: true,
                ocr_data: doc.ocrData,
                source: 'db',
                doc_type,
            });
        }

        // No cached data — fetch the file and run OCR
        if (!doc.fileUrl) {
            return NextResponse.json({ success: false, error: 'Document has no file URL' }, { status: 400 });
        }

        const fileRes = await fetch(doc.fileUrl);
        if (!fileRes.ok) {
            return NextResponse.json({ success: false, error: 'Failed to fetch document file' }, { status: 500 });
        }

        const fileBuffer = Buffer.from(await fileRes.arrayBuffer());
        const contentType = fileRes.headers.get('content-type') || 'image/jpeg';
        const fileName = doc.fileName || `${doc_type}.jpg`;

        let ocrData: Record<string, unknown> = {};
        let source: 'decentro' | 'tesseract' = 'decentro';

        const decentroType = DECENTRO_OCR_MAP[doc_type];

        if (decentroType) {
            // Use Decentro OCR for supported types
            const blob = new Blob([fileBuffer], { type: contentType });
            const side: 'FRONT' | 'BACK' | undefined =
                doc_type === 'aadhaar_front' ? 'FRONT'
                : doc_type === 'aadhaar_back' ? 'BACK'
                : undefined;
            const decentroRes = await extractDocumentOcr(decentroType, blob, fileName, side);
            const success = decentroRes.responseStatus === 'SUCCESS' || decentroRes.status === 'SUCCESS' || decentroRes.status === 200;
            const decentroPayload = decentroRes.data || decentroRes.result || decentroRes.kycResult;
            if (success && decentroPayload) {
                ocrData = decentroPayload;
                source = 'decentro';
            } else {
                // Fallback to Tesseract
                const text = await extractTextFromImageBuffer(fileBuffer);
                ocrData = { rawText: text, source: 'tesseract_fallback' };
                source = 'tesseract';
            }
        } else if (TESSERACT_TYPES.includes(doc_type)) {
            // Use Tesseract for bank docs and RC
            const text = await extractTextFromImageBuffer(fileBuffer);
            source = 'tesseract';

            if (doc_type === 'rc_copy') {
                const rcMatch = text.match(/[A-Z]{2}[\s\-.]?\d{1,2}[\s\-.]?[A-Z]{1,3}[\s\-.]?\d{1,4}/i);
                ocrData = {
                    rc_number: rcMatch?.[0]?.replace(/[\s.]/g, '-').toUpperCase() || null,
                    rawText: text,
                };
            } else {
                const bankData = parseBankDocument(text);
                ocrData = {
                    account_number: bankData.accountNumber || null,
                    ifsc: bankData.ifsc || null,
                    bank_name: bankData.bankName || null,
                    branch: bankData.branch || null,
                    rawText: text,
                };
            }
        } else {
            return NextResponse.json({ success: false, error: `OCR not supported for doc_type: ${doc_type}` }, { status: 400 });
        }

        // ── 1. Store OCR result in kycDocuments ──────────────────────────────
        await db.update(kycDocuments)
            .set({ ocr_data: ocrData, updated_at: new Date() })
            .where(eq(kycDocuments.id, doc.id));

        // ── 2. Save extracted fields to personalDetails (persistent DB storage) ──
        if (doc_type === 'pan_card') {
            const panNo = getField(ocrData, 'pan_number', 'panNumber', 'id_number', 'idNumber', 'pan', 'panNo');
            const fatherName = getField(ocrData, 'fatherName', 'father_name', 'fatherOrHusbandName');
            const dob = getField(ocrData, 'dob', 'dateOfBirth', 'date_of_birth');
            const parsedDob = parseDob(dob);
            await saveToPersonalDetails(leadId, {
                pan_no: panNo?.toUpperCase(),
                father_husband_name: fatherName,
                ...(parsedDob ? { dob: parsedDob } : {}),
            });
        } else if (doc_type === 'aadhaar_front' || doc_type === 'aadhaar_back') {
            // Decentro's Aadhaar OCR returns idNumber / nameOnDocument / dateOfBirth / fatherName / address.
            // Front typically yields name + DOB + gender; back yields ID number + address + father's name.
            // We extract everything we can from both sides and saveToPersonalDetails ignores empty values.
            const aadhaarNo = normalizeAadhaar(
                getField(
                    ocrData,
                    'idNumber', 'id_number',
                    'aadhaar_number', 'aadhaarNumber', 'aadhaarNo', 'aadhaar_no',
                    'uid', 'uidNumber', 'aadhaar',
                    'maskedAadhaar', 'masked_aadhaar',
                ),
            );
            const nameOnDoc = getField(
                ocrData,
                'nameOnDocument', 'name_on_document',
                'name', 'fullName', 'full_name', 'holderName',
            );
            const fatherName = getField(
                ocrData,
                'fatherName', 'father_name', 'fathersName', 'fathers_name',
                'fatherOrHusbandName', 'father_or_husband_name',
                'careOf', 'careof', 'care_of', 'co',
                'guardianName', 'guardian_name',
            );
            const address = getAddress(ocrData);
            const pincode = getField(
                ocrData,
                'pincode', 'pinCode', 'pin_code', 'pin', 'postalCode', 'postal_code', 'zip',
            );
            const dobStr = getField(
                ocrData,
                'dob', 'dateOfBirth', 'date_of_birth', 'DOB',
            );
            const gender = getField(ocrData, 'gender', 'sex');
            const parsedDob = parseDob(dobStr);

            // Log only presence flags + non-PII context so server logs don't
            // carry Aadhaar IDs, raw DOBs, pincodes, or gender.
            console.log(
                `[Admin OCR] Aadhaar ${doc_type} extracted: leadId=${leadId}, aadhaar=${aadhaarNo ? 'Y' : 'N'}, name=${nameOnDoc ? 'Y' : 'N'}, father=${fatherName ? 'Y' : 'N'}, addr=${address ? 'Y' : 'N'}, dob=${parsedDob ? 'Y' : 'N'}, pincode=${pincode ? 'Y' : 'N'}, gender=${gender ? 'Y' : 'N'}`,
            );

            await saveToPersonalDetails(leadId, {
                aadhaar_no: aadhaarNo,
                father_husband_name: fatherName,
                local_address: address && pincode && !address.includes(pincode) ? `${address}, ${pincode}` : address,
                ...(parsedDob ? { dob: parsedDob } : {}),
            });
        } else if (doc_type === 'rc_copy') {
            const rcNumber = ocrData.rc_number as string | undefined;
            if (rcNumber) {
                await saveToPersonalDetails(leadId, { vehicle_rc: rcNumber });
            }
        } else if (['bank_statement', 'cheque_1', 'cheque_2', 'cheque_3', 'cheque_4'].includes(doc_type)) {
            await saveToPersonalDetails(leadId, {
                bank_account_number: ocrData.account_number,
                bank_ifsc: ocrData.ifsc,
                bank_name: ocrData.bank_name,
                bank_branch: ocrData.branch,
            });
        }

        return NextResponse.json({
            success: true,
            ocr_data: ocrData,
            source,
            doc_type,
        });
    } catch (error) {
        console.error('Admin OCR error:', error);
        return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
    }
}
