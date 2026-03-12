import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { coBorrowers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const cob = await db.select().from(coBorrowers).where(eq(coBorrowers.lead_id, leadId)).limit(1);
        return NextResponse.json({ success: true, data: cob[0] || null });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const body = await req.json();
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');

        await db.insert(coBorrowers).values({
            id: `COBOR-${dateStr}-${seq}`,
            lead_id: leadId,
            full_name: body.full_name,
            father_or_husband_name: body.father_or_husband_name,
            dob: body.dob ? new Date(body.dob) : null,
            phone: body.phone,
            permanent_address: body.permanent_address,
            current_address: body.current_address,
            is_current_same: body.is_current_same,
            pan_no: body.pan_no,
            aadhaar_no: body.aadhaar_no,
            created_at: now,
            updated_at: now,
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
