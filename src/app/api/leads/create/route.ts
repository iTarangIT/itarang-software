import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { leads, personalDetails, auditLogs, accounts } from '@/lib/db/schema';
import { successResponse, errorResponse, withErrorHandler, generateId } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { z } from 'zod';
import { eq, and, sql, desc } from 'drizzle-orm';
import { dealerOnboardingApplications } from '@/lib/db/schema';

const step1Schema = z.object({
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
    payment_method: z.enum(['upfront', 'finance', 'cash', 'other_finance', 'dealer_finance']).optional().nullable(),
    initializeDraft: z.boolean().optional(),
    commitStep: z.boolean().optional(),
    leadId: z.string().optional().nullable(),
    lead_score: z.number().optional().nullable(),
    additional_products: z.array(z.any()).optional(),
    asset_model: z.string().optional().nullable(),
    asset_model_label: z.string().optional().nullable(),
    is_vehicle_category: z.boolean().optional(),
}).passthrough();

async function generateLeadReference() {
    const year = new Date().getFullYear();
    const prefix = `#IT-${year}`;
    const [lastRecord] = await db.select({ reference_id: leads.reference_id })
        .from(leads)
        .where(sql`${leads.reference_id} LIKE ${prefix + '-%'}`)
        .orderBy(desc(leads.reference_id))
        .limit(1);

    let sequenceNum = 1;
    if (lastRecord?.reference_id) {
        const lastSeq = lastRecord.reference_id.split('-').pop();
        if (lastSeq) sequenceNum = parseInt(lastSeq) + 1;
    }
    return `${prefix}-${sequenceNum.toString().padStart(7, '0')}`;
}

const normalizePhone = (phone?: string | null) => {
    if (!phone) return null;
    let clean = phone.replace(/[^0-9]/g, '');
    if (clean.length === 12 && clean.startsWith('91')) clean = clean.substring(2);
    if (clean.length === 10) return `+91${clean}`;
    return phone.startsWith('+') ? phone : `+91${clean}`;
};

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['dealer']);
    let dealer_id = user.dealer_id;

    // Resolve dealer_id: first from user record, then from onboarding application
    if (!dealer_id) {
        try {
            const onboardingRows = await db.select({ dealerCode: dealerOnboardingApplications.dealerCode })
                .from(dealerOnboardingApplications)
                .where(eq(dealerOnboardingApplications.dealerUserId, user.id))
                .orderBy(desc(dealerOnboardingApplications.updatedAt))
                .limit(1);

            if (onboardingRows[0]?.dealerCode) {
                dealer_id = onboardingRows[0].dealerCode;
            }
        } catch (err) {
            console.error("[leads/create] Onboarding lookup failed:", err);
        }
    }

    if (!dealer_id) return errorResponse('User not associated with a dealer. Please contact admin.', 403);

    // Ensure the account row exists (auto-create if missing for approved dealers)
    try {
        const accRows = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, dealer_id)).limit(1);
        if (accRows.length === 0) {
            let bizName = user.name || "Dealer Business";
            let contactName = user.name || "Dealer";
            let contactEmail: string | null = user.email || null;
            let gstin = "PENDING";

            try {
                const onbRows = await db.select()
                    .from(dealerOnboardingApplications)
                    .where(eq(dealerOnboardingApplications.dealerUserId, user.id))
                    .orderBy(desc(dealerOnboardingApplications.updatedAt))
                    .limit(1);
                const onb = onbRows[0];
                if (onb) {
                    bizName = onb.companyName || bizName;
                    contactName = onb.ownerName || contactName;
                    contactEmail = onb.ownerEmail || contactEmail;
                    gstin = onb.gstNumber || gstin;
                }
            } catch { /* use defaults */ }

            await db.insert(accounts).values({
                id: dealer_id,
                business_entity_name: bizName,
                gstin,
                dealer_code: dealer_id,
                contact_name: contactName,
                contact_email: contactEmail,
                status: "active",
                onboarding_status: "approved",
            });
            console.log("[leads/create] Auto-created account:", dealer_id);
        }
    } catch (err) {
        console.error("[leads/create] Account auto-create failed:", err);
        return errorResponse("Failed to verify dealer account. Please try again.", 500);
    }

    const body = await req.json();
    const result = step1Schema.safeParse(body);
    if (!result.success) {
        console.error('[leads/create] Zod validation failed:', JSON.stringify(result.error.issues));
        return NextResponse.json({
            success: false,
            error: {
                message: 'Validation failed',
                details: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message, received: i.code }))
            }
        }, { status: 400 });
    }
    const data = result.data;

    // MODE 1: INITIALIZE DRAFT
    if (data.initializeDraft) {
        try {
            const isFresh = data.fresh === true;

            // If fresh, mark old incomplete drafts as ABANDONED
            if (isFresh) {
                await db.update(leads)
                    .set({ status: 'ABANDONED', updated_at: new Date() })
                    .where(
                        and(
                            eq(leads.uploader_id, user.id),
                            eq(leads.status, 'INCOMPLETE')
                        )
                    );
            } else {
                // Resume existing incomplete draft for this user
                const [existing] = await db.select().from(leads).where(
                    and(
                        eq(leads.uploader_id, user.id),
                        eq(leads.status, 'INCOMPLETE')
                    )
                ).limit(1);

                if (existing) {
                    return successResponse({
                        leadId: existing.id,
                        referenceId: existing.reference_id,
                        resumed: true,
                        formData: {
                            full_name: existing.full_name,
                            phone: existing.phone,
                            current_address: existing.current_address,
                            permanent_address: existing.permanent_address,
                            is_current_same: existing.is_current_same,
                            product_category_id: existing.product_category_id,
                            product_type_id: existing.product_type_id,
                            primary_product_id: existing.primary_product_id,
                            interest_level: existing.interest_level,
                            dob: existing.dob ? new Date(existing.dob).toISOString().split('T')[0] : '',
                            father_or_husband_name: existing.father_or_husband_name,
                            vehicle_rc: existing.vehicle_rc,
                            vehicle_ownership: existing.vehicle_ownership,
                            vehicle_owner_name: existing.vehicle_owner_name,
                            vehicle_owner_phone: existing.vehicle_owner_phone,
                            interested_in: existing.interested_in || []
                        }
                    });
                }
            }

            const leadId = await generateId('LEAD', leads);
            const referenceId = await generateLeadReference();

            await db.transaction(async (tx) => {
                await tx.insert(leads).values({
                    id: leadId,
                    reference_id: referenceId,
                    dealer_id,
                    uploader_id: user.id,
                    status: 'INCOMPLETE',
                    workflow_step: 1,
                    lead_source: 'dealer_referral', // Default for dealer portal
                    owner_name: 'DRAFT',
                    owner_contact: 'DRAFT',
                });
                await tx.insert(personalDetails).values({
                    id: crypto.randomUUID(),
                    lead_id: leadId,
                    dob: null,
                    father_husband_name: null
                });
            });

            return successResponse({ leadId, referenceId }, 201);
        } catch (err) {
            console.error("Draft initialization failed:", err);
            return errorResponse("Failed to initialize or load your draft. Please try again.", 500);
        }
    }

    // MODE 2: COMMIT STEP 1
    if (data.commitStep) {
        if (!data.leadId) return errorResponse('leadId required for commit', 400);

        // Server-side strict validation
        if (!data.full_name || data.full_name.trim().length < 2) return errorResponse('Full name required', 400);
        if (!data.phone || data.phone.length < 10) return errorResponse('Valid phone required', 400);
        if (!data.dob) return errorResponse('Date of birth required', 400);

        const birth = new Date(data.dob);
        const age = new Date().getFullYear() - birth.getFullYear();
        if (age < 18) return errorResponse('Age must be at least 18', 400);

        if (!data.product_category_id) return errorResponse('Product category required', 400);
        if (!data.primary_product_id) return errorResponse('Primary product required', 400);
        if (!data.interest_level) return errorResponse('Interest level required', 400);

        const isVehicle = ['2W', '3W', '4W'].includes(data.product_category_id || '');
        if (isVehicle && data.vehicle_rc?.trim()) {
            if (!data.vehicle_ownership || !data.vehicle_owner_name || !data.vehicle_owner_phone) {
                return errorResponse('Owner details required for vehicle registration', 400);
            }
        }

        const normPhone = normalizePhone(data.phone)!;
        const normOwnerPhone = normalizePhone(data.vehicle_owner_phone);
        const score = data.interest_level === 'hot' ? 90 : data.interest_level === 'warm' ? 60 : 30;
        const isUpfront = data.payment_method === 'upfront';
        // BRD §2.1 — both `cash` (form value) and legacy `upfront` skip KYC.
        const isCashLike = isUpfront || data.payment_method === 'cash';
        const isHot = data.interest_level === 'hot';

        try {
            await db.transaction(async (tx) => {
                await tx.update(leads).set({
                    full_name: data.full_name?.trim(),
                    phone: normPhone,
                    owner_name: data.full_name?.trim()!,
                    owner_contact: normPhone,
                    mobile: normPhone,
                    current_address: data.current_address?.trim(),
                    permanent_address: data.is_current_same ? data.current_address?.trim() : data.permanent_address?.trim(),
                    is_current_same: data.is_current_same || false,
                    dob: new Date(data.dob!),
                    father_or_husband_name: data.father_or_husband_name?.trim(),
                    product_category_id: data.product_category_id,
                    product_type_id: data.product_type_id,
                    primary_product_id: data.primary_product_id,
                    interest_level: data.interest_level!,
                    lead_score: score,
                    vehicle_rc: data.vehicle_rc?.toUpperCase().trim(),
                    vehicle_ownership: data.vehicle_ownership,
                    vehicle_owner_name: data.vehicle_owner_name?.trim(),
                    vehicle_owner_phone: normOwnerPhone,
                    interested_in: data.interested_in || [],
                    payment_method: data.payment_method || 'finance',
                    kyc_status: isCashLike ? 'not_required' : 'not_started',
                    // Post-Step-1 routing matrix (BRD §2.1):
                    //   Hot + Cash         → workflow_step 4 (auto-nav to Product Selection)
                    //   Hot + Non-Cash     → 1 (KYC opens; Step 2 will advance it)
                    //   Warm/Cold + any    → 1 (parked; cash flag stored, no Step 4 yet)
                    workflow_step: isCashLike && isHot ? 4 : 1,
                    status: 'ACTIVE',
                    lead_status: 'new',
                    updated_at: new Date()
                }).where(eq(leads.id, data.leadId!));

                await tx.update(personalDetails).set({
                    dob: new Date(data.dob!),
                    father_husband_name: data.father_or_husband_name?.trim(),
                    local_address: data.current_address?.trim()
                }).where(eq(personalDetails.lead_id, data.leadId!));

                await tx.insert(auditLogs).values({
                    id: `AUDIT-${Date.now()}`,
                    entity_type: 'lead',
                    entity_id: data.leadId!,
                    action: 'LEAD_CREATED_STEP1',
                    changes: data,
                    performed_by: user.id,
                    timestamp: new Date()
                });
            });

            return successResponse({ success: true, leadId: data.leadId });
        } catch (err) {
            console.error("Lead commit failed:", err);
            return errorResponse("Something went wrong while saving the lead. Please try again.", 500);
        }
    }

    return errorResponse('Invalid action', 400);
});
