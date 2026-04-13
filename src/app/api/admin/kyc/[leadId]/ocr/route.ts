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

/** Helper: extract a string field from nested OCR response */
function getField(data: Record<string, unknown>, ...keys: string[]): string | undefined {
    const targets: Record<string, unknown>[] = [data];
    for (const k of ['kycResult', 'extractedData', 'result', 'ocrResult']) {
        if (data[k] && typeof data[k] === 'object') targets.push(data[k] as Record<string, unknown>);
    }
    for (const t of targets) {
        for (const key of keys) {
            const v = t[key];
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
    }
    return undefined;
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
                            const ocrRes = await extractDocumentOcr(decentroOcrType, blob, fname);
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
            const decentroRes = await extractDocumentOcr(decentroType, blob, fileName);
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
            await saveToPersonalDetails(leadId, {
                pan_no: panNo?.toUpperCase(),
                father_husband_name: fatherName,
                ...(dob ? { dob: new Date(dob) } : {}),
            });
        } else if (doc_type === 'aadhaar_front' || doc_type === 'aadhaar_back') {
            const aadhaarNo = getField(ocrData, 'aadhaar_number', 'aadhaarNumber', 'uid', 'aadhaar');
            const fatherName = getField(ocrData, 'fatherName', 'father_name', 'fatherOrHusbandName', 'careOf');
            const address = getField(ocrData, 'address', 'full_address', 'currentAddress');
            const dob = getField(ocrData, 'dob', 'dateOfBirth', 'date_of_birth');
            await saveToPersonalDetails(leadId, {
                aadhaar_no: aadhaarNo,
                father_husband_name: fatherName,
                local_address: address,
                ...(dob ? { dob: new Date(dob) } : {}),
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
