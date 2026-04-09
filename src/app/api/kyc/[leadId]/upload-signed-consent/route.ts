export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads, consentRecords } from '@/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { uploadFileToStorage } from '@/lib/storage';

type RouteContext = {
    params: Promise<{ leadId: string }>;
};

export async function POST(req: NextRequest, { params }: RouteContext) {
    try {
        const user = await requireRole(['dealer']);
        const { leadId } = await params;
        const formData = await req.formData();
        const file = formData.get('file') as File;

        if (!file) {
            return NextResponse.json({ success: false, error: { message: 'File is required' } }, { status: 400 });
        }

        if (file.type !== 'application/pdf') {
            return NextResponse.json({ success: false, error: { message: 'Only PDF files are accepted' } }, { status: 400 });
        }

        if (file.size > 10 * 1024 * 1024) {
            return NextResponse.json({ success: false, error: { message: 'File must be less than 10MB' } }, { status: 400 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const fileName = `signed_consent_${Date.now()}.pdf`;

        const uploadResult = await uploadFileToStorage({
            fileBuffer: buffer,
            fileName,
            folder: `kyc/${leadId}/consent`,
            contentType: 'application/pdf',
        });

        const now = new Date();

        // Check if there's an existing consent record for this lead (from PDF generation step)
        const existingConsent = await db.select()
            .from(consentRecords)
            .where(and(
                eq(consentRecords.lead_id, leadId),
                eq(consentRecords.consent_for, 'primary'),
                eq(consentRecords.consent_type, 'manual'),
            ))
            .orderBy(desc(consentRecords.created_at))
            .limit(1);

        if (existingConsent.length) {
            // Update existing consent record
            await db.update(consentRecords)
                .set({
                    consent_status: 'consent_uploaded',
                    signed_consent_url: uploadResult.url,
                    signed_at: now,
                    updated_at: now,
                })
                .where(eq(consentRecords.id, existingConsent[0].id));
        } else {
            // Create new consent record
            const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
            const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');

            await db.insert(consentRecords).values({
                id: `CONSENT-${dateStr}-${seq}`,
                lead_id: leadId,
                consent_for: 'primary',
                consent_type: 'manual',
                consent_status: 'consent_uploaded',
                sign_method: 'manual',
                signed_consent_url: uploadResult.url,
                signed_at: now,
                consent_attempt_count: 1,
                created_at: now,
                updated_at: now,
            });
        }

        // Update lead consent status to admin_review_pending
        await db.update(leads)
            .set({ consent_status: 'admin_review_pending', updated_at: now })
            .where(eq(leads.id, leadId));

        return NextResponse.json({
            success: true,
            fileUrl: uploadResult.url,
            status: 'admin_review_pending',
            message: 'Signed consent uploaded. Awaiting admin verification.',
        });
    } catch (error) {
        console.error('[Upload Signed Consent] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
