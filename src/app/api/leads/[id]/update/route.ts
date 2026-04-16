import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        await requireRole(['dealer', 'admin', 'ceo', 'sales_head', 'business_head', 'sales_manager']);
        const { id } = await params;
        const body = await req.json();

        const allowedFields: Record<string, boolean> = {
            full_name: true,
            phone: true,
            interest_level: true,
            payment_method: true,
            owner_name: true,
            owner_contact: true,
        };

        const updates: Record<string, any> = { updated_at: new Date() };
        for (const [key, value] of Object.entries(body)) {
            if (allowedFields[key] && value !== undefined) {
                updates[key] = value;
            }
        }

        // Sync owner fields
        if (updates.full_name && !updates.owner_name) updates.owner_name = updates.full_name;
        if (updates.phone && !updates.owner_contact) updates.owner_contact = updates.phone;

        await db.update(leads).set(updates).where(eq(leads.id, id));

        return NextResponse.json({ success: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update lead';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
