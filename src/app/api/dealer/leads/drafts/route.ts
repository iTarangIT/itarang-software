import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { db } from '@/lib/db';
import { leads, dealerOnboardingApplications, productSelections } from '@/lib/db/schema';
import { and, desc, eq, ilike, or } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['dealer']);
    let dealer_id = user.dealer_id;

    if (!dealer_id) {
        const onboardingRows = await db.select({ dealerCode: dealerOnboardingApplications.dealer_code })
            .from(dealerOnboardingApplications)
            .where(eq(dealerOnboardingApplications.dealer_user_id, user.id))
            .orderBy(desc(dealerOnboardingApplications.updated_at))
            .limit(1);
        if (onboardingRows[0]?.dealerCode) {
            dealer_id = onboardingRows[0].dealerCode;
        }
    }

    if (!dealer_id) {
        return errorResponse('User not associated with a dealer', 403);
    }

    const { searchParams } = new URL(req.url);
    const search = searchParams.get('search');
    const bucket = searchParams.get('bucket'); // 'low' | 'mid' | 'high'

    // ── Source 1: Step 1-3 KYC drafts (leads.kyc_status='draft') ───────────
    const kycConditions: any[] = [
        eq(leads.dealer_id, dealer_id),
        eq(leads.kyc_status, 'draft'),
    ];
    if (search) {
        kycConditions.push(
            or(
                ilike(leads.owner_name, `%${search}%`),
                ilike(leads.owner_contact, `%${search}%`)
            )!
        );
    }

    const kycDraftRows = await db.select({
        id: leads.id,
        reference_id: leads.reference_id,
        owner_name: leads.owner_name,
        owner_contact: leads.owner_contact,
        full_name: leads.full_name,
        phone: leads.phone,
        kyc_status: leads.kyc_status,
        workflow_step: leads.workflow_step,
        consent_status: leads.consent_status,
        kyc_draft_data: leads.kyc_draft_data,
        created_at: leads.created_at,
        updated_at: leads.updated_at,
    })
        .from(leads)
        .where(and(...kycConditions))
        .orderBy(desc(leads.updated_at));

    // ── Source 2: Step 4 product-selection drafts (admin_decision='draft') ─
    // Join via lead_id so we only surface drafts whose lead belongs to this
    // dealer.
    const step4DraftRows = await db
        .select({
            id: leads.id,
            reference_id: leads.reference_id,
            owner_name: leads.owner_name,
            owner_contact: leads.owner_contact,
            full_name: leads.full_name,
            phone: leads.phone,
            kyc_status: leads.kyc_status,
            workflow_step: leads.workflow_step,
            consent_status: leads.consent_status,
            kyc_draft_data: leads.kyc_draft_data,
            created_at: leads.created_at,
            updated_at: leads.updated_at,
            ps_battery_serial: productSelections.battery_serial,
            ps_charger_serial: productSelections.charger_serial,
            ps_dealer_margin: productSelections.dealer_margin,
            ps_final_price: productSelections.final_price,
            ps_updated_at: productSelections.updated_at,
        })
        .from(productSelections)
        .innerJoin(leads, eq(leads.id, productSelections.lead_id))
        .where(
            and(
                eq(leads.dealer_id, dealer_id),
                eq(productSelections.admin_decision, 'draft'),
                ...(search
                    ? [
                          or(
                              ilike(leads.owner_name, `%${search}%`),
                              ilike(leads.owner_contact, `%${search}%`),
                          )!,
                      ]
                    : []),
            ),
        )
        .orderBy(desc(productSelections.updated_at));

    // Step-4 draft trumps a stale Step-1-3 draft for the same lead — exclude
    // any kyc-draft row whose lead also has a product-selection draft.
    const step4LeadIds = new Set(step4DraftRows.map((r) => r.id));

    const kycMapped = kycDraftRows
        .filter((r) => !step4LeadIds.has(r.id))
        .map((r) => {
            const draft: any = r.kyc_draft_data || {};
            const progress = draft.progress || null;
            let percent = 0;
            if (progress) {
                const docsRequired = Number(progress.docsRequired) || 0;
                const docsUploaded = Number(progress.docsUploaded) || 0;
                const docPortion = docsRequired > 0 ? (docsUploaded / docsRequired) * 70 : 0;
                const consentPortion = progress.consentComplete ? 30 : 0;
                percent = Math.min(100, Math.round(docPortion + consentPortion));
            }
            return {
                id: r.id,
                reference_id: r.reference_id,
                owner_name: r.owner_name || r.full_name,
                owner_contact: r.owner_contact || r.phone,
                workflow_step: r.workflow_step || 1,
                consent_status: r.consent_status || 'awaiting_signature',
                progress,
                progress_percent: percent,
                last_saved_at: r.updated_at,
                created_at: r.created_at,
            };
        });

    const step4Mapped = step4DraftRows.map((r) => {
        // Step-4 progress: 70% baseline (Steps 1-3 must be done to reach Step 4)
        // + up to 30% based on which selections have been made.
        let extra = 0;
        if (r.ps_battery_serial) extra += 10;
        if (r.ps_charger_serial) extra += 10;
        if (r.ps_dealer_margin && Number(r.ps_dealer_margin) > 0) extra += 5;
        if (r.ps_final_price && Number(r.ps_final_price) > 0) extra += 5;
        const percent = Math.min(100, 70 + extra);

        return {
            id: r.id,
            reference_id: r.reference_id,
            owner_name: r.owner_name || r.full_name,
            owner_contact: r.owner_contact || r.phone,
            workflow_step: 4,
            consent_status: r.consent_status || 'awaiting_signature',
            progress: null,
            progress_percent: percent,
            // ps.updated_at is the true "last saved" for a Step-4 draft.
            last_saved_at: r.ps_updated_at ?? r.updated_at,
            created_at: r.created_at,
        };
    });

    const merged = [...step4Mapped, ...kycMapped].sort((a, b) => {
        const at = a.last_saved_at ? new Date(a.last_saved_at).getTime() : 0;
        const bt = b.last_saved_at ? new Date(b.last_saved_at).getTime() : 0;
        return bt - at;
    });

    const data = merged.filter((d) => {
        if (!bucket) return true;
        if (bucket === 'low') return d.progress_percent < 25;
        if (bucket === 'mid') return d.progress_percent >= 25 && d.progress_percent <= 75;
        if (bucket === 'high') return d.progress_percent > 75;
        return true;
    });

    return successResponse(data);
});
