import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { kycDocuments } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { createClient } from '@/lib/supabase/server';
import {
    buildDealerEditLockMessage,
    isDealerKycEditsLocked,
} from '@/lib/kyc/admin-workflow';

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
        const docType = (formData.get('docType') || formData.get('documentType')) as string;

        if (!file || !docType) {
            return NextResponse.json(
                { success: false, error: { message: 'File and docType are required' } },
                { status: 400 }
            );
        }

        if (file.size > 5 * 1024 * 1024) {
            return NextResponse.json(
                { success: false, error: { message: 'File size must be less than 5MB' } },
                { status: 400 }
            );
        }

        // Upload to Supabase Storage
        const supabase = await createClient();
        const ext = file.name.split('.').pop() || 'bin';
        const fileName = `kyc/${leadId}/${docType}_${Date.now()}.${ext}`;
        const buffer = Buffer.from(await file.arrayBuffer());

        const { error: uploadError } = await supabase.storage
            .from('documents')
            .upload(fileName, buffer, { contentType: file.type, upsert: true });

        if (uploadError) {
            return NextResponse.json(
                { success: false, error: { message: `Upload failed: ${uploadError.message}` } },
                { status: 500 }
            );
        }

        const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);
        const fileUrl = urlData.publicUrl;

        // Upsert document record — replace any prior upload of the same doc_type
        const existing = await db
            .select({ id: kycDocuments.id })
            .from(kycDocuments)
            .where(and(eq(kycDocuments.lead_id, leadId), eq(kycDocuments.doc_type, docType)))
            .limit(1);

        const now = new Date();

        if (existing.length > 0) {
            await db
                .update(kycDocuments)
                .set({
                    file_url: fileUrl,
                    file_name: file.name,
                    file_size: file.size,
                    verification_status: 'pending',
                    failed_reason: null,
                    updated_at: now,
                })
                .where(eq(kycDocuments.id, existing[0].id));
        } else {
            const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
            const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
            await db.insert(kycDocuments).values({
                id: `KYCDOC-${dateStr}-${seq}`,
                lead_id: leadId,
                doc_type: docType,
                file_url: fileUrl,
                file_name: file.name,
                file_size: file.size,
                verification_status: 'pending',
            });
        }

        return NextResponse.json({
            success: true,
            fileUrl,
            file_url: fileUrl,
        });
    } catch (error) {
        console.error('[KYC Upload] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
