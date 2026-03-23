import { createAdminClient } from '@/lib/supabase/admin';
import { db } from '@/lib/db';
import { leadDocuments } from '@/lib/db/schema';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { v4 as uuidv4 } from 'uuid';

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['dealer']);

    const formData = await req.formData();
    const file = formData.get('file') as File;
    const docType = formData.get('documentType') as string;
    const leadId = formData.get('leadId') as string; // Optional during Step 1 auto-fill

    if (!file) return errorResponse('No file provided', 400);
    if (!docType) return errorResponse('Document type required', 400);

    // Validation
    const allowedTypes = ['image/png', 'image/jpeg', 'application/pdf'];
    if (!allowedTypes.includes(file.type)) {
        return errorResponse('Invalid file type. PNG, JPEG, PDF allowed.', 400);
    }
    if (file.size > 5 * 1024 * 1024) {
        return errorResponse('File too large (max 5MB)', 400);
    }

    const adminSupabase = createAdminClient();
    const bucketName = 'private-documents';

    // Ensure bucket exists (simplified check)
    const { data: buckets } = await adminSupabase.storage.listBuckets();
    if (!buckets?.find(b => b.name === bucketName)) {
        await adminSupabase.storage.createBucket(bucketName, { public: false });
    }

    const fileExt = file.name.split('.').pop();
    const storagePath = `dealer_${user.dealer_id}/${leadId || 'temp'}/${Date.now()}-${uuidv4()}.${fileExt}`;

    const { data, error } = await adminSupabase.storage
        .from(bucketName)
        .upload(storagePath, file, {
            contentType: file.type,
            upsert: false
        });

    if (error) return errorResponse(error.message, 500);

    const docId = `DOC-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    await db.insert(leadDocuments).values({
        id: docId,
        lead_id: leadId || null,
        dealer_id: user.dealer_id,
        user_id: user.id,
        doc_type: docType,
        storage_path: storagePath
    });

    return successResponse({
        documentId: docId,
        storagePath: storagePath
    });
});
