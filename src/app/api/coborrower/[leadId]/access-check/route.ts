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
        // Allow access if workflow_step >= 4 (Step 3 completed) OR co-borrower/additional docs flags set
        const allowed = (l.workflow_step !== null && l.workflow_step >= 4) || l.has_additional_docs_required || l.has_co_borrower;

        return NextResponse.json({
            success: true,
            allowed,
            has_co_borrower: l.has_co_borrower,
            has_additional_docs: l.has_additional_docs_required,
            workflow_step: l.workflow_step,
        });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
