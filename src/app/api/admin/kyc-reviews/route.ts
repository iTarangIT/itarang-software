import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import { kycDocuments, coBorrowerDocuments, adminKycReviews, leads, accounts } from '@/lib/db/schema';
import { eq, and, or, ilike, sql, inArray } from 'drizzle-orm';

const ADMIN_ROLES = ['ceo', 'business_head', 'sales_head'];

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return null;
    const { data: profile } = await supabase.from('users').select('id, role, name').eq('id', user.id).single();
    if (!profile || !ADMIN_ROLES.includes(profile.role)) return null;
    return profile;
}

export async function GET(req: NextRequest) {
    try {
        const supabase = await createClient();
        const admin = await requireAdmin(supabase);
        if (!admin) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 });

        const { searchParams } = new URL(req.url);
        const status = searchParams.get('status') || 'pending';
        const search = searchParams.get('search') || '';

        // Fetch KYC docs with lead info
        let docConditions: any[] = [];
        if (status === 'pending') {
            docConditions.push(
                or(eq(kycDocuments.status, 'uploaded'), eq(kycDocuments.status, 'pending_review'))
            );
        } else if (status === 'verified') {
            docConditions.push(eq(kycDocuments.status, 'verified'));
        } else if (status === 'rejected') {
            docConditions.push(eq(kycDocuments.status, 'rejected'));
        }

        const primaryDocs = await db
            .select({
                id: kycDocuments.id,
                lead_id: kycDocuments.lead_id,
                document_type: kycDocuments.document_type,
                document_url: kycDocuments.document_url,
                status: kycDocuments.status,
                uploaded_at: kycDocuments.uploaded_at,
                ocr_data: kycDocuments.ocr_data,
            })
            .from(kycDocuments)
            .where(docConditions.length > 0 ? and(...docConditions) : undefined)
            .orderBy(sql`${kycDocuments.uploaded_at} DESC`)
            .limit(200);

        // Get unique lead IDs
        const leadIds = [...new Set(primaryDocs.map(d => d.lead_id))];
        if (leadIds.length === 0) {
            return NextResponse.json({ success: true, data: [] });
        }

        // Fetch lead details
        const leadRows = await db
            .select({
                id: leads.id,
                owner_name: leads.owner_name,
                dealer_id: leads.dealer_id,
                kyc_status: leads.kyc_status,
                interest_level: leads.interest_level,
                has_co_borrower: leads.has_co_borrower,
            })
            .from(leads)
            .where(inArray(leads.id, leadIds));

        // Fetch dealer names
        const dealerIds = [...new Set(leadRows.map(l => l.dealer_id).filter(Boolean))] as string[];
        const dealerRows = dealerIds.length > 0
            ? await db.select({ id: accounts.id, business_entity_name: accounts.business_entity_name }).from(accounts).where(inArray(accounts.id, dealerIds))
            : [];
        const dealerMap = Object.fromEntries(dealerRows.map(d => [d.id, d.business_entity_name]));

        // Search filter
        let filteredLeads = leadRows;
        if (search) {
            const lower = search.toLowerCase();
            filteredLeads = leadRows.filter(l =>
                l.owner_name?.toLowerCase().includes(lower) ||
                l.id.toLowerCase().includes(lower) ||
                dealerMap[l.dealer_id || '']?.toLowerCase().includes(lower)
            );
        }

        // Group docs by lead
        const result = filteredLeads.map(lead => {
            const docs = primaryDocs.filter(d => d.lead_id === lead.id).map(d => ({
                ...d,
                review_for: 'primary' as const,
            }));
            return {
                lead_id: lead.id,
                owner_name: lead.owner_name || 'Unknown',
                dealer_name: dealerMap[lead.dealer_id || ''] || 'Unknown Dealer',
                kyc_status: lead.kyc_status || 'pending',
                interest_level: lead.interest_level || 'cold',
                has_co_borrower: lead.has_co_borrower || false,
                documents: docs,
                review_count: docs.length,
                pending_count: docs.filter(d => d.status === 'uploaded' || d.status === 'pending_review').length,
            };
        });

        return NextResponse.json({ success: true, data: result });
    } catch (error) {
        console.error('Admin KYC review fetch error:', error);
        return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const supabase = await createClient();
        const admin = await requireAdmin(supabase);
        if (!admin) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 });

        const body = await req.json();
        const { document_id, lead_id, outcome, reviewer_notes, rejection_reason, additional_doc_requested } = body;

        if (!document_id || !lead_id || !outcome) {
            return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
        }

        if (!['verified', 'rejected', 'request_additional'].includes(outcome)) {
            return NextResponse.json({ success: false, error: 'Invalid outcome' }, { status: 400 });
        }

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');

        // Create review record
        await db.insert(adminKycReviews).values({
            id: `REVIEW-${dateStr}-${seq}`,
            lead_id,
            review_for: 'primary',
            document_id,
            outcome,
            rejection_reason: rejection_reason || null,
            additional_doc_requested: additional_doc_requested || null,
            reviewer_id: admin.id,
            reviewer_notes: reviewer_notes || null,
            reviewed_at: now,
            created_at: now,
        });

        // Update document status
        const newDocStatus = outcome === 'verified' ? 'verified' : outcome === 'rejected' ? 'rejected' : 'additional_requested';
        await db.update(kycDocuments)
            .set({ status: newDocStatus, updated_at: now })
            .where(eq(kycDocuments.id, document_id));

        // If outcome is request_additional, create an otherDocumentRequest
        // (handled by the admin notification system)

        return NextResponse.json({ success: true, data: { review_id: `REVIEW-${dateStr}-${seq}` } });
    } catch (error) {
        console.error('Admin KYC review submit error:', error);
        return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
    }
}
