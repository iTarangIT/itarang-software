import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { kycDocuments } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { requireLeadAccess } from '@/lib/auth/requireLeadAccess';

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;

        // Middleware treats /api/* as public (src/middleware.ts), so this
        // lead-scoped route must gate itself. Without this, anyone who could
        // guess or harvest a lead id read that customer's KYC document set —
        // the same IDOR already closed on /api/coborrower/[leadId].
        // requireLeadAccess also enforces OWNERSHIP: a dealer sees only leads
        // whose leads.dealer_id matches their own, while back-office roles
        // (admin/ceo/sales/finance) may review any lead.
        const access = await requireLeadAccess(leadId);
        if (!access.ok) return access.response;

        const docFor = req.nextUrl.searchParams.get('doc_for') || 'customer';
        const docs = await db
            .select()
            .from(kycDocuments)
            .where(and(eq(kycDocuments.lead_id, leadId), eq(kycDocuments.doc_for, docFor)));
        return NextResponse.json({ success: true, data: docs });
    } catch (error) {
        console.error('[KYC Documents] Error:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch documents';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
