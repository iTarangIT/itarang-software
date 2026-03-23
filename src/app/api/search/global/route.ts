import { db } from '@/lib/db';
import { campaigns, inventory, leads, loanApplications, deployedAssets, serviceTickets } from '@/lib/db/schema';
import { and, eq, ilike, or } from 'drizzle-orm';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

// Global search across dealer ecosystem.
// Supported params (per BRD): customer name, mobile, lead id, loan id, asset/inventory id, service ticket, campaign id
export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['dealer']);
    const { searchParams } = new URL(req.url);
    const qRaw = (searchParams.get('q') || '').trim();

    if (qRaw.length < 2) {
        return errorResponse('Query too short', 400);
    }

    const q = qRaw.replace(/\s+/g, ' ');
    const like = `%${q}%`;

    // NOTE: keep each category small for fast UI.
    const [leadRows, loanRows, inventoryRows, assetRows, serviceRows, campaignRows] = await Promise.all([
        db
            .select({
                id: leads.id,
                owner_name: leads.owner_name,
                phone: leads.owner_contact,
                interest_level: leads.interest_level,
            })
            .from(leads)
            .where(
                and(
                    eq(leads.dealer_id, user.dealer_id!),
                    or(
                        ilike(leads.owner_name, like),
                        ilike(leads.id, like),
                        ilike(leads.owner_contact, like),
                        ilike(leads.phone, like),
                        ilike(leads.mobile, like)
                    )
                )
            )
            .limit(8),

        db
            .select({
                id: loanApplications.id,
                lead_id: loanApplications.lead_id,
                applicant_name: loanApplications.applicant_name,
                fee_status: loanApplications.facilitation_fee_status,
                doc_uploaded: loanApplications.documents_uploaded,
            })
            .from(loanApplications)
            .leftJoin(leads, eq(loanApplications.lead_id, leads.id))
            .where(
                and(
                    eq(leads.dealer_id, user.dealer_id!),
                    or(
                        ilike(loanApplications.id, like),
                        ilike(loanApplications.lead_id, like),
                        ilike(loanApplications.applicant_name, like)
                    )
                )
            )
            .limit(8),

        db
            .select({
                id: inventory.id,
                model_type: inventory.model_type,
                asset_type: inventory.asset_type,
                serial_number: inventory.serial_number,
                status: inventory.status,
            })
            .from(inventory)
            .where(
                and(
                    eq(inventory.created_by, user.id),
                    or(
                        ilike(inventory.id, like),
                        ilike(inventory.serial_number, like),
                        ilike(inventory.model_type, like),
                        ilike(inventory.asset_type, like),
                        ilike(inventory.oem_name, like)
                    )
                )
            )
            .limit(8),

        db
            .select({
                id: deployedAssets.id,
                serial_number: deployedAssets.serial_number,
                customer_name: deployedAssets.customer_name,
                asset_category: deployedAssets.asset_category,
                model_type: deployedAssets.model_type,
                status: deployedAssets.status,
            })
            .from(deployedAssets)
            .where(
                and(
                    eq(deployedAssets.dealer_id, user.dealer_id!),
                    or(
                        ilike(deployedAssets.id, like),
                        ilike(deployedAssets.serial_number, like),
                        ilike(deployedAssets.customer_name, like),
                        ilike(deployedAssets.customer_phone, like),
                        ilike(deployedAssets.model_type, like)
                    )
                )
            )
            .limit(8),

        db
            .select({
                id: serviceTickets.id,
                customer_name: serviceTickets.customer_name,
                issue_type: serviceTickets.issue_type,
                priority: serviceTickets.priority,
                status: serviceTickets.status,
            })
            .from(serviceTickets)
            .where(
                and(
                    eq(serviceTickets.dealer_id, user.dealer_id!),
                    or(
                        ilike(serviceTickets.id, like),
                        ilike(serviceTickets.customer_name, like),
                        ilike(serviceTickets.customer_phone, like),
                        ilike(serviceTickets.issue_description, like)
                    )
                )
            )
            .limit(8),

        db
            .select({
                id: campaigns.id,
                name: campaigns.name,
                type: campaigns.type,
                status: campaigns.status,
            })
            .from(campaigns)
            .where(
                and(
                    eq(campaigns.created_by, user.id),
                    or(ilike(campaigns.id, like), ilike(campaigns.name, like))
                )
            )
            .limit(8),
    ]);

    return successResponse({
        leads: leadRows.map((r) => ({
            id: r.id,
            label: `${r.owner_name || 'Lead'} · ${r.id}`,
            subLabel: r.phone
                ? `Mobile: ${r.phone} · Interest: ${(r.interest_level || 'cold')}`
                : `Interest: ${(r.interest_level || 'cold')}`,
            href: `/dealer-portal/leads?open=${encodeURIComponent(r.id)}`,
        })),
        loans: loanRows.map((r) => ({
            id: r.id,
            label: `${r.applicant_name || 'Loan'} · ${r.id}`,
            subLabel: `Lead: ${r.lead_id} · Docs: ${r.doc_uploaded ? 'Uploaded' : 'Pending'} · Fee: ${String(r.fee_status).toUpperCase()}`,
            href: `/dealer-portal/loans/facilitation/${encodeURIComponent(r.id)}`,
        })),
        inventory: inventoryRows.map((r) => ({
            id: r.id,
            label: `${r.model_type} · ${r.id}`,
            subLabel: `${r.asset_type}${r.serial_number ? ` · SN: ${r.serial_number}` : ''} · Status: ${r.status}`,
            href: `/dealer-portal/inventory?open=${encodeURIComponent(r.id)}`,
        })),
        assets: assetRows.map((r) => ({
            id: r.id,
            label: `${r.customer_name || r.serial_number || 'Asset'} · ${r.id}`,
            subLabel: `${r.asset_category || ''} ${r.model_type || ''} · SN: ${r.serial_number || 'N/A'} · ${r.status}`,
            href: `/dealer-portal/assets`,
        })),
        services: serviceRows.map((r) => ({
            id: r.id,
            label: `${r.customer_name || 'Service'} · ${r.id}`,
            subLabel: `${String(r.issue_type).replace(/_/g, ' ')} · Priority: ${r.priority} · ${r.status}`,
            href: `/dealer-portal/service`,
        })),
        campaigns: campaignRows.map((r) => ({
            id: r.id,
            label: `${r.name} · ${r.id}`,
            subLabel: `${String(r.type).toUpperCase()} · ${String(r.status).toUpperCase()}`,
            href: `/dealer-portal/campaigns?open=${encodeURIComponent(r.id)}`,
        })),
    });
});