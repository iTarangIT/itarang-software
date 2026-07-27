// GET /api/admin/whatsapp-onboarding/customer-leads
//
// Customer leads a dealer started over WhatsApp but never pushed to iTarang —
// the customer-side twin of the live conversations list. A lead is "submitted"
// when it gains an `admin_verification_queue` row (ensureAdminKycQueueEntry), so
// the absence of that row is exactly the "still in progress" signal. Until now
// these were visible only to the dealer, inside their own WhatsApp drafts menu.
//
// Anti-join rather than the NOT IN over a materialised id list that
// listDealerDrafts uses: that helper is dealer-scoped and capped at 10 rows, so
// it can afford to fetch every submitted id first; an admin-wide list can't.
// `admin_verification_queue` may hold several rows per lead, but they all fail
// the IS NULL test, so no row is duplicated into the result.

import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/index";
import {
  adminVerificationQueue,
  dealers,
  kycDocuments,
  leads,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";

const READ_ROLES = ["admin", "sales_head", "ceo"];

/** createCustomerLead's placeholder until the customer's name is known. */
const PENDING_CUSTOMER_NAME = "Customer";

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(120).optional(),
});

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole(READ_ROLES);

  const url = new URL(req.url);
  const { page, limit, q } = QuerySchema.parse(
    Object.fromEntries(url.searchParams),
  );

  const filters = [
    eq(leads.source_channel, "whatsapp"),
    isNull(adminVerificationQueue.id),
  ];
  if (q) {
    const like = `%${q}%`;
    filters.push(
      or(
        ilike(leads.owner_name, like),
        ilike(leads.full_name, like),
        ilike(leads.mobile, like),
        ilike(leads.owner_contact, like),
        ilike(leads.dealer_id, like),
      )!,
    );
  }
  const where = and(...filters);

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        leadId: leads.id,
        dealerId: leads.dealer_id,
        ownerName: leads.owner_name,
        fullName: leads.full_name,
        mobile: leads.mobile,
        ownerContact: leads.owner_contact,
        interest: leads.interest_level,
        paymentMethod: leads.payment_method,
        consentStatus: leads.consent_status,
        kycStatus: leads.kyc_status,
        leadStatus: leads.lead_status,
        assetModel: leads.asset_model,
        city: leads.city,
        state: leads.state,
        createdAt: leads.created_at,
        updatedAt: leads.updated_at,
        dealerName: dealers.company_name,
      })
      .from(leads)
      .leftJoin(
        adminVerificationQueue,
        eq(adminVerificationQueue.lead_id, leads.id),
      )
      .leftJoin(dealers, eq(dealers.dealer_id, leads.dealer_id))
      .where(where)
      .orderBy(desc(leads.updated_at))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(leads)
      .leftJoin(
        adminVerificationQueue,
        eq(adminVerificationQueue.lead_id, leads.id),
      )
      .where(where),
  ]);

  // Documents already collected for these leads. WhatsApp customer docs are
  // written to kyc_documents (as well as lead_documents) so the admin KYC cards
  // can read them — see persistCustomerDoc.
  const docsByLead = new Map<string, string[]>();
  if (rows.length > 0) {
    const docRows = await db
      .select({
        leadId: kycDocuments.lead_id,
        docType: kycDocuments.doc_type,
      })
      .from(kycDocuments)
      .where(
        sql`${kycDocuments.lead_id} = ANY(ARRAY[${sql.join(
          rows.map((r) => sql`${r.leadId}`),
          sql`, `,
        )}])`,
      );
    for (const d of docRows) {
      if (!d.leadId) continue;
      const list = docsByLead.get(d.leadId) ?? [];
      if (d.docType && !list.includes(d.docType)) list.push(d.docType);
      docsByLead.set(d.leadId, list);
    }
  }

  const customerLeads = rows.map((r) => {
    const named =
      r.ownerName && r.ownerName !== PENDING_CUSTOMER_NAME
        ? r.ownerName
        : r.fullName || null;
    const docTypes = docsByLead.get(r.leadId) ?? [];
    return {
      leadId: r.leadId,
      customerName: named || "Name not captured yet",
      hasName: Boolean(named),
      mobile: r.mobile || r.ownerContact || null,
      dealerCode: r.dealerId,
      dealerName: r.dealerName,
      interest: r.interest,
      paymentMethod: r.paymentMethod,
      consentStatus: r.consentStatus,
      kycStatus: r.kycStatus,
      leadStatus: r.leadStatus,
      assetModel: r.assetModel,
      city: r.city,
      state: r.state,
      docsUploaded: docTypes.length,
      docTypes,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });

  return successResponse({
    customerLeads,
    total: totals?.count ?? 0,
    page,
    limit,
  });
});
