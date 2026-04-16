import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads, personalDetails, auditLogs, kycDocuments, consentRecords, kycVerifications } from '@/lib/db/schema';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole, requireAuth } from '@/lib/auth-utils';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';

const updateSchema = z.object({
    full_name: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    father_or_husband_name: z.string().optional().nullable(),
    dob: z.string().optional().nullable(),
    current_address: z.string().optional().nullable(),
    permanent_address: z.string().optional().nullable(),
    is_current_same: z.boolean().optional(),
    primary_product_id: z.string().optional().nullable(),
    product_category_id: z.string().optional().nullable(),
    product_type_id: z.string().optional().nullable(),
    interest_level: z.enum(['hot', 'warm', 'cold']).optional().nullable(),
    vehicle_rc: z.string().optional().nullable(),
    vehicle_ownership: z.string().optional().nullable(),
    vehicle_owner_name: z.string().optional().nullable(),
    vehicle_owner_phone: z.string().optional().nullable(),
    interested_in: z.array(z.string()).optional(),
    commitStep: z.boolean().optional()
});

const normalizePhone = (phone?: string | null) => {
    if (!phone) return null;
    let clean = phone.replace(/[^0-9]/g, '');
    if (clean.length === 12 && clean.startsWith('91')) clean = clean.substring(2);
    if (clean.length === 10) return `+91${clean}`;
    return phone.startsWith('+') ? phone : `+91${clean}`;
};

export const PATCH = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const user = await requireRole(['dealer']);
    const { id } = params;
    const body = await req.json();

    const result = updateSchema.safeParse(body);
    if (!result.success) return errorResponse('Validation failed', 400);
    const data = result.data;

    let lead;
    try {
        [lead] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
    } catch (err) {
        console.error("Lead fetch failed:", err);
        return errorResponse("Failed to retrieve lead data. Please try again.", 500);
    }

    if (!lead) return errorResponse('Lead not found', 404);
    if (lead.uploader_id !== user.id) return errorResponse('Forbidden: You do not have permission to edit this lead', 403);

    if (data.commitStep) {
        if (!data.full_name || data.full_name.trim().length < 2) return errorResponse('Full name required', 400);
        if (!data.phone || data.phone.length < 10) return errorResponse('Valid phone required', 400);
        if (!data.dob) return errorResponse('DOB required', 400);
        if (!data.product_category_id || !data.primary_product_id) return errorResponse('Product selection required', 400);

        if (data.vehicle_rc?.trim()) {
            if (!data.vehicle_ownership || !data.vehicle_owner_name || !data.vehicle_owner_phone) {
                return errorResponse('Vehicle owner details required', 400);
            }
        }
    }

    try {
        await db.transaction(async (tx) => {
            const leadUpdates: any = { updated_at: new Date() };

            if (data.full_name !== undefined) {
                leadUpdates.full_name = data.full_name?.trim();
                leadUpdates.owner_name = data.full_name?.trim();
            }
            if (data.phone !== undefined) {
                const norm = normalizePhone(data.phone);
                leadUpdates.phone = norm;
                leadUpdates.owner_contact = norm;
                leadUpdates.mobile = norm;
            }
            if (data.dob !== undefined) leadUpdates.dob = data.dob ? new Date(data.dob) : null;
            if (data.interest_level !== undefined) {
                leadUpdates.interest_level = data.interest_level;
                leadUpdates.lead_score = data.interest_level === 'hot' ? 90 : data.interest_level === 'warm' ? 60 : 30;
            }
            if (data.vehicle_rc !== undefined) leadUpdates.vehicle_rc = data.vehicle_rc?.toUpperCase().trim();
            if (data.vehicle_owner_phone !== undefined) leadUpdates.vehicle_owner_phone = normalizePhone(data.vehicle_owner_phone);

            const fields = ['father_or_husband_name', 'current_address', 'permanent_address', 'is_current_same', 'primary_product_id', 'product_category_id', 'product_type_id', 'vehicle_ownership', 'vehicle_owner_name', 'interested_in'];
            fields.forEach(f => {
                if ((data as any)[f] !== undefined) leadUpdates[f] = (data as any)[f];
            });

            if (data.is_current_same) leadUpdates.permanent_address = data.current_address || lead.current_address;

            await tx.update(leads).set(leadUpdates).where(eq(leads.id, id));

            const personalUpdates: any = {};
            if (leadUpdates.dob !== undefined) personalUpdates.dob = leadUpdates.dob;
            if (leadUpdates.father_or_husband_name !== undefined) personalUpdates.father_husband_name = leadUpdates.father_or_husband_name;
            if (leadUpdates.current_address !== undefined) personalUpdates.local_address = leadUpdates.current_address;

            if (Object.keys(personalUpdates).length > 0) {
                await tx.update(personalDetails).set(personalUpdates).where(eq(personalDetails.lead_id, id));
            }

            await tx.insert(auditLogs).values({
                id: `AUDIT-${Date.now()}`,
                entity_type: 'lead',
                entity_id: id,
                action: 'LEAD_UPDATED_STEP1',
                changes: data,
                performed_by: user.id,
                timestamp: new Date()
            });
        });

        return successResponse({ success: true, message: 'Step 1 updated' });
    } catch (err) {
        console.error("Lead update failed:", err);
        return errorResponse("Something went wrong while updating the lead. Please try again.", 500);
    }
});

// ─── DELETE ────────────────────────────────────────────────────────────────

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const user = await requireAuth();
        const { id } = await params;

        if (!id) {
            return NextResponse.json(
                { success: false, error: { message: 'Lead ID is required' } },
                { status: 400 }
            );
        }

        // Verify the lead exists
        const [lead] = await db
            .select({
                id: leads.id,
                dealer_id: leads.dealer_id,
                lead_status: leads.lead_status,
                uploader_id: leads.uploader_id,
            })
            .from(leads)
            .where(eq(leads.id, id))
            .limit(1);

        if (!lead) {
            return NextResponse.json(
                { success: false, error: { message: 'Lead not found' } },
                { status: 404 }
            );
        }

        // Only the owning dealer, or admin/ceo/sales_head can delete
        const isAdmin = ['admin', 'ceo', 'sales_head'].includes(user.role);
        const isOwner = lead.dealer_id === user.dealer_id || lead.uploader_id === user.id;
        if (!isAdmin && !isOwner) {
            return NextResponse.json(
                { success: false, error: { message: 'You can only delete your own leads' } },
                { status: 403 }
            );
        }

        // Don't allow deleting converted leads without admin role
        if (!isAdmin && lead.lead_status === 'converted') {
            return NextResponse.json(
                { success: false, error: { message: 'Cannot delete a converted lead. Contact admin.' } },
                { status: 403 }
            );
        }

        // Delete related records (cascade handles most, but clean up explicitly for safety)
        await db.delete(kycDocuments).where(eq(kycDocuments.lead_id, id));
        await db.delete(consentRecords).where(eq(consentRecords.lead_id, id));
        await db.delete(kycVerifications).where(eq(kycVerifications.lead_id, id));
        try { await db.delete(personalDetails).where(eq(personalDetails.lead_id, id)); } catch {}

        // Delete the lead
        await db.delete(leads).where(eq(leads.id, id));

        // Audit log
        try {
            await db.insert(auditLogs).values({
                id: `AUDIT-DEL-${Date.now()}`,
                entity_type: 'lead',
                entity_id: id,
                action: 'LEAD_DELETED',
                changes: { deleted_by: user.id, deleted_at: new Date().toISOString() },
                performed_by: user.id,
                timestamp: new Date(),
            });
        } catch {}

        return NextResponse.json({
            success: true,
            message: 'Lead and all related data deleted successfully',
        });
    } catch (error) {
        console.error('[Delete Lead] Error:', error);
        const message = error instanceof Error ? error.message : 'Failed to delete lead';
        return NextResponse.json(
            { success: false, error: { message } },
            { status: 500 }
        );
    }
}
