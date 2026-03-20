import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { runLeadQualification } from '@/lib/ai/langgraph/lead-qualification-graph';
import { getAICallerEnabled } from '@/lib/ai/settings';
import { z } from 'zod';

const bulkCallSchema = z.object({
    leadIds: z.array(z.string()).min(1).max(50),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['ceo', 'sales_head']);
    const body = await req.json();

    const result = bulkCallSchema.safeParse(body);
    if (!result.success) {
        return errorResponse(`Validation Error: ${result.error.issues[0].message}`, 400);
    }

    const aiEnabled = await getAICallerEnabled();
    if (!aiEnabled) {
        return errorResponse('AI Caller is globally disabled', 400);
    }

    const { leadIds } = result.data;
    let queued = 0;
    let skipped = 0;
    const results: { leadId: string; status: string; error?: string }[] = [];

    for (const leadId of leadIds) {
        try {
            // Fetch lead to check eligibility
            const [lead] = await db.select({
                do_not_call: leads.do_not_call,
                phone_quality: leads.phone_quality,
                manual_takeover: leads.manual_takeover,
                normalized_phone: leads.normalized_phone,
            }).from(leads).where(eq(leads.id, leadId)).limit(1);

            if (!lead) {
                results.push({ leadId, status: 'skipped', error: 'Lead not found' });
                skipped++;
                continue;
            }

            if (lead.do_not_call || lead.phone_quality !== 'valid' || lead.manual_takeover) {
                results.push({ leadId, status: 'skipped', error: 'Ineligible for AI call' });
                skipped++;
                continue;
            }

            // Mark as AI managed
            await db.update(leads).set({
                ai_managed: true,
                ai_owner: 'bolna_agent',
                updated_at: new Date(),
            }).where(eq(leads.id, leadId));

            // Run qualification (async — will trigger call if score >= 70)
            const qualResult = await runLeadQualification(leadId);
            results.push({
                leadId,
                status: qualResult.shouldCall ? 'call_triggered' : 'scored',
                ...(qualResult.error && { error: qualResult.error }),
            });
            queued++;
        } catch (err) {
            results.push({ leadId, status: 'error', error: err instanceof Error ? err.message : 'Unknown' });
            skipped++;
        }
    }

    return successResponse({ queued, skipped, total: leadIds.length, results });
});
