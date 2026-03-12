import { createClient } from '@/lib/supabase/server';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { z } from 'zod';

const leadUpdateSchema = z.object({
    lead_source: z.enum(['call_center', 'ground_sales', 'digital_marketing', 'database_upload', 'dealer_referral']).optional(),
    owner_name: z.string().min(1).optional(),
    owner_contact: z.string().regex(/^\+91[0-9]{10}$/, "Must be +91 followed by 10 digits").optional(),
    state: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    interest_level: z.enum(['cold', 'warm', 'hot']).optional(),
    lead_status: z.enum(['new', 'assigned', 'contacted', 'qualified', 'converted', 'lost']).optional(),
    business_name: z.string().optional(),
    owner_email: z.string().email().optional().or(z.literal('')),
    shop_address: z.string().optional(),
});

export const PUT = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireRole(['sales_manager', 'sales_head', 'business_head', 'ceo', 'sales_executive']);
    const { id } = await params; // Next.js 15+ requires awaiting params
    const leadId = id; // Alias for clarity/matching user request terms

    if (!leadId) {
        console.error('[Update Lead] Missing ID parameter');
        return errorResponse('Lead ID is required', 400);
    }

    console.log('[Update Lead] Updating lead:', leadId);

    const body = await req.json();

    const result = leadUpdateSchema.safeParse(body);
    if (!result.success) {
        return errorResponse(`Validation Error: ${result.error.issues[0].message}`, 400);
    }
    const data = result.data;

    const supabase = await createClient();

    // Check if lead exists
    const { data: existingLead, error: fetchError } = await supabase
        .from('leads')
        .select('*')
        .eq('id', id)
        .single();

    if (fetchError || !existingLead) {
        return errorResponse('Lead not found', 404);
    }

    const { error: updateError } = await supabase
        .from('leads')
        .update({
            ...data,
            updated_at: new Date().toISOString(),
        })
        .eq('id', id);

    if (updateError) {
        console.error('Supabase Update Error:', updateError);
        return errorResponse(updateError.message, 500);
    }

    // Audit Log
    const { error: auditError } = await supabase.from('audit_logs').insert({
        id: `AUDIT-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        entity_type: 'lead',
        entity_id: id,
        action: 'update',
        changes: data,
        performed_by: user.id,
        timestamp: new Date().toISOString(),
    });

    if (auditError) console.error('Supabase Audit Error:', auditError);

    return successResponse({ message: 'Lead updated successfully' });
});
