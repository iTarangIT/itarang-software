import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import {
  adminKycReviews,
  coBorrowerDocuments,
  coBorrowers,
  consentRecords,
  leads,
  kycDocuments,
  users,
} from "@/lib/db/schema";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

const ADMIN_ROLES = ["admin", "ceo", "business_head", "sales_head", "sales_manager", "sales_executive"] as const;
const REVIEW_OUTCOMES = ["verified", "rejected", "request_additional"] as const;

type ReviewFilter = "all" | "pending" | "verified" | "rejected";
type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
type ReviewFor = "primary" | "co_borrower";
type ApiDocumentStatus = "pending" | "verified" | "rejected";

type DocumentRow = {
  id: string;
  lead_id: string;
  document_type: string;
  document_url: string | null;
  verification_status: string | null;
  uploaded_at: Date | null;
  ocr_data: unknown;
};

async function requireAdmin(
  supabase: Awaited<ReturnType<typeof createClient>>,
) {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;

  // Users live on AWS RDS, not Supabase — look up via Drizzle
  let dbUser =
    (
      await db
        .select({ id: users.id, role: users.role, name: users.name })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)
    )[0] ?? null;

  if (!dbUser && user.email) {
    dbUser =
      (
        await db
          .select({ id: users.id, role: users.role, name: users.name })
          .from(users)
          .where(eq(users.email, user.email))
          .limit(1)
      )[0] ?? null;
  }

  if (!dbUser || !ADMIN_ROLES.includes(dbUser.role as typeof ADMIN_ROLES[number])) {
    return null;
  }

  return dbUser;
}

function parseReviewFilter(value: string | null): ReviewFilter {
  if (value === "all" || value === "verified" || value === "rejected") {
    return value;
  }

  return "pending";
}

function getDbStatusesForFilter(filter: ReviewFilter): string[] | null {
  if (filter === "pending") {
    return ["pending", "in_progress", "awaiting_action"];
  }

  if (filter === "verified") {
    return ["success"];
  }

  if (filter === "rejected") {
    return ["failed"];
  }

  return null;
}

function mapDocumentStatus(status: string | null): ApiDocumentStatus {
  if (status === "success") return "verified";
  if (status === "failed") return "rejected";
  return "pending";
}

function deriveInterestLevel(status: string | null): string {
  if (!status) return "cold";

  const normalizedStatus = status.toLowerCase().trim();

  if (["interested", "approved", "hot"].includes(normalizedStatus)) {
    return "hot";
  }

  if (["contacted", "warm", "callback_requested"].includes(normalizedStatus)) {
    return "warm";
  }

  return "cold";
}

async function fetchPrimaryDocuments(
  filter: ReviewFilter,
): Promise<DocumentRow[]> {
  const statuses = getDbStatusesForFilter(filter);
  const query = db
    .select({
      id: kycDocuments.id,
      lead_id: kycDocuments.leadId,
      document_type: kycDocuments.docType,
      document_url: kycDocuments.fileUrl,
      verification_status: kycDocuments.verificationStatus,
      uploaded_at: kycDocuments.uploadedAt,
      ocr_data: kycDocuments.ocrData,
    })
    .from(kycDocuments);

  return statuses
    ? query
        .where(inArray(kycDocuments.verificationStatus, statuses))
        .orderBy(desc(kycDocuments.uploadedAt))
        .limit(200)
    : query.orderBy(desc(kycDocuments.uploadedAt)).limit(200);
}

async function fetchCoBorrowerDocuments(
  filter: ReviewFilter,
): Promise<DocumentRow[]> {
  const statuses = getDbStatusesForFilter(filter);
  const query = db
    .select({
      id: coBorrowerDocuments.id,
      lead_id: coBorrowerDocuments.leadId,
      document_type: coBorrowerDocuments.documentType,
      document_url: coBorrowerDocuments.documentUrl,
      verification_status: coBorrowerDocuments.status,
      uploaded_at: coBorrowerDocuments.uploadedAt,
      ocr_data: coBorrowerDocuments.ocrData,
    })
    .from(coBorrowerDocuments);

  return statuses
    ? query
        .where(inArray(coBorrowerDocuments.status, statuses))
        .orderBy(desc(coBorrowerDocuments.uploadedAt))
        .limit(200)
    : query.orderBy(desc(coBorrowerDocuments.uploadedAt)).limit(200);
}

function toReviewDocument(doc: DocumentRow, reviewFor: ReviewFor) {
  return {
    id: doc.id,
    lead_id: doc.lead_id,
    document_type: doc.document_type,
    document_url: doc.document_url,
    status: mapDocumentStatus(doc.verification_status),
    uploaded_at: doc.uploaded_at,
    ocr_data: doc.ocr_data,
    review_for: reviewFor,
  };
}

// Pull consents that have been signed (via DigiO) or manually uploaded and
// are now awaiting admin verification. These don't live in kyc_documents, so
// without surfacing them here the admin list never shows leads whose only
// pending item is a signed consent. The list UI treats them as a virtual
// "signed_consent" document; the actual verify action is handled in the
// per-lead case review page (/admin/kyc-review/[leadId]).
async function fetchPendingConsentsForFilter(filter: ReviewFilter) {
  const baseQuery = db
    .select({
      id: consentRecords.id,
      lead_id: consentRecords.leadId,
      consent_for: consentRecords.consentFor,
      consent_status: consentRecords.consentStatus,
      signed_consent_url: consentRecords.signedConsentUrl,
      generated_pdf_url: consentRecords.generatedPdfUrl,
      signed_at: consentRecords.signedAt,
      verified_at: consentRecords.verifiedAt,
    })
    .from(consentRecords);

  if (filter === "pending") {
    return baseQuery
      .where(
        and(
          inArray(consentRecords.consentStatus, [
            "esign_completed",
            "admin_review_pending",
          ]),
          isNull(consentRecords.verifiedAt),
        ),
      )
      .orderBy(desc(consentRecords.signedAt))
      .limit(200);
  }

  if (filter === "verified") {
    return baseQuery
      .where(isNotNull(consentRecords.verifiedAt))
      .orderBy(desc(consentRecords.verifiedAt))
      .limit(200);
  }

  if (filter === "rejected") {
    return baseQuery
      .where(eq(consentRecords.consentStatus, "admin_rejected"))
      .orderBy(desc(consentRecords.updatedAt))
      .limit(200);
  }

  // "all"
  return baseQuery.orderBy(desc(consentRecords.updatedAt)).limit(200);
}

type ConsentRow = Awaited<ReturnType<typeof fetchPendingConsentsForFilter>>[number];

function consentToReviewDocument(c: ConsentRow) {
  let status: ApiDocumentStatus = "pending";
  if (c.verified_at) status = "verified";
  else if (c.consent_status === "admin_rejected") status = "rejected";

  const url = c.signed_consent_url || c.generated_pdf_url || "";
  const uploadedAt = c.signed_at || new Date(0);
  const reviewFor: ReviewFor = c.consent_for === "co_borrower" ? "co_borrower" : "primary";

  return {
    id: c.id,
    lead_id: c.lead_id,
    document_type: "signed_consent",
    document_url: url,
    status,
    uploaded_at: uploadedAt,
    ocr_data: null,
    review_for: reviewFor,
  };
}

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const admin = await requireAdmin(supabase);

    if (!admin) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(req.url);
    const filter = parseReviewFilter(searchParams.get("status"));
    const search = searchParams.get("search")?.trim().toLowerCase() ?? "";

    const [primaryDocumentRows, coBorrowerDocumentRows, pendingConsentRows] = await Promise.all([
      fetchPrimaryDocuments(filter),
      fetchCoBorrowerDocuments(filter),
      fetchPendingConsentsForFilter(filter),
    ]);

    const allDocuments = [
      ...primaryDocumentRows.map((doc) => toReviewDocument(doc, "primary")),
      ...coBorrowerDocumentRows.map((doc) =>
        toReviewDocument(doc, "co_borrower"),
      ),
      ...pendingConsentRows.map(consentToReviewDocument),
    ].sort(
      (left, right) =>
        new Date(right.uploaded_at ?? 0).getTime() -
        new Date(left.uploaded_at ?? 0).getTime(),
    );

    const leadIds = [...new Set(allDocuments.map((doc) => doc.lead_id))];

    if (leadIds.length === 0) {
      return NextResponse.json({ success: true, data: [] });
    }

    const [leadRows, coBorrowerRows] = await Promise.all([
      db
        .select({
          id: leads.id,
          owner_name: leads.ownerName,
          dealer_name: leads.businessName,
          kyc_status: leads.kycStatus,
        })
        .from(leads)
        .where(inArray(leads.id, leadIds)),
      db
        .select({ lead_id: coBorrowers.leadId })
        .from(coBorrowers)
        .where(inArray(coBorrowers.leadId, leadIds)),
    ]);

    const documentsByLead = new Map<
      string,
      ReturnType<typeof toReviewDocument>[]
    >();
    for (const document of allDocuments) {
      const existing = documentsByLead.get(document.lead_id) ?? [];
      existing.push(document);
      documentsByLead.set(document.lead_id, existing);
    }

    const coBorrowerLeadIds = new Set(coBorrowerRows.map((row) => row.lead_id));

    const result = leadRows
      .map((lead) => {
        const documents = documentsByLead.get(lead.id) ?? [];
        const ownerName = lead.owner_name?.trim() || "Unknown";
        const dealerName = lead.dealer_name?.trim() || ownerName;

        return {
          lead_id: lead.id,
          owner_name: ownerName,
          dealer_name: dealerName,
          kyc_status: lead.kyc_status || "pending",
          interest_level: deriveInterestLevel(lead.kyc_status),
          has_co_borrower: coBorrowerLeadIds.has(lead.id),
          documents,
          review_count: documents.length,
          pending_count: documents.filter(
            (document) => document.status === "pending",
          ).length,
        };
      })
      .filter((lead) => {
        if (!search) return true;

        return (
          lead.owner_name.toLowerCase().includes(search) ||
          lead.dealer_name.toLowerCase().includes(search) ||
          lead.lead_id.toLowerCase().includes(search)
        );
      })
      .sort((left, right) => {
        const leftTime = left.documents[0]
          ? new Date(left.documents[0].uploaded_at ?? 0).getTime()
          : 0;
        const rightTime = right.documents[0]
          ? new Date(right.documents[0].uploaded_at ?? 0).getTime()
          : 0;

        return rightTime - leftTime;
      });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("Admin KYC review fetch error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const admin = await requireAdmin(supabase);

    if (!admin) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 403 },
      );
    }

    const body = await req.json();
    const documentId =
      typeof body.document_id === "string" ? body.document_id.trim() : "";
    const leadId = typeof body.lead_id === "string" ? body.lead_id.trim() : "";
    const outcome = typeof body.outcome === "string" ? body.outcome.trim() : "";
    const reviewerNotes =
      typeof body.reviewer_notes === "string" ? body.reviewer_notes.trim() : "";
    const rejectionReason =
      typeof body.rejection_reason === "string"
        ? body.rejection_reason.trim()
        : "";
    const additionalDocRequested =
      typeof body.additional_doc_requested === "string"
        ? body.additional_doc_requested.trim()
        : "";

    if (!documentId || !leadId || !outcome) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (!REVIEW_OUTCOMES.includes(outcome as ReviewOutcome)) {
      return NextResponse.json(
        { success: false, error: "Invalid outcome" },
        { status: 400 },
      );
    }

    if (outcome === "rejected" && !rejectionReason) {
      return NextResponse.json(
        { success: false, error: "Rejection reason is required" },
        { status: 400 },
      );
    }

    if (outcome === "request_additional" && !additionalDocRequested) {
      return NextResponse.json(
        { success: false, error: "Additional document request is required" },
        { status: 400 },
      );
    }

    const [primaryDocumentRows, coBorrowerDocumentRows] = await Promise.all([
      db
        .select({
          id: kycDocuments.id,
          document_type: kycDocuments.docType,
        })
        .from(kycDocuments)
        .where(
          and(
            eq(kycDocuments.id, documentId),
            eq(kycDocuments.leadId, leadId),
          ),
        )
        .limit(1),
      db
        .select({
          id: coBorrowerDocuments.id,
          document_type: coBorrowerDocuments.documentType,
        })
        .from(coBorrowerDocuments)
        .where(
          and(
            eq(coBorrowerDocuments.id, documentId),
            eq(coBorrowerDocuments.leadId, leadId),
          ),
        )
        .limit(1),
    ]);

    const primaryDocument = primaryDocumentRows[0];
    const coBorrowerDocument = coBorrowerDocumentRows[0];
    const matchedDocument = primaryDocument ?? coBorrowerDocument;

    if (!matchedDocument) {
      return NextResponse.json(
        { success: false, error: "Document not found" },
        { status: 404 },
      );
    }

    const reviewFor: ReviewFor = primaryDocument ? "primary" : "co_borrower";
    const typedOutcome = outcome as ReviewOutcome;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const seq = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0");
    const reviewId = `REVIEW-${dateStr}-${seq}`;

    await db.insert(adminKycReviews).values({
      id: reviewId,
      leadId: leadId,
      reviewFor: reviewFor,
      documentId: documentId,
      documentType: matchedDocument.document_type,
      outcome: typedOutcome,
      rejectionReason: typedOutcome === "rejected" ? rejectionReason : null,
      additionalDocRequested:
        typedOutcome === "request_additional" ? additionalDocRequested : null,
      reviewerId: admin.id,
      reviewerNotes: reviewerNotes || null,
      reviewedAt: now,
      createdAt: now,
    });

    if (reviewFor === "primary") {
      await db
        .update(kycDocuments)
        .set({
          verificationStatus:
            typedOutcome === "verified"
              ? "success"
              : typedOutcome === "rejected"
                ? "failed"
                : "awaiting_action",
          failedReason: typedOutcome === "rejected" ? rejectionReason : null,
          verifiedAt: typedOutcome === "verified" ? now : null,
          updatedAt: now,
        })
        .where(eq(kycDocuments.id, documentId));
    } else {
      await db
        .update(coBorrowerDocuments)
        .set({
          status:
            typedOutcome === "verified"
              ? "success"
              : typedOutcome === "rejected"
                ? "failed"
                : "awaiting_action",
          updatedAt: now,
        })
        .where(eq(coBorrowerDocuments.id, documentId));
    }

    return NextResponse.json({
      success: true,
      data: { review_id: reviewId },
    });
  } catch (error) {
    console.error("Admin KYC review submit error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
