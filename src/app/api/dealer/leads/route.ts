
import { createClient } from '@/lib/supabase/server';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { z } from 'zod';
import { db } from '@/lib/db';
import { leads, loanDetails, personalDetails, documents, auditLogs, accounts } from '@/lib/db/schema'; // Added accounts
import { eq } from 'drizzle-orm';

// Extended Zod Schema
const dealerLeadSchema = z.object({
    // Step 1: Customer Info
    full_name: z.string().min(1, "Name is required"),
    phone: z.string().regex(/^\+91[0-9]{10}$/, "Invalid phone (+91...)"),
    permanent_address: z.string().optional(),
    vehicle_ownership: z.string().optional(),
    battery_type: z.string().optional(),
    asset_model: z.string().optional(),
    asset_price: z.coerce.number().optional(),
    family_members: z.coerce.number().optional(),
    driving_experience: z.coerce.number().optional(),

    // Step 2: Loan Details
    loan_required: z.boolean().default(false),
    loan_amount: z.coerce.number().optional(),
    interest_rate: z.coerce.number().optional(),
    tenure_months: z.coerce.number().optional(),
    processing_fee: z.coerce.number().optional(),
    emi: z.coerce.number().optional(),
    down_payment: z.coerce.number().optional(),

    // Step 3: Classification
    interest_level: z.enum(['hot', 'warm', 'cold']).default('cold'),

    // Step 4: Verification / Personal
    aadhaar_no: z.string().optional(),
    pan_no: z.string().optional(),
    dob: z.string().optional(), // ISO date string
    email: z.string().email().optional().or(z.literal('')),
    income: z.coerce.number().optional(),
    finance_type: z.string().optional(),
    financier: z.string().optional(),
    asset_type: z.string().optional(),
    vehicle_rc: z.string().optional(),
    loan_type: z.string().optional(),
    father_husband_name: z.string().optional(),
    marital_status: z.string().optional(),
    spouse_name: z.string().optional(),
    local_address: z.string().optional(),

    // Step 5: Documents (Array of URLs)
    documents: z.array(z.object({
        type: z.string(),
        url: z.string().url()
    })).optional()
});

export const POST = withErrorHandler(async (req: Request) => {
    try {
        const supabase = await createClient();

        // 1. Authenticate & Verify Dealer
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) return errorResponse('Unauthorized', 401);

        const { data: profile } = await supabase.from('users').select('role, dealer_id').eq('id', user.id).single();
        if (profile?.role !== 'dealer' || !profile?.dealer_id) {
            return errorResponse('Access denied: Dealer account required', 403);
        }

        // VERIFY DEALER ACCOUNT EXISTS
        const existingAccount = await db.query.accounts.findFirst({
            where: eq(accounts.id, profile.dealer_id)
        });

        if (!existingAccount) {
            return errorResponse(`Configuration Error: Linked Dealer Account (${profile.dealer_id}) not found in system. Please contact admin.`, 400);
        }

        // 2. Validate Body
        const body = await req.json();
        const result = dealerLeadSchema.safeParse(body);
        if (!result.success) {
            return errorResponse(`Validation Error: ${result.error.issues[0].message}`, 400);
        }
        const data = result.data;

        // 3. Database Transaction
        const leadId = `LEAD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        await db.transaction(async (tx) => {
            // A. Insert Lead
            await tx.insert(leads).values({
                id: leadId,
                dealer_id: profile.dealer_id,
                owner_name: data.full_name,
                owner_contact: data.phone,
                shop_address: data.local_address, // Use local address as shop address or permanent

                // Extended fields
                mobile: data.phone,
                permanent_address: data.permanent_address,
                vehicle_ownership: data.vehicle_ownership,
                battery_type: data.battery_type,
                asset_model: data.asset_model,
                asset_price: data.asset_price ? String(data.asset_price) : null,
                family_members: data.family_members,
                driving_experience: data.driving_experience,
                lead_type: data.interest_level, // Map interest to lead_type

                lead_source: 'dealer_referral',
                interest_level: data.interest_level, // Keep specifically for compatibility
                lead_status: 'new',
                uploader_id: user.id,

                // Required defaults
                state: 'Unknown',
                city: 'Unknown'
            });

            // B. Insert Loan Details
            if (data.loan_required) {
                await tx.insert(loanDetails).values({
                    lead_id: leadId,
                    loan_required: true,
                    loan_amount: data.loan_amount ? String(data.loan_amount) : null,
                    interest_rate: data.interest_rate ? String(data.interest_rate) : null,
                    tenure_months: data.tenure_months,
                    processing_fee: data.processing_fee ? String(data.processing_fee) : null,
                    emi: data.emi ? String(data.emi) : null,
                    down_payment: data.down_payment ? String(data.down_payment) : null,
                });
            }

            // C. Insert Personal Details
            await tx.insert(personalDetails).values({
                lead_id: leadId,
                aadhaar_no: data.aadhaar_no,
                pan_no: data.pan_no,
                dob: data.dob ? new Date(data.dob) : null,
                email: data.email,
                income: data.income ? String(data.income) : null,
                finance_type: data.finance_type,
                financier: data.financier,
                asset_type: data.asset_type,
                vehicle_rc: data.vehicle_rc,
                loan_type: data.loan_type,
                father_husband_name: data.father_husband_name,
                marital_status: data.marital_status,
                spouse_name: data.spouse_name,
                local_address: data.local_address,
            });

            // D. Insert Documents
            if (data.documents && data.documents.length > 0) {
                await tx.insert(documents).values(
                    data.documents.map(doc => ({
                        lead_id: leadId,
                        document_type: doc.type,
                        file_url: doc.url
                    }))
                );
            }

            // E. Audit Log
            await tx.insert(auditLogs).values({
                id: `AUDIT-${Date.now()}`,
                entity_type: 'lead',
                entity_id: leadId,
                action: 'create',
                changes: data,
                performed_by: user.id,
                timestamp: new Date()
            });
        });

        return successResponse({ id: leadId, message: 'Lead created successfully' }, 201);
    } catch (err: any) {
        console.error("Lead Creation Error:", err);
        const msg = err.message || 'Database Transaction Failed';
        // Check for FK violation
        if (msg.includes('foreign key constraint')) {
            return errorResponse(`Database Error: Invalid reference (e.g., Dealer Account mismatch). Details: ${msg}`, 400);
        }
        return errorResponse(`Failed to create lead: ${msg}`, 500);
    }
});

export const GET = withErrorHandler(async (req: Request) => {
    const supabase = await createClient();

    // 1. Authenticate & Verify Dealer
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return errorResponse('Unauthorized', 401);

    const { data: profile } = await supabase.from('users').select('role, dealer_id').eq('id', user.id).single();
    if (profile?.role !== 'dealer' || !profile?.dealer_id) {
        return errorResponse('Access denied', 403);
    }

    // 2. Query Leads (Scoped by Dealer ID)
    const { searchParams } = new URL(req.url);
    const search = searchParams.get('search');
    const status = searchParams.get('status');
    const type = searchParams.get('type');

    let query = supabase
        .from('leads')
        .select('*')
        .eq('dealer_id', profile.dealer_id) // STRICT SCOPING
        .order('created_at', { ascending: false });

    if (status && status !== 'All') query = query.eq('lead_status', status.toLowerCase());
    if (type && type !== 'All') query = query.eq('interest_level', type.toLowerCase());

    if (search) {
        query = query.or(`owner_name.ilike.%${search}%,owner_contact.ilike.%${search}%`);
    }

    const { data, error } = await query;
    if (error) return errorResponse(error.message, 500);

    return successResponse(data);
});
