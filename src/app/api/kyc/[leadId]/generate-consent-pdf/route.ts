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
import { requireLeadAccess } from '@/lib/auth/requireLeadAccess';
import { fileDealerNames, requireLeadWriter } from '@/lib/leads/actForDealerGuard';
import { recordKycStep } from '@/lib/kyc/kycEventLog';
import { isItarangActor } from '@/lib/leads/actForDealer';

type RouteContext = { params: Promise<{ leadId: string }> };

// Thin wrapper: authenticate, resolve dealer name, delegate to the shared
// consent service (src/lib/kyc/consent-service.ts).
export async function POST(req: NextRequest, { params }: RouteContext) {
    try {
        const user = await requireRole(['dealer']);
        const { leadId } = await params;
        // ID 119: signed in AND this lead is the caller's (a dealer's own lead, or back office).
        const leadGate = await requireLeadAccess(leadId);
        if (!leadGate.ok) return leadGate.response;
        // ID 183: the file's own dealer (stamps the dealer's action); the
        // house login only sees a file it pushed to another dealer.
        const writer = await requireLeadWriter(leadId, req, leadGate.user);
        if (!writer.ok) return writer.response;
        const body = await req.json().catch(() => ({}));

        // ID 183 (21 Oct): the form names the FILE's dealer. When the house
        // login (or Admin / Sales Head) makes it on a file pushed to a dealer,
        // it names that dealer — as send-consent does — not the person acting.
        let dealerName = '';
        if (isItarangActor(writer.actor.kind)) {
            const names = await fileDealerNames(writer.lead.dealer_id);
            dealerName = names.loginName || names.display || '';
        } else if (user.id) {
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

        await recordKycStep(writer.actor, `made the printable consent form${body?.consent_for === 'borrower' ? ' (co-borrower)' : ''}`);
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
