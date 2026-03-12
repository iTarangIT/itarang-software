import { db } from '@/lib/db';
import { otherDocumentRequests } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const GET = withErrorHandler(async (req: Request, { params }: { params: { leadId: string; requestId: string; token: string } }) => {
    const { leadId, requestId, token } = params;

    const [docRequest] = await db.select({
        id: otherDocumentRequests.id,
        doc_label: otherDocumentRequests.doc_label,
        doc_for: otherDocumentRequests.doc_for,
        upload_status: otherDocumentRequests.upload_status,
        upload_token: otherDocumentRequests.upload_token,
        token_expires_at: otherDocumentRequests.token_expires_at,
    })
        .from(otherDocumentRequests)
        .where(and(
            eq(otherDocumentRequests.id, requestId),
            eq(otherDocumentRequests.lead_id, leadId),
        ))
        .limit(1);

    if (!docRequest) return errorResponse('Invalid upload link', 404);
    if (docRequest.upload_token !== token) return errorResponse('Invalid token', 403);
    if (docRequest.token_expires_at && new Date() > docRequest.token_expires_at)
        return errorResponse('Upload link has expired', 410);

    return successResponse({
        doc_label: docRequest.doc_label,
        doc_for: docRequest.doc_for,
        upload_status: docRequest.upload_status,
        already_uploaded: docRequest.upload_status === 'uploaded',
    });
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: { leadId: string; requestId: string; token: string } }) => {
    const { leadId, requestId, token } = params;

    const [docRequest] = await db.select({
        id: otherDocumentRequests.id,
        doc_key: otherDocumentRequests.doc_key,
        upload_token: otherDocumentRequests.upload_token,
        token_expires_at: otherDocumentRequests.token_expires_at,
        upload_status: otherDocumentRequests.upload_status,
    })
        .from(otherDocumentRequests)
        .where(and(
            eq(otherDocumentRequests.id, requestId),
            eq(otherDocumentRequests.lead_id, leadId),
        ))
        .limit(1);

    if (!docRequest) return errorResponse('Invalid upload link', 404);
    if (docRequest.upload_token !== token) return errorResponse('Invalid token', 403);
    if (docRequest.token_expires_at && new Date() > docRequest.token_expires_at)
        return errorResponse('Upload link has expired', 410);
    if (docRequest.upload_status === 'uploaded') return errorResponse('Document already uploaded', 400);

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return errorResponse('No file provided', 400);

    const ext = file.name.split('.').pop() ?? 'jpg';
    const path = `public-uploads/${leadId}/${requestId}-${Date.now()}.${ext}`;

    const { error } = await supabase.storage
        .from('private-documents')
        .upload(path, file, { upsert: false });

    if (error) return errorResponse('File upload failed', 500);

    const { data: { publicUrl } } = supabase.storage
        .from('private-documents')
        .getPublicUrl(path);

    await db.update(otherDocumentRequests).set({
        file_url: publicUrl,
        upload_status: 'uploaded',
        uploaded_at: new Date(),
    }).where(eq(otherDocumentRequests.id, requestId));

    return successResponse({ message: 'Document uploaded successfully' });
});
