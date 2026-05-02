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

        const fields = {
            full_name: body.full_name ?? null,
            father_or_husband_name: body.father_or_husband_name ?? null,
            dob: body.dob || null,
            phone: body.phone ?? null,
            relationship: body.relationship ?? null,
            income: body.income ?? null,
            permanent_address: body.permanent_address ?? null,
            current_address: body.current_address ?? null,
            is_current_same: !!body.is_current_same,
            pan_no: body.pan_no ?? null,
            aadhaar_no: body.aadhaar_no ?? null,
            updated_at: now,
        };

        const [existing] = await db
            .select({ id: coBorrowers.id })
            .from(coBorrowers)
            .where(eq(coBorrowers.lead_id, leadId))
            .limit(1);

        if (existing) {
            await db.update(coBorrowers).set(fields).where(eq(coBorrowers.id, existing.id));
            return NextResponse.json({ success: true, id: existing.id, created: false });
        }

        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        const id = `COBOR-${dateStr}-${seq}`;
        await db.insert(coBorrowers).values({ id, lead_id: leadId, created_at: now, ...fields });
        return NextResponse.json({ success: true, id, created: true });
    } catch (error) {
        console.error('[coborrower] upsert error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
