export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { requireRole } from '@/lib/auth-utils';
import {
    generateManualConsentPdf,
    type ConsentFor,
} from '@/lib/kyc/consent-service';

type RouteContext = { params: Promise<{ leadId: string }> };

// Thin wrapper: authenticate, resolve dealer name, delegate to the shared
// consent service (src/lib/kyc/consent-service.ts).
export async function POST(req: NextRequest, { params }: RouteContext) {
    try {
        const user = await requireRole(['dealer']);
        const { leadId } = await params;
        const body = await req.json().catch(() => ({}));

        let dealerName = '';
        if (user.id) {
            const userRows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
            if (userRows.length) dealerName = userRows[0].name || '';
        }

        const result = await generateManualConsentPdf({
            leadId,
            consentFor: (body?.consent_for as ConsentFor) ?? 'customer',
            dealerName,
        });

        if (!result.ok) {
            return NextResponse.json({ success: false, error: { message: result.error } }, { status: result.status });
        }

        return NextResponse.json({
            success: true,
            consentId: result.consentId,
            pdfUrl: result.pdfUrl,
            fileName: result.fileName,
            generatedAt: result.generatedAt,
            message: 'Consent PDF generated. Print it, obtain customer signature, and upload the scanned copy.',
        });
    } catch (error) {
        console.error('[Generate Consent PDF] Error:', error);
        const message = error instanceof Error ? error.message : 'Failed to generate consent PDF';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
