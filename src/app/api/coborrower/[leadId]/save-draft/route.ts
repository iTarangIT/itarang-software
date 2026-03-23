import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const body = await req.json();

        await db.update(leads)
            .set({
                kyc_draft_data: { ...body, interim_step: true },
                interim_step_status: 'pending',
                updated_at: new Date(),
            })
            .where(eq(leads.id, leadId));

        return NextResponse.json({ success: true, savedAt: new Date().toISOString() });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
