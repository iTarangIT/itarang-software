import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { kycDocuments } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
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
