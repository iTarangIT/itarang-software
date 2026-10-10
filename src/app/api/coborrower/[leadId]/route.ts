import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { coBorrowers, leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireLeadAccess } from '@/lib/auth/requireLeadAccess';
import { isMaskedAadhaar, maskAadhaar, restoreMaskedAadhaar } from '@/lib/kyc/aadhaarMask';

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const access = await requireLeadAccess(leadId);
        if (!access.ok) return access.response;
        const cob = await db.select().from(coBorrowers).where(eq(coBorrowers.lead_id, leadId)).limit(1);
        // ID 119: the co-borrower's Aadhaar leaves the server masked.
        const row = cob[0] ? { ...cob[0], aadhaar_no: maskAadhaar(cob[0].aadhaar_no) } : null;
        return NextResponse.json({ success: true, data: row });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const access = await requireLeadAccess(leadId);
        if (!access.ok) return access.response;
        const body = await req.json();
        const now = new Date();

        const [existing] = await db
            .select({ id: coBorrowers.id, aadhaar_no: coBorrowers.aadhaar_no })
            .from(coBorrowers)
            .where(eq(coBorrowers.lead_id, leadId))
            .limit(1);

        // ID 119: the form may send back the mask it was given — keep the stored
        // number then, never overwrite it with "XXXX XXXX 1234". The form loads
        // from the step-3 draft, so that is the fallback when this row has none.
        let storedAadhaar: string | null = existing?.aadhaar_no ?? null;
        if (!storedAadhaar && isMaskedAadhaar(body.aadhaar_no)) {
            const [lead] = await db
                .select({ kyc_draft_data: leads.kyc_draft_data })
                .from(leads)
                .where(eq(leads.id, leadId))
                .limit(1);
            const draftAadhaar = (lead?.kyc_draft_data as any)?.borrowerForm?.aadhaar_no;
            storedAadhaar = typeof draftAadhaar === 'string' && !isMaskedAadhaar(draftAadhaar) ? draftAadhaar : null;
        }

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
            aadhaar_no: (restoreMaskedAadhaar(body.aadhaar_no ?? null, storedAadhaar) as string | null) ?? null,
            updated_at: now,
        };

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
