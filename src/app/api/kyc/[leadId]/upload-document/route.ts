import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { kycDocuments, leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createClient } from '@/lib/supabase/server';
import {
    extractDocumentOcr,
    classifyDocument,
    getExpectedDocClass,
    compareOcrWithLead,
    type OcrDocType,
    type OcrComparisonField,
} from '@/lib/decentro';
import {
    buildDealerEditLockMessage,
    isDealerKycEditsLocked,
} from '@/lib/kyc/admin-workflow';

// Map doc_type to Decentro OCR document type
const OCR_DOC_MAP: Record<string, OcrDocType> = {
    'aadhaar_front': 'AADHAAR',
    'aadhaar_back': 'AADHAAR',
    'pan_card': 'PAN',
    'address_proof': 'AADHAAR',
    'rc_copy': 'DRIVING_LICENSE',
};

type DecentroOcrResponse = {
    responseStatus?: string;
    message?: string;
    data?: Record<string, unknown>;
};

type DecentroClassificationResponse = {
    data?: {
        documentType?: string;
        [key: string]: unknown;
    };
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;

        if (await isDealerKycEditsLocked(leadId)) {
            return NextResponse.json(
                { success: false, error: { message: buildDealerEditLockMessage() } },
                { status: 409 }
            );
        }

        const formData = await req.formData();
        const file = formData.get('file') as File;
        const docType = formData.get('docType') as string;

        if (!file || !docType) {
            return NextResponse.json({ success: false, error: { message: 'File and docType are required' } }, { status: 400 });
        }

        // Validate file size (5MB max)
        if (file.size > 5 * 1024 * 1024) {
            return NextResponse.json({ success: false, error: { message: 'File size must be less than 5MB' } }, { status: 400 });
        }

        // Upload to Supabase Storage
        const supabase = await createClient();
        const fileName = `kyc/${leadId}/${docType}_${Date.now()}.${file.name.split('.').pop()}`;
        const buffer = Buffer.from(await file.arrayBuffer());

        const { error: uploadError } = await supabase.storage
            .from('documents')
            .upload(fileName, buffer, { contentType: file.type, upsert: true });

        if (uploadError) {
            return NextResponse.json({ success: false, error: { message: 'Upload failed: ' + uploadError.message } }, { status: 500 });
        }

        const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);

        // Generate document ID
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        const docId = `KYCDOC-${dateStr}-${seq}`;

        // Upsert document record
        await db.insert(kycDocuments).values({
            id: docId,
            lead_id: leadId,
            doc_type: docType,
            file_url: urlData.publicUrl,
            file_name: file.name,
            file_size: file.size,
            verification_status: 'pending',
        }).onConflictDoNothing();

        // Auto-trigger classification + OCR for supported doc types
        let ocrData: Record<string, unknown> | null = null;
        let ocrComparison: OcrComparisonField[] | null = null;
        let classificationResult: DecentroClassificationResponse | null = null;
        let ocrFailed = false;
        let ocrError: string | null = null;

        const ocrDocType = OCR_DOC_MAP[docType];
        const blob = new Blob([buffer], { type: file.type });

        // Step 1: Classify document (non-blocking - classification may not be available)
        try {
            classificationResult = await classifyDocument(blob, file.name) as DecentroClassificationResponse | null;
            const expectedClass = getExpectedDocClass(docType);
            const detectedTypeRaw = classificationResult?.data?.documentType;

            if (typeof detectedTypeRaw === 'string') {
                const detectedType = detectedTypeRaw.toUpperCase();
                if (expectedClass !== 'UNKNOWN' && detectedType !== expectedClass && detectedType !== 'UNKNOWN') {
                    // Document type mismatch - warn but don't block
                    await db.update(kycDocuments)
                        .set({
                            verification_status: 'failed',
                            failed_reason: `Document mismatch: Expected ${expectedClass} but detected ${detectedType}. Please upload the correct document.`,
                            api_response: classificationResult,
                            updated_at: new Date(),
                        })
                        .where(eq(kycDocuments.id, docId));

                    return NextResponse.json({
                        success: true,
                        file_url: urlData.publicUrl,
                        doc_id: docId,
                        classification: {
                            expected: expectedClass,
                            detected: detectedType,
                            mismatch: true,
                        },
                        ocr_failed: false,
                        warning: `Document type mismatch: Expected ${expectedClass} but detected ${detectedType}`,
                    });
                }
            }
        } catch {
            // Classification API not available - continue with OCR
        }

        // Step 2: Run OCR for supported document types
        if (ocrDocType) {
            try {
                const ocrRes = await extractDocumentOcr(ocrDocType, blob, file.name) as DecentroOcrResponse;

                if (ocrRes.responseStatus === 'SUCCESS' && ocrRes.data) {
                    ocrData = ocrRes.data;

                    // Load lead data for comparison
                    const leadRows = await db.select({
                        full_name: leads.full_name,
                        father_or_husband_name: leads.father_or_husband_name,
                        dob: leads.dob,
                        phone: leads.phone,
                        current_address: leads.current_address,
                    }).from(leads).where(eq(leads.id, leadId)).limit(1);

                    if (leadRows.length > 0) {
                        const leadRow = leadRows[0];
                        ocrComparison = compareOcrWithLead(ocrData as Record<string, unknown>, {
                            full_name: leadRow.full_name || undefined,
                            father_or_husband_name: leadRow.father_or_husband_name || undefined,
                            dob: leadRow.dob ? leadRow.dob.toISOString() : undefined,
                            phone: leadRow.phone || undefined,
                            current_address: leadRow.current_address || undefined,
                        }, docType);
                    }

                    // Update document with OCR data
                    await db.update(kycDocuments)
                        .set({
                            ocr_data: ocrData,
                            api_response: ocrRes,
                            verification_status: 'in_progress',
                            updated_at: new Date(),
                        })
                        .where(eq(kycDocuments.id, docId));
                } else {
                    ocrFailed = true;
                    ocrError = ocrRes.message || 'OCR extraction failed. Please ensure the image is clear.';

                    await db.update(kycDocuments)
                        .set({
                            verification_status: 'failed',
                            failed_reason: ocrError,
                            api_response: ocrRes,
                            updated_at: new Date(),
                        })
                        .where(eq(kycDocuments.id, docId));
                }
            } catch {
                ocrFailed = true;
                ocrError = 'OCR service unavailable. Please enter details manually.';

                await db.update(kycDocuments)
                    .set({
                        verification_status: 'failed',
                        failed_reason: ocrError,
                        updated_at: new Date(),
                    })
                    .where(eq(kycDocuments.id, docId));
            }
        }

        return NextResponse.json({
            success: true,
            file_url: urlData.publicUrl,
            doc_id: docId,
            ocr_data: ocrData,
            ocr_comparison: ocrComparison,
            ocr_failed: ocrFailed,
            ocr_error: ocrError,
            classification: classificationResult?.data || null,
            enable_manual_entry: ocrFailed,
        });
    } catch (error) {
        console.error('[KYC Upload] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
