import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const lead = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);

        if (!lead.length) {
            return NextResponse.json({ success: false, allowed: false });
        }

        const l = lead[0];
        const allowed = l.has_additional_docs_required || l.has_co_borrower;

        return NextResponse.json({
            success: true,
            allowed,
            has_co_borrower: l.has_co_borrower,
            has_additional_docs: l.has_additional_docs_required,
        });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
