import { db } from '@/lib/db';
import { leads, personalDetails, auditLogs, kycDocuments, kycVerifications, consentRecords, productCategories, products, leadProducts } from '@/lib/db/schema';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import { markLeadDeleted } from '@/lib/leads/multi-party-delete';
import { dealerMayActOnLead, dealerMayViewLead, resolveDealerCode } from '@/lib/auth/requireLeadAccess';
import { dealerOwnsLead } from '@/lib/auth/leadAccessRules';
import { HOUSE_READ_ONLY_MESSAGE } from '@/lib/leads/actForDealer';
import { gateLeadActor, isHousePushedFile, recordActorStep, seenFromRequest, type LeadActor } from '@/lib/leads/actForDealerGuard';

const updateSchema = z.object({
    full_name: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    father_or_husband_name: z.string().optional().nullable(),
    dob: z.string().optional().nullable(),
    current_address: z.string().optional().nullable(),
    permanent_address: z.string().optional().nullable(),
    is_current_same: z.boolean().optional(),
    primary_product_id: z.string().optional().nullable(),
    product_category_id: z.string().optional().nullable(),
    product_type_id: z.string().optional().nullable(),
    interest_level: z.enum(['hot', 'warm', 'cold']).optional().nullable(),
    payment_method: z.string().optional().nullable(),
    vehicle_rc: z.string().optional().nullable(),
    vehicle_ownership: z.string().optional().nullable(),
    vehicle_owner_name: z.string().optional().nullable(),
    vehicle_owner_phone: z.string().optional().nullable(),
    interested_in: z.array(z.string()).optional(),
    // E-130 / Addendum §3.2, §3.3 — finance-only fields; passthrough allowed.
    resident_status: z.enum(['owned', 'rented']).optional().nullable(),
    has_health_insurance: z.boolean().optional().nullable(),
    has_life_insurance: z.boolean().optional().nullable(),
    commitStep: z.boolean().optional()
});

const normalizePhone = (phone?: string | null) => {
    if (!phone) return null;
    let clean = phone.replace(/[^0-9]/g, '');
    if (clean.length === 12 && clean.startsWith('91')) clean = clean.substring(2);
    if (clean.length === 10) return `+91${clean}`;
    return phone.startsWith('+') ? phone : `+91${clean}`;
};

// GET /api/dealer/leads/[id]
// Returns the lead in the shape the Step 1 wizard expects so a dealer can
// jump back into an already-created lead and edit fields like address.
export const GET = withErrorHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireRole(['dealer']);
    const { id } = await params;

    const [lead] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
    if (!lead) return errorResponse('Lead not found', 404);
    // E-285 — deleted from the dealer side. It may still be live for the admin
    // and the lender, but it is gone as far as this dashboard is concerned.
    // 14 Oct: only for the dealer that has it — the house keeps a file it
    // pushed out even after that dealer deletes it from their dashboard.
    if (lead.deleted_by_dealer_at && dealerOwnsLead(lead.dealer_id, await resolveDealerCode(user))) {
        return errorResponse('Lead not found', 404);
    }

    const isOwner = lead.uploader_id === user.id;
    // ID 119: resolves a dealer login with no users.dealer_id via its onboarding code.
    // 16 Oct (ID 183): the house login still SEES a file it pushed out (Pushed files).
    const isSameDealer = await dealerMayViewLead(user, lead.dealer_id, id);
    if (!isOwner && !isSameDealer) {
        return errorResponse('Forbidden: You do not have permission to view this lead', 403);
    }

    // E-116 — resolve the primary product's category slug/name + the saved
    // "Add Another Product" rows so the new-lead wizard's 3-level cascade
    // (Asset Type → Category → Product) fully rehydrates when the lead is edited.
    let assetModel = '';
    let assetModelLabel = '';
    if (lead.product_category_id) {
        const [cat] = await db
            .select({ slug: productCategories.slug, name: productCategories.name })
            .from(productCategories)
            .where(sql`${productCategories.id}::text = ${lead.product_category_id}`)
            .limit(1);
        assetModel = cat?.slug || '';
        assetModelLabel = cat?.name || '';
    }

    let primaryProductName = '';
    if (lead.primary_product_id) {
        const [prod] = await db
            .select({ name: products.name })
            .from(products)
            .where(eq(products.id, lead.primary_product_id))
            .limit(1);
        primaryProductName = prod?.name || '';
    }

    const extraRows = await db
        .select({
            product_id: leadProducts.product_id,
            product_category_id: leadProducts.product_category_id,
            category_slug: leadProducts.category_slug,
            asset_type: leadProducts.asset_type,
            product_name: products.name,
            category_name: productCategories.name,
        })
        .from(leadProducts)
        .leftJoin(products, eq(products.id, leadProducts.product_id))
        .leftJoin(
            productCategories,
            sql`${productCategories.id}::text = ${leadProducts.product_category_id}`,
        )
        .where(eq(leadProducts.lead_id, id));

    const additional_products = extraRows.map((r) => ({
        asset_type: r.asset_type || '',
        category_id: r.product_category_id || '',
        category_slug: r.category_slug || '',
        category_name: r.category_name || '',
        is_vehicle_category: true,
        product_id: r.product_id,
        product_name: r.product_name || '',
    }));

    return successResponse({
        leadId: lead.id,
        referenceId: lead.reference_id,
        // 14 Oct: the version the editor loaded — sent back on save so a change
        // made meanwhile by the other side (house / dealer) is not overwritten.
        updatedAt: lead.updated_at ? new Date(lead.updated_at).toISOString() : null,
        formData: {
            full_name: lead.full_name || '',
            phone: lead.phone || '',
            email: lead.owner_email || '',
            father_or_husband_name: lead.father_or_husband_name || '',
            dob: lead.dob ? new Date(lead.dob).toISOString().split('T')[0] : '',
            current_address: lead.current_address || '',
            permanent_address: lead.permanent_address || '',
            is_current_same: !!lead.is_current_same,
            state: lead.state || '',
            city: lead.city || '',
            product_category_id: lead.product_category_id || '',
            product_type_id: lead.product_type_id || '',
            primary_product_id: lead.primary_product_id || '',
            asset_type: lead.asset_type || '',
            asset_model: assetModel,
            asset_model_label: assetModelLabel,
            is_vehicle_category: !!assetModel,
            product_name: primaryProductName,
            interested_in: lead.interested_in || [],
            vehicle_rc: lead.vehicle_rc || '',
            vehicle_ownership: lead.vehicle_ownership || '',
            vehicle_owner_name: lead.vehicle_owner_name || '',
            vehicle_owner_phone: lead.vehicle_owner_phone || '',
            interest_level: lead.interest_level || 'cold',
            payment_method: lead.payment_method || '',
            // Addendum §3.2, §3.3 — finance-only fields surfaced for edit mode.
            resident_status: lead.resident_status || '',
            has_health_insurance: lead.has_health_insurance,
            has_life_insurance: lead.has_life_insurance,
        },
        additional_products,
    });
});

export const PATCH = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireRole(['dealer']);
    const { id } = await params;
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
    // Allow edit if the lead belongs to this dealer, or the user created a lead
    // that has no dealer yet.
    const isOwner = lead.uploader_id === user.id;
    // ID 119: resolves a dealer login with no users.dealer_id via its onboarding code.
    // 16 Oct evening (user): the house login keeps full access on a file it
    // pushed to another dealer — dealerMayActOnLead says yes for it too.
    const isSameDealer = await dealerMayActOnLead(user, lead.dealer_id, id);
    if (!isSameDealer && !(isOwner && !lead.dealer_id)) {
        if (isOwner) return errorResponse(HOUSE_READ_ONLY_MESSAGE, 403);
        return errorResponse('Forbidden: You do not have permission to edit this lead', 403);
    }
    // ID 183 (21 Oct): the file's dealer — stamps his action and clears any
    // iTarang note (dealer wins). The house login on a file it pushed out —
    // takes / refreshes its own 30-minute note (never clears someone else's),
    // is refused when the dealer acted after its page loaded, and the edit is
    // recorded "Done by" with a notice to the dealer (below).
    let actor: LeadActor | null = null;
    if (isSameDealer) {
        const gate = await gateLeadActor(user, { id, dealer_id: lead.dealer_id }, { write: true, seenDealerActionAt: seenFromRequest(req) });
        if (!gate.ok) return errorResponse(gate.message, gate.status);
        actor = gate.actor;
    }

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
            if (data.email !== undefined) leadUpdates.owner_email = data.email?.trim() || null;
            if (data.dob !== undefined) leadUpdates.dob = data.dob ? new Date(data.dob) : null;
            if (data.interest_level !== undefined) {
                leadUpdates.interest_level = data.interest_level;
                leadUpdates.lead_score = data.interest_level === 'hot' ? 90 : data.interest_level === 'warm' ? 60 : 30;
            }
            if (data.vehicle_rc !== undefined) leadUpdates.vehicle_rc = data.vehicle_rc?.toUpperCase().trim();
            if (data.vehicle_owner_phone !== undefined) leadUpdates.vehicle_owner_phone = normalizePhone(data.vehicle_owner_phone);

            const fields = ['father_or_husband_name', 'current_address', 'permanent_address', 'is_current_same', 'primary_product_id', 'product_category_id', 'product_type_id', 'vehicle_ownership', 'vehicle_owner_name', 'interested_in', 'payment_method', 'resident_status', 'has_health_insurance', 'has_life_insurance'];
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

        if (actor) await recordActorStep(actor, 'edited the customer details (Step 1)', { fields: Object.keys(data).filter((k) => k !== 'commitStep') });
        return successResponse({ success: true, message: 'Step 1 updated' });
    } catch (err) {
        console.error("Lead update failed:", err);
        return errorResponse("Something went wrong while updating the lead. Please try again.", 500);
    }
});

export const DELETE = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireRole(['dealer']);
    const { id } = await params;

    const [lead] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);

    if (!lead) return errorResponse('Lead not found', 404);
    const ownsFile = dealerOwnsLead(lead.dealer_id, await resolveDealerCode(user));
    // 16 Oct (ID 183): the dealer is the only owner of a file the house pushed
    // to him, though the house login created it — he may delete it, and the
    // delete is followed (multi-party-delete no longer keeps it for the house).
    const pushedToMe = ownsFile && lead.uploader_id !== user.id && (await isHousePushedFile(id));
    if (lead.uploader_id !== user.id && !pushedToMe) return errorResponse('Forbidden: You can only delete your own leads', 403);
    // 14 Oct: "delete" hides the file from the dealer side as a whole — so a
    // file pushed to another dealer can't be deleted by the house, or it would
    // vanish from that dealer's list too. Push it back first if needed.
    if (!ownsFile) {
        return errorResponse('This file is with another dealer now, so it can’t be deleted from here.', 409);
    }
    if (lead.deleted_by_dealer_at) return errorResponse('Lead already deleted', 404);

    try {
        // E-285 — this hides the application from the DEALER's dashboard only.
        // The admin's and the NBFC's copies stay put; the row is destroyed only
        // once every party holding it has deleted it too.
        const { purged } = await markLeadDeleted({ leadId: id, scope: 'dealer', userId: user.id });

        return successResponse({
            success: true,
            purged,
            message: purged
                ? 'Lead deleted successfully'
                : 'Lead removed from your dashboard. It stays with the admin and lender until they remove it too.',
        });
    } catch (err) {
        console.error("Lead delete failed:", err);
        return errorResponse("Failed to delete lead. Please try again.", 500);
    }
});
