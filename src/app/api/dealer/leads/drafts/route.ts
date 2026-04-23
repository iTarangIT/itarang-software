import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { db } from '@/lib/db';
import { leads, dealerOnboardingApplications } from '@/lib/db/schema';
import { and, desc, eq, ilike, or } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['dealer']);
    let dealer_id = user.dealer_id;

    if (!dealer_id) {
        const onboardingRows = await db.select({ dealerCode: dealerOnboardingApplications.dealerCode })
            .from(dealerOnboardingApplications)
            .where(eq(dealerOnboardingApplications.dealerUserId, user.id))
            .orderBy(desc(dealerOnboardingApplications.updatedAt))
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

    const conditions: any[] = [
        eq(leads.dealer_id, dealer_id),
        eq(leads.kyc_status, 'draft'),
    ];

    if (search) {
        conditions.push(
            or(
                ilike(leads.owner_name, `%${search}%`),
                ilike(leads.owner_contact, `%${search}%`)
            )!
        );
    }

    const rows = await db.select({
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
        .where(and(...conditions))
        .orderBy(desc(leads.updated_at));

    const data = rows
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
        })
        .filter((d) => {
            if (!bucket) return true;
            if (bucket === 'low') return d.progress_percent < 25;
            if (bucket === 'mid') return d.progress_percent >= 25 && d.progress_percent <= 75;
            if (bucket === 'high') return d.progress_percent > 75;
            return true;
        });

    return successResponse(data);
});
