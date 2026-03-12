import { createAdminClient } from '@/lib/supabase/admin';
import { db } from '@/lib/db';
import { leadDocuments } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['dealer', 'ceo', 'sales_manager']);
    const { searchParams } = new URL(req.url);
    const documentId = searchParams.get('documentId');

    if (!documentId) return errorResponse('Document ID required', 400);

    const [doc] = await db.select().from(leadDocuments).where(eq(leadDocuments.id, documentId)).limit(1);

    if (!doc) return errorResponse('Document not found', 404);

    // Permission check: Dealer can only see their own docs, others see all? Or scope properly.
    if (user.role === 'dealer' && doc.dealer_id !== user.dealer_id) {
        return errorResponse('Forbidden', 403);
    }

    const adminSupabase = createAdminClient();
    const { data, error } = await adminSupabase.storage
        .from('private-documents')
        .createSignedUrl(doc.storage_path, 900); // 15 mins

    if (error) return errorResponse(error.message, 500);

    return successResponse({ signedUrl: data.signedUrl });
});
