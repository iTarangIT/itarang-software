import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { kycDocuments, adminKycReviews, leads, accounts, consentRecords } from '@/lib/db/schema';
import { eq, and, or, inArray, sql, desc } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';

export async function GET(req: NextRequest) {
    try {
        const user = await requireRole(['admin', 'ceo', 'business_head', 'sales_head']);

        const { searchParams } = new URL(req.url);
        const status = searchParams.get('status') || 'pending';
        const search = searchParams.get('search') || '';
        const tab = searchParams.get('tab') || 'documents'; // documents | consent

        if (tab === 'consent') {
            // Fetch consent records pending admin review
            const consentConditions: any[] = [];
            if (status === 'pending') {
                consentConditions.push(
                    or(
                        eq(consentRecords.consent_status, 'admin_review_pending'),
                        eq(consentRecords.consent_status, 'consent_uploaded'),
                        eq(consentRecords.consent_status, 'esign_completed'),
                    )
                );
            } else if (status === 'verified') {
                consentConditions.push(
                    or(
                        eq(consentRecords.consent_status, 'admin_verified'),
                        eq(consentRecords.consent_status, 'manual_verified'),
                    )
                );
            } else if (status === 'rejected') {
                consentConditions.push(eq(consentRecords.consent_status, 'admin_rejected'));
            }

            const consents = await db.select()
                .from(consentRecords)
                .where(consentConditions.length > 0 ? and(...consentConditions) : undefined)
                .orderBy(desc(consentRecords.updated_at))
                .limit(200);

            const leadIds = [...new Set(consents.map(c => c.lead_id))];
            if (!leadIds.length) return NextResponse.json({ success: true, data: [] });

            const leadRows = await db.select({
                id: leads.id,
                full_name: leads.full_name,
                owner_name: leads.owner_name,
                phone: leads.phone,
                dealer_id: leads.dealer_id,
            }).from(leads).where(inArray(leads.id, leadIds));

            const leadMap = Object.fromEntries(leadRows.map(l => [l.id, l]));

            const result = consents.map(c => ({
                ...c,
                lead: leadMap[c.lead_id] || null,
            }));

            return NextResponse.json({ success: true, data: result });
        }

        // ── Documents tab (default) ─────────────────────────────────────────
        let docConditions: any[] = [];
        if (status === 'pending') {
            docConditions.push(eq(kycDocuments.doc_status, 'uploaded'));
        } else if (status === 'verified') {
            docConditions.push(eq(kycDocuments.doc_status, 'verified'));
        } else if (status === 'rejected') {
            docConditions.push(
                or(eq(kycDocuments.doc_status, 'rejected'), eq(kycDocuments.doc_status, 'reupload_requested'))
            );
        }

        const primaryDocs = await db.select({
            id: kycDocuments.id,
            lead_id: kycDocuments.lead_id,
            doc_type: kycDocuments.doc_type,
            file_url: kycDocuments.file_url,
            file_name: kycDocuments.file_name,
            doc_status: kycDocuments.doc_status,
            verification_status: kycDocuments.verification_status,
            rejection_reason: kycDocuments.rejection_reason,
            uploaded_at: kycDocuments.uploaded_at,
            ocr_data: kycDocuments.ocr_data,
        })
        .from(kycDocuments)
        .where(docConditions.length > 0 ? and(...docConditions) : undefined)
        .orderBy(desc(kycDocuments.uploaded_at))
        .limit(200);

        const leadIds = [...new Set(primaryDocs.map(d => d.lead_id))];
        if (!leadIds.length) return NextResponse.json({ success: true, data: [] });

        const leadRows = await db.select({
            id: leads.id,
            full_name: leads.full_name,
            owner_name: leads.owner_name,
            dealer_id: leads.dealer_id,
            kyc_status: leads.kyc_status,
            interest_level: leads.interest_level,
            coupon_code: leads.coupon_code,
            coupon_status: leads.coupon_status,
        }).from(leads).where(inArray(leads.id, leadIds));

        const dealerIds = [...new Set(leadRows.map(l => l.dealer_id).filter(Boolean))] as string[];
        const dealerRows = dealerIds.length > 0
            ? await db.select({ id: accounts.id, business_entity_name: accounts.business_entity_name }).from(accounts).where(inArray(accounts.id, dealerIds))
            : [];
        const dealerMap = Object.fromEntries(dealerRows.map(d => [d.id, d.business_entity_name]));

        let filteredLeads = leadRows;
        if (search) {
            const lower = search.toLowerCase();
            filteredLeads = leadRows.filter(l =>
                (l.full_name || l.owner_name || '').toLowerCase().includes(lower) ||
                l.id.toLowerCase().includes(lower) ||
                (dealerMap[l.dealer_id || ''] || '').toLowerCase().includes(lower)
            );
        }

        const filteredLeadIds = new Set(filteredLeads.map(l => l.id));
        const result = filteredLeads.map(lead => {
            const docs = primaryDocs.filter(d => d.lead_id === lead.id);
            return {
                lead_id: lead.id,
                customer_name: lead.full_name || lead.owner_name || 'Unknown',
                dealer_name: dealerMap[lead.dealer_id || ''] || 'Unknown',
                kyc_status: lead.kyc_status || 'pending',
                interest_level: lead.interest_level || 'cold',
                coupon_code: lead.coupon_code || null,
                coupon_status: lead.coupon_status || null,
                documents: docs,
                total_docs: docs.length,
                pending_count: docs.filter(d => d.doc_status === 'uploaded').length,
            };
        });

        return NextResponse.json({ success: true, data: result });
    } catch (error) {
        console.error('Admin KYC review fetch error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const user = await requireRole(['admin', 'ceo', 'business_head', 'sales_head']);

        const body = await req.json();
        const { document_id, lead_id, outcome, reviewer_notes, rejection_reason, additional_doc_requested } = body;

        if (!document_id || !lead_id || !outcome) {
            return NextResponse.json({ success: false, error: { message: 'Missing required fields' } }, { status: 400 });
        }

        if (!['verified', 'rejected', 'request_additional'].includes(outcome)) {
            return NextResponse.json({ success: false, error: { message: 'Invalid outcome' } }, { status: 400 });
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
            document_type: null,
            outcome,
            rejection_reason: rejection_reason || null,
            additional_doc_requested: additional_doc_requested || null,
            reviewer_id: user.id,
            reviewer_notes: reviewer_notes || null,
            reviewed_at: now,
            created_at: now,
        });

        // Update document doc_status (dealer-facing) and verification_status (internal)
        const docStatusMap: Record<string, string> = {
            verified: 'verified',
            rejected: 'rejected',
            request_additional: 'reupload_requested',
        };
        const verStatusMap: Record<string, string> = {
            verified: 'success',
            rejected: 'failed',
            request_additional: 'awaiting_action',
        };

        await db.update(kycDocuments)
            .set({
                doc_status: docStatusMap[outcome] || 'uploaded',
                verification_status: verStatusMap[outcome] || 'pending',
                rejection_reason: outcome === 'rejected' ? (rejection_reason || 'Rejected by admin') : null,
                verified_at: outcome === 'verified' ? now : null,
                verified_by: outcome === 'verified' ? user.id : null,
                updated_at: now,
            })
            .where(eq(kycDocuments.id, document_id));

        return NextResponse.json({
            success: true,
            data: { review_id: `REVIEW-${dateStr}-${seq}` },
        });
    } catch (error) {
        console.error('Admin KYC review submit error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
