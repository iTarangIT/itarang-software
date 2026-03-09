import { db } from '@/lib/db';
import { leads, leadDocuments } from '@/lib/db/schema';
import { eq, and, lt } from 'drizzle-orm';
import { successResponse, withErrorHandler } from '@/lib/api-utils';
import { createAdminClient } from '@/lib/supabase/admin';

export const GET = withErrorHandler(async (req: Request) => {
    // Secret verification
    const authHeader = req.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        if (process.env.NODE_ENV === 'production') {
            return new Response('Unauthorized', { status: 401 });
        }
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const adminSupabase = createAdminClient();

    // 1. Cleanup INCOMPLETE leads older than 7 days
    const abandonedLeads = await db.select()
        .from(leads)
        .where(
            and(
                eq(leads.status, 'INCOMPLETE'),
                lt(leads.created_at, sevenDaysAgo)
            )
        );

    for (const lead of abandonedLeads) {
        // Fetch docs to delete from storage
        const docs = await db.select().from(leadDocuments).where(eq(leadDocuments.lead_id, lead.id));

        for (const doc of docs) {
            await adminSupabase.storage.from('private-documents').remove([doc.storage_path]);
        }

        // Hard delete lead as it never progressed past Step 1
        await db.delete(leads).where(eq(leads.id, lead.id));
    }

    // 2. Logic for 90-day retention of inactive but submitted leads could be here too
    // For now, we follow the specific 7-day rule for V2 Incomplete leads.

    return successResponse({
        processed: abandonedLeads.length,
        message: `Cleaned up ${abandonedLeads.length} abandoned leads and associated documents.`
    });
});
