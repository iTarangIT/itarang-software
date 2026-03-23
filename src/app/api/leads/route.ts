import { createClient } from '@/lib/supabase/server';
import { withErrorHandler, successResponse, errorResponse, generateId } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { z } from 'zod';

const leadSchema = z.object({
    lead_source: z.enum(['call_center', 'ground_sales', 'digital_marketing', 'database_upload', 'dealer_referral']),
    owner_name: z.string().min(1),
    owner_contact: z.string().regex(/^\+91[0-9]{10}$/, "Must be +91 followed by 10 digits"),
    state: z.string().min(1),
    city: z.string().min(1),
    interest_level: z.enum(['cold', 'warm', 'hot']),
    business_name: z.string().optional(),
    owner_email: z.string().email().optional().or(z.literal('')),
    shop_address: z.string().optional(),
    interested_in: z.array(z.string()).optional(),
    battery_order_expected: z.number().positive().optional(),
    investment_capacity: z.number().optional(),
    business_type: z.enum(['retail', 'wholesale', 'distributor']).optional(),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['sales_manager', 'sales_head', 'business_head', 'ceo', 'sales_executive']);
    const body = await req.json();

    const result = leadSchema.safeParse(body);
    if (!result.success) {
        console.error('Lead Validation Error:', result.error.format());
        return errorResponse(`Validation Error: ${result.error.issues[0].message} (${result.error.issues[0].path.join('.')})`, 400);
    }
    const data = result.data;

    // Use a temporary mock for generateId or keep using it if it doesn't strictly depend on Drizzle for everything
    // Actually generateId usually needs the table to check for collisions.
    // Let's assume we can still use it if it's imported.
    const leadId = `LEAD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const slaId = `SLA-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const auditId = `AUDIT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const supabase = await createClient();
    const { error: leadError } = await supabase.from('leads').insert({
        id: leadId,
        ...data,
        investment_capacity: data.investment_capacity?.toString(),
        uploader_id: user.id,
        lead_status: 'new',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    });

    if (leadError) {
        console.error('Supabase Lead Error:', leadError);
        return errorResponse(leadError.message, 500);
    }

    // Initialize SLA
    const deadline = new Date();
    deadline.setHours(deadline.getHours() + 1);

    const { error: slaError } = await supabase.from('slas').insert({
        id: slaId,
        entity_type: 'lead',
        entity_id: leadId,
        workflow_step: 'lead_first_call',
        status: 'active',
        sla_deadline: deadline.toISOString(),
        assigned_to: user.id,
    });

    if (slaError) console.error('Supabase SLA Error:', slaError);

    // Audit Log
    const { error: auditError } = await supabase.from('audit_logs').insert({
        id: auditId,
        entity_type: 'lead',
        entity_id: leadId,
        action: 'create',
        changes: { ...data, sla_initialized: true },
        performed_by: user.id,
        timestamp: new Date().toISOString(),
    });

    if (auditError) console.error('Supabase Audit Error:', auditError);

    return successResponse({ id: leadId, message: 'Lead created successfully' }, 201);
});

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['sales_manager', 'sales_head', 'business_head', 'ceo', 'sales_executive']);
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const interest = searchParams.get('interest');

    const supabase = await createClient();
    let query = supabase.from('leads').select('*');

    if (status) query = query.eq('lead_status', status);
    if (interest) query = query.eq('interest_level', interest);

    if (user.role === 'sales_executive') {
        query = query.eq('uploader_id', user.id);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
        return errorResponse(error.message, 500);
    }

    return successResponse(data);
});
