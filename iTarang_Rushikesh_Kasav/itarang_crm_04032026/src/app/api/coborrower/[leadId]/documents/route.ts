import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { coBorrowerDocuments } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const docs = await db.select().from(coBorrowerDocuments).where(eq(coBorrowerDocuments.lead_id, leadId));
        return NextResponse.json({ success: true, data: docs });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
