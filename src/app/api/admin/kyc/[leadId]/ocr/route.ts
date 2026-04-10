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

        // Find the document record
        const [doc] = await db.select({
            id: kycDocuments.id,
            fileUrl: kycDocuments.file_url,
            fileName: kycDocuments.file_name,
            ocrData: kycDocuments.ocr_data,
        }).from(kycDocuments)
            .where(and(eq(kycDocuments.lead_id, leadId), eq(kycDocuments.doc_type, doc_type)))
            .limit(1);

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
            const success = decentroRes.responseStatus === 'SUCCESS';
            if (success) {
                ocrData = decentroRes.data || {};
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
