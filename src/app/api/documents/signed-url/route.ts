import { db } from '@/lib/db';
import { leadDocuments } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { filesProxyPath } from '@/lib/storage/s3';
import { FRESH_LINK_TTL_SECONDS, signedFilePath } from '@/lib/storage/fileAccess';
import { classifyFile, FILE_TOP_ROLES, PRIVATE_FILE_BUCKET } from '@/lib/storage/fileRules';
import { logFileOpen } from '@/lib/storage/fileAuthz';

// ID 166 (report row "the one existing 15-minute link"): Admin, Sales Head and
// CEO; a dealer for its own documents; anyone else only for a document they
// uploaded. Every request is logged (file_access_log).
//
// ID 166 (18 Oct): this used to hand back a signed S3 / Supabase link that
// anyone holding it could open for 15 minutes with no login. It now hands back
// the checked /api/files proxy path, signed for THIS login only (`by`, 15
// minutes) — the files route opens it for that login and nobody else, and the
// file rule (fileRules.ts autofill_scan / customer_lead) still applies to any
// plain open. `signedUrl` keeps its name for existing callers.

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
    const key = doc.storage_path ?? doc.id;
    const kind = doc.storage_path ? classifyFile(PRIVATE_FILE_BUCKET, doc.storage_path) : null;
    await logFileOpen({
        // Always a logged identity file: an unrecognised path logs as the lead's KYC.
        file: kind && kind.kind !== 'unknown' ? kind : { kind: 'customer_lead', leadId: doc.lead_id, kyc: true },
        bucket: PRIVATE_FILE_BUCKET,
        key,
        userId: user.id,
        role: user.role ?? null,
        via: 'session',
        allowed,
        ip,
    });
    if (!allowed) return errorResponse('Forbidden', 403);

    if (!doc.storage_path) return errorResponse('Document has no storage_path', 404);

    const path = filesProxyPath(PRIVATE_FILE_BUCKET, doc.storage_path);
    const signedUrl = signedFilePath(path, FRESH_LINK_TTL_SECONDS, { by: user.id }) ?? path;
    return successResponse({ signedUrl, url: signedUrl });
});
