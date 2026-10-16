import { supabaseAdmin } from '@/lib/supabase/admin';
import { db } from '@/lib/db';
import { leadDocuments } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { isS3Backend, signObject } from '@/lib/storage/s3';
import { logFileOpen } from '@/lib/storage/fileAuthz';
import { FILE_TOP_ROLES } from '@/lib/storage/fileRules';

// ID 166 (report row "the one existing 15-minute link"): the model for every
// file link — 15 minutes — now with the file rule's people: Admin, Sales Head
// and CEO; a dealer for its own documents; anyone else only for a document
// they uploaded. Every open is logged (file_access_log).

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...FILE_TOP_ROLES, 'dealer', 'sales_manager']);
    const { searchParams } = new URL(req.url);
    const documentId = searchParams.get('documentId');

    if (!documentId) return errorResponse('Document ID required', 400);

    const [doc] = await db.select().from(leadDocuments).where(eq(leadDocuments.id, documentId)).limit(1);

    if (!doc) return errorResponse('Document not found', 404);

    const role = String(user.role ?? '').toLowerCase();
    const allowed =
        (FILE_TOP_ROLES as readonly string[]).includes(role) ||
        (role === 'dealer' && !!user.dealer_id && doc.dealer_id === user.dealer_id) ||
        (!!doc.user_id && doc.user_id === user.id);
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    await logFileOpen({
        file: { kind: 'customer_lead', leadId: doc.lead_id, kyc: true },
        bucket: 'private-documents',
        key: doc.storage_path ?? doc.id,
        userId: user.id,
        role: user.role ?? null,
        via: 'session',
        allowed,
        ip,
    });
    if (!allowed) return errorResponse('Forbidden', 403);

    if (!doc.storage_path) return errorResponse('Document has no storage_path', 404);

    if (isS3Backend) {
        const signedUrl = await signObject('private-documents', doc.storage_path, 900); // 15 mins
        if (!signedUrl) return errorResponse('Failed to sign document', 500);
        return successResponse({ signedUrl });
    }

    const adminSupabase = supabaseAdmin;
    const { data, error } = await adminSupabase.storage
        .from('private-documents')
        .createSignedUrl(doc.storage_path, 900); // 15 mins

    if (error) return errorResponse(error.message, 500);

    return successResponse({ signedUrl: data.signedUrl });
});
