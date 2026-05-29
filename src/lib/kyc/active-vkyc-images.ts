// Collects face images for the customer that we can hand to Decentro's
// Active Video Liveness `face_image_urls` / `face_image_base64s` fields.
//
// Decentro matches the live video against these images. The more authoritative
// sources we have, the more reliable the match score. Max 4 images total.
//
// Sources, in order of preference:
//   1. Aadhaar photo from DigiLocker (base64, biometric-grade) —
//      digilocker_transactions.aadhaar_extracted_data.photo_base64
//   2. Passport photo uploaded by dealer in Step 2 docs (public URL) —
//      kyc_documents.file_url where doc_type='passport_photo'

import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { digilockerTransactions, kycDocuments } from '@/lib/db/schema';

export interface CustomerFaceImages {
    urls: string[];
    base64s: string[];
    sources: { aadhaar: boolean; passport: boolean };
    missing: string[];
}

/**
 * Strip the `data:image/...;base64,` prefix if present so Decentro receives
 * the raw base64 payload they expect. Tolerates already-stripped inputs.
 */
function stripBase64Prefix(s: string): string {
    const idx = s.indexOf(';base64,');
    return idx === -1 ? s : s.slice(idx + ';base64,'.length);
}

export async function getCustomerFaceImagesForLead(
    leadId: string,
): Promise<CustomerFaceImages> {
    const urls: string[] = [];
    const base64s: string[] = [];
    const sources = { aadhaar: false, passport: false };
    const missing: string[] = [];

    // 1. Latest DigiLocker transaction with extracted Aadhaar photo
    try {
        const [dl] = await db
            .select({
                aadhaar_extracted_data: digilockerTransactions.aadhaar_extracted_data,
            })
            .from(digilockerTransactions)
            .where(eq(digilockerTransactions.lead_id, leadId))
            .orderBy(desc(digilockerTransactions.updated_at))
            .limit(1);

        const aadhaarData = (dl?.aadhaar_extracted_data ?? null) as
            | Record<string, string | null>
            | null;
        const photo = aadhaarData?.photo_base64 || null;
        if (typeof photo === 'string' && photo.trim().length > 0) {
            base64s.push(stripBase64Prefix(photo));
            sources.aadhaar = true;
        } else {
            missing.push('Aadhaar photo (complete DigiLocker eAadhaar)');
        }
    } catch {
        missing.push('Aadhaar photo (lookup failed)');
    }

    // 2. Passport photo uploaded by dealer (public URL)
    try {
        const [doc] = await db
            .select({ file_url: kycDocuments.file_url })
            .from(kycDocuments)
            .where(
                and(
                    eq(kycDocuments.lead_id, leadId),
                    eq(kycDocuments.doc_type, 'passport_photo'),
                    eq(kycDocuments.doc_for, 'customer'),
                ),
            )
            .orderBy(desc(kycDocuments.updated_at))
            .limit(1);

        const url = doc?.file_url || null;
        if (typeof url === 'string' && url.trim().length > 0) {
            urls.push(url);
            sources.passport = true;
        } else {
            missing.push('Passport photo (upload via Step 2 docs)');
        }
    } catch {
        missing.push('Passport photo (lookup failed)');
    }

    // Decentro caps at 4 total — trim defensively (we only push 2 today).
    while (urls.length + base64s.length > 4) {
        if (urls.length > 0) urls.pop();
        else base64s.pop();
    }

    return { urls, base64s, sources, missing };
}
