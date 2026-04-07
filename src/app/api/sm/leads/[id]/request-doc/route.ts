import { db } from '@/lib/db';
import { leads, otherDocumentRequests } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse, generateId } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { z } from 'zod';
import crypto from 'crypto';

const requestDocSchema = z.object({
    doc_label: z.string().min(1),
    doc_for: z.enum(['primary', 'co_borrower']).default('primary'),
    is_required: z.boolean().default(true),
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const user = await requireRole(['sales_manager', 'sales_head', 'business_head', 'ceo']);
    const leadId = params.id;

    const [lead] = await db.select({ id: leads.id, phone: leads.phone })
        .from(leads).where(eq(leads.id, leadId)).limit(1);

    if (!lead) return errorResponse('Lead not found', 404);

    const body = await req.json();
    const result = requestDocSchema.safeParse(body);
    if (!result.success) return errorResponse('Validation failed', 400);

    const { doc_label, doc_for, is_required } = result.data;
    const doc_key = doc_label.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

    const token = crypto.randomBytes(32).toString('hex');
    const tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const id = await generateId('OTHERDOC', otherDocumentRequests);
    await db.insert(otherDocumentRequests).values({
        id,
        lead_id: leadId,
        doc_for,
        doc_label,
        doc_key,
        is_required,
        upload_status: 'not_uploaded',
        requested_by: user.id,
        upload_token: token,
        token_expires_at: tokenExpiresAt,
    });

    const uploadLink = `${process.env.NEXT_PUBLIC_APP_URL}/upload-docs/${leadId}/${id}/${token}`;

    // TODO: Send via SMS/WhatsApp using MSG91/Twilio when provider is integrated
    // SMS: `Please upload ${doc_label} for your loan application: ${uploadLink}`

    return successResponse({
        id,
        upload_link: uploadLink,
        doc_label,
        expires_at: tokenExpiresAt,
        message: 'Document request created. Share the upload link with the customer.',
    }, 201);
});
