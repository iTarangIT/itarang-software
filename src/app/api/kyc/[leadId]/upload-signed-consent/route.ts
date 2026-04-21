import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads, consentRecords } from '@/lib/db/schema';
import { and, desc, eq } from 'drizzle-orm';
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
        const consentForRaw = String(formData.get('consent_for') || 'customer').toLowerCase();
        const dbConsentFor = consentForRaw === 'customer' ? 'primary' : consentForRaw;

        if (!file) {
            return NextResponse.json({ success: false, error: { message: 'File is required' } }, { status: 400 });
        }

        if (file.type !== 'application/pdf') {
            return NextResponse.json({ success: false, error: { message: 'Only PDF files are accepted' } }, { status: 400 });
        }

        if (file.size > 10 * 1024 * 1024) {
            return NextResponse.json({ success: false, error: { message: 'File must be less than 10MB' } }, { status: 400 });
        }

        // Upload to Supabase Storage
        const supabase = await createClient();
        const fileName = `kyc/${leadId}/signed_consent_${Date.now()}.pdf`;
        const buffer = Buffer.from(await file.arrayBuffer());

        const { error: uploadError } = await supabase.storage
            .from('documents')
            .upload(fileName, buffer, { contentType: 'application/pdf', upsert: true });

        if (uploadError) {
            return NextResponse.json({ success: false, error: { message: 'Upload failed' } }, { status: 500 });
        }

        const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);
        const now = new Date();

        // Prefer updating the row that generate-consent-pdf already created for
        // this lead — otherwise we end up with two consent_records per lead and
        // the UI picks up whichever the status query returns first. Insert a new
        // one only if no row exists yet (edge case: dealer uploads a pre-signed
        // PDF without clicking "Generate Consent PDF" first).
        const [existing] = await db
            .select({ id: consentRecords.id })
            .from(consentRecords)
            .where(and(
                eq(consentRecords.lead_id, leadId),
                eq(consentRecords.consent_for, dbConsentFor),
            ))
            .orderBy(desc(consentRecords.created_at))
            .limit(1);

        if (existing) {
            await db.update(consentRecords)
                .set({
                    consent_type: 'manual',
                    consent_status: 'admin_review_pending',
                    signed_consent_url: urlData.publicUrl,
                    signed_at: now,
                    updated_at: now,
                })
                .where(eq(consentRecords.id, existing.id));
        } else {
            const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
            const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
            await db.insert(consentRecords).values({
                id: `CONSENT-${dateStr}-${seq}`,
                lead_id: leadId,
                consent_for: dbConsentFor,
                consent_type: 'manual',
                consent_status: 'admin_review_pending',
                signed_consent_url: urlData.publicUrl,
                signed_at: now,
                created_at: now,
                updated_at: now,
            });
        }

        // Mirror the same status onto the lead so the dealer UI shows
        // "Pending Review" instead of falling through to "Awaiting Signature".
        await db.update(leads)
            .set({ consent_status: 'admin_review_pending', updated_at: now })
            .where(eq(leads.id, leadId));

        return NextResponse.json({ success: true, fileUrl: urlData.publicUrl });
    } catch (error) {
        console.error('[Upload Signed Consent] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
