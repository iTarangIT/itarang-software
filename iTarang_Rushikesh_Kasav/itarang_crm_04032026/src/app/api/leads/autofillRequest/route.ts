export const runtime = "nodejs";

import { db } from '@/lib/db';
import { auditLogs } from '@/lib/db/schema';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { extractTextFromImageBuffer } from '@/lib/ocr/tesseractOcr';
import { parseAadhaarText } from '@/lib/ocr/aadhaarParser';

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['dealer']);

    let formData;
    try {
        formData = await req.formData();
    } catch (e) {
        return errorResponse("Multipart form-data expected", 400);
    }

    const aadhaarFront = formData.get('aadhaarFront') as File | null;
    const aadhaarBack = formData.get('aadhaarBack') as File | null;

    if (!aadhaarFront || !aadhaarBack) {
        return errorResponse("Both Aadhaar Front and Back images are required", 400);
    }

    const MAX_SIZE = 5 * 1024 * 1024;
    // PDF validation already handles size, but check for files here.
    if (aadhaarFront.size > MAX_SIZE || aadhaarBack.size > MAX_SIZE) {
        return errorResponse("File size exceeds 5MB limit", 400);
    }

    // PDF Support: Disabled for now, returns 415.
    if (aadhaarFront.type === 'application/pdf' || aadhaarBack.type === 'application/pdf') {
        return errorResponse("PDF OCR not supported yet. Please upload JPG/PNG.", 415);
    }

    const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/jpg'];
    if (!ALLOWED_TYPES.includes(aadhaarFront.type) || !ALLOWED_TYPES.includes(aadhaarBack.type)) {
        return errorResponse("Invalid file type. Allowed: PNG, JPEG, JPG", 400);
    }

    const requestId = `OCR-${Date.now()}`;

    // 1. Initial Audit Log
    try {
        await db.insert(auditLogs).values({
            id: `AUDIT-REQ-${requestId}`,
            entity_type: 'system',
            entity_id: requestId,
            action: 'OCR_REQUESTED',
            changes: { front: aadhaarFront.name, back: aadhaarBack.name },
            performed_by: user.id,
            timestamp: new Date()
        });
    } catch (logErr) {
        console.error("Initial OCR log failed:", logErr);
    }

    try {
        // 2. Process Images (Sequential to avoid worker contention)
        const frontBuffer = Buffer.from(await aadhaarFront.arrayBuffer());
        const backBuffer = Buffer.from(await aadhaarBack.arrayBuffer());

        const frontText = await extractTextFromImageBuffer(frontBuffer);
        const backText = await extractTextFromImageBuffer(backBuffer);

        const combinedText = `${frontText}\n${backText}`.trim();

        // 3. Length / Quality Check
        if (combinedText.length < 20) {
            try {
                await db.insert(auditLogs).values({
                    id: `AUDIT-FAIL-LOW-${requestId}`,
                    entity_type: 'system',
                    entity_id: requestId,
                    action: 'OCR_FAILED',
                    changes: { reason: "Could not read enough text from documents" },
                    performed_by: user.id,
                    timestamp: new Date()
                });
            } catch (l) { }
            return errorResponse("Could not read document. Please upload a clearer image.", 422);
        }

        const parsedData = parseAadhaarText(combinedText);

        // 4. Success Audit Log
        try {
            await db.insert(auditLogs).values({
                id: `AUDIT-OK-${requestId}`,
                entity_type: 'system',
                entity_id: requestId,
                action: 'OCR_SUCCESS',
                changes: {
                    fields_found: Object.keys(parsedData).filter(k => !!(parsedData as any)[k])
                },
                performed_by: user.id,
                timestamp: new Date()
            });
        } catch (logErr) {
            console.error("Success OCR log failed:", logErr);
        }

        // Return mapped keys for direct form compatibility
        return successResponse({
            requestId,
            fullName: parsedData.fullName ?? "",
            fatherName: parsedData.fatherName ?? "",
            dob: parsedData.dob ?? "",
            address: parsedData.address ?? "",
            full_name: parsedData.fullName ?? "",
            father_or_husband_name: parsedData.fatherName ?? "",
            current_address: parsedData.address ?? ""
        });

    } catch (err: any) {
        console.error("OCR Final Error:", err?.message, err?.stack);

        // 5. Failure Audit Log (Always log failure on exception)
        try {
            await db.insert(auditLogs).values({
                id: `AUDIT-ERR-${requestId}`,
                entity_type: 'system',
                entity_id: requestId,
                action: 'OCR_FAILED',
                changes: { reason: "Processing failed or service error" },
                performed_by: user.id,
                timestamp: new Date()
            });
        } catch (logErr) {
            console.error("Failure OCR log failed:", logErr);
        }

        return errorResponse("OCR failed to process images. Please enter details manually.", 500);
    }
});
