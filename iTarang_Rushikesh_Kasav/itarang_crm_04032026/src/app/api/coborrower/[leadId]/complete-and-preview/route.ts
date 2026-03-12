import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;

        await db.update(leads)
            .set({
                interim_step_status: 'completed',
                workflow_step: 3,
                updated_at: new Date(),
            })
            .where(eq(leads.id, leadId));

        return NextResponse.json({ success: true, nextStep: 3 });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
