import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import {
  accounts,
  adminKycReviews,
  adminVerificationQueue,
  coBorrowerDocuments,
  coBorrowers,
  consentRecords,
  leads,
  kycDocuments,
  kycVerifications,
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
      lead_id: kycDocuments.lead_id,
      document_type: kycDocuments.doc_type,
      document_url: kycDocuments.file_url,
      verification_status: kycDocuments.verification_status,
      uploaded_at: kycDocuments.uploaded_at,
      ocr_data: kycDocuments.ocr_data,
    })
    .from(kycDocuments);

  return statuses
    ? query
        .where(inArray(kycDocuments.verification_status, statuses))
        .orderBy(desc(kycDocuments.uploaded_at))
        .limit(200)
    : query.orderBy(desc(kycDocuments.uploaded_at)).limit(200);
}

async function fetchCoBorrowerDocuments(
  filter: ReviewFilter,
): Promise<DocumentRow[]> {
  const statuses = getDbStatusesForFilter(filter);
  const query = db
    .select({
      id: coBorrowerDocuments.id,
      lead_id: coBorrowerDocuments.lead_id,
      document_type: coBorrowerDocuments.document_type,
      document_url: coBorrowerDocuments.document_url,
      verification_status: coBorrowerDocuments.status,
      uploaded_at: coBorrowerDocuments.uploaded_at,
      ocr_data: coBorrowerDocuments.ocr_data,
    })
    .from(coBorrowerDocuments);

  return statuses
    ? query
        .where(inArray(coBorrowerDocuments.status, statuses))
        .orderBy(desc(coBorrowerDocuments.uploaded_at))
        .limit(200)
    : query.orderBy(desc(coBorrowerDocuments.uploaded_at)).limit(200);
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
      lead_id: consentRecords.lead_id,
      consent_for: consentRecords.consent_for,
      consent_status: consentRecords.consent_status,
      signed_consent_url: consentRecords.signed_consent_url,
      generated_pdf_url: consentRecords.generated_pdf_url,
      signed_at: consentRecords.signed_at,
      verified_at: consentRecords.verified_at,
    })
    .from(consentRecords);

  if (filter === "pending") {
    return baseQuery
      .where(
        and(
          inArray(consentRecords.consent_status, [
            "esign_completed",
            "admin_review_pending",
          ]),
          isNull(consentRecords.verified_at),
        ),
      )
      .orderBy(desc(consentRecords.signed_at))
      .limit(200);
  }

  if (filter === "verified") {
    return baseQuery
      .where(isNotNull(consentRecords.verified_at))
      .orderBy(desc(consentRecords.verified_at))
      .limit(200);
  }

  if (filter === "rejected") {
    return baseQuery
      .where(eq(consentRecords.consent_status, "admin_rejected"))
      .orderBy(desc(consentRecords.updated_at))
      .limit(200);
  }

  // "all"
  return baseQuery.orderBy(desc(consentRecords.updated_at)).limit(200);
}

type ConsentRow = Awaited<ReturnType<typeof fetchPendingConsentsForFilter>>[number];

// Surface Video KYC recordings (kyc_verifications rows with verification_type
// = 'video_kyc') on the admin queue the same way signed consents are surfaced.
// The actual playback + accept/reject UI lives on /admin/kyc-review/[leadId];
// this list view treats each row as a virtual "video_kyc" document so the
// lead appears in the queue and the reviewer knows there's a recording to
// review. Pending video_kyc must surface even when no admin_verification_queue
// row exists — the dealer's Submit-for-Verification gate is blocked on
// VKYC being admin-verified, so without bypassing the queue gate the admin
// never sees the lead (chicken-and-egg).
async function fetchVideoKycForFilter(filter: ReviewFilter) {
  const baseQuery = db
    .select({
      id: kycVerifications.id,
      lead_id: kycVerifications.lead_id,
      applicant: kycVerifications.applicant,
      status: kycVerifications.status,
      admin_action: kycVerifications.admin_action,
      api_response: kycVerifications.api_response,
      submitted_at: kycVerifications.submitted_at,
      completed_at: kycVerifications.completed_at,
      created_at: kycVerifications.created_at,
      updated_at: kycVerifications.updated_at,
    })
    .from(kycVerifications);

  if (filter === "pending") {
    return baseQuery
      .where(
        and(
          eq(kycVerifications.verification_type, "video_kyc"),
          eq(kycVerifications.status, "admin_review_pending"),
          isNull(kycVerifications.admin_action),
        ),
      )
      .orderBy(desc(kycVerifications.submitted_at))
      .limit(200);
  }

  if (filter === "verified") {
    return baseQuery
      .where(
        and(
          eq(kycVerifications.verification_type, "video_kyc"),
          eq(kycVerifications.admin_action, "accepted"),
        ),
      )
      .orderBy(desc(kycVerifications.updated_at))
      .limit(200);
  }

  if (filter === "rejected") {
    return baseQuery
      .where(
        and(
          eq(kycVerifications.verification_type, "video_kyc"),
          eq(kycVerifications.admin_action, "rejected"),
        ),
      )
      .orderBy(desc(kycVerifications.updated_at))
      .limit(200);
  }

  // "all"
  return baseQuery
    .where(eq(kycVerifications.verification_type, "video_kyc"))
    .orderBy(desc(kycVerifications.updated_at))
    .limit(200);
}

type VideoKycRow = Awaited<ReturnType<typeof fetchVideoKycForFilter>>[number];

function videoKycToReviewDocument(v: VideoKycRow) {
  let status: ApiDocumentStatus = "pending";
  if (v.admin_action === "accepted") status = "verified";
  else if (v.admin_action === "rejected") status = "rejected";

  const url =
    typeof (v.api_response as { video_url?: unknown } | null)?.video_url === "string"
      ? ((v.api_response as { video_url: string }).video_url)
      : "";

  const uploadedAt = v.submitted_at ?? v.completed_at ?? v.created_at ?? new Date(0);
  const reviewFor: ReviewFor =
    v.applicant === "co_borrower" ? "co_borrower" : "primary";

  return {
    id: v.id,
    lead_id: v.lead_id,
    document_type: "video_kyc",
    document_url: url,
    status,
    uploaded_at: uploadedAt,
    ocr_data: null,
    review_for: reviewFor,
  };
}

// Surface Decentro Active Video Liveness rows on the queue. Same shape as
// video_kyc above — the case-review page is where the actual review happens;
// the queue just needs to know the lead has something pending.
async function fetchActiveVideoKycForFilter(filter: ReviewFilter) {
  const baseQuery = db
    .select({
      id: kycVerifications.id,
      lead_id: kycVerifications.lead_id,
      applicant: kycVerifications.applicant,
      status: kycVerifications.status,
      admin_action: kycVerifications.admin_action,
      api_response: kycVerifications.api_response,
      submitted_at: kycVerifications.submitted_at,
      completed_at: kycVerifications.completed_at,
      created_at: kycVerifications.created_at,
      updated_at: kycVerifications.updated_at,
    })
    .from(kycVerifications);

  if (filter === "pending") {
    return baseQuery
      .where(
        and(
          eq(kycVerifications.verification_type, "active_video_kyc"),
          eq(kycVerifications.status, "admin_review_pending"),
          isNull(kycVerifications.admin_action),
        ),
      )
      .orderBy(desc(kycVerifications.submitted_at))
      .limit(200);
  }

  if (filter === "verified") {
    return baseQuery
      .where(
        and(
          eq(kycVerifications.verification_type, "active_video_kyc"),
          eq(kycVerifications.admin_action, "accepted"),
        ),
      )
      .orderBy(desc(kycVerifications.updated_at))
      .limit(200);
  }

  if (filter === "rejected") {
    return baseQuery
      .where(
        and(
          eq(kycVerifications.verification_type, "active_video_kyc"),
          eq(kycVerifications.admin_action, "rejected"),
        ),
      )
      .orderBy(desc(kycVerifications.updated_at))
      .limit(200);
  }

  return baseQuery
    .where(eq(kycVerifications.verification_type, "active_video_kyc"))
    .orderBy(desc(kycVerifications.updated_at))
    .limit(200);
}

type ActiveVideoKycRow = Awaited<ReturnType<typeof fetchActiveVideoKycForFilter>>[number];

function activeVideoKycToReviewDocument(v: ActiveVideoKycRow) {
  let status: ApiDocumentStatus = "pending";
  if (v.admin_action === "accepted") status = "verified";
  else if (v.admin_action === "rejected") status = "rejected";

  // No single playable URL — the per-image match images live inside
  // api_response.results.videoFaceMatchResults. The queue's Eye button just
  // opens the case-review page where the full table renders. Use an empty
  // document_url so the queue UI doesn't try to render a broken video tag.
  const uploadedAt = v.submitted_at ?? v.completed_at ?? v.created_at ?? new Date(0);
  const reviewFor: ReviewFor =
    v.applicant === "co_borrower" ? "co_borrower" : "primary";

  return {
    id: v.id,
    lead_id: v.lead_id,
    document_type: "active_video_kyc",
    document_url: "",
    status,
    uploaded_at: uploadedAt,
    ocr_data: null,
    review_for: reviewFor,
  };
}

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

    const [primaryDocumentRows, coBorrowerDocumentRows, pendingConsentRows, videoKycRows, activeVideoKycRows] = await Promise.all([
      fetchPrimaryDocuments(filter),
      fetchCoBorrowerDocuments(filter),
      fetchPendingConsentsForFilter(filter),
      fetchVideoKycForFilter(filter),
      fetchActiveVideoKycForFilter(filter),
    ]);

    const videoKycReviewDocs = videoKycRows.map(videoKycToReviewDocument);
    const activeVideoKycReviewDocs = activeVideoKycRows.map(activeVideoKycToReviewDocument);

    const allDocuments = [
      ...primaryDocumentRows.map((doc) => toReviewDocument(doc, "primary")),
      ...coBorrowerDocumentRows.map((doc) =>
        toReviewDocument(doc, "co_borrower"),
      ),
      ...pendingConsentRows.map(consentToReviewDocument),
      ...videoKycReviewDocs,
      ...activeVideoKycReviewDocs,
    ].sort(
      (left, right) =>
        new Date(right.uploaded_at ?? 0).getTime() -
        new Date(left.uploaded_at ?? 0).getTime(),
    );

    const candidateLeadIds = [...new Set(allDocuments.map((doc) => doc.lead_id))];

    if (candidateLeadIds.length === 0) {
      return NextResponse.json({ success: true, data: [] });
    }

    // Gate the admin KYC list on the dealer having explicitly clicked
    // "Submit for Verification" — that's what creates an admin_verification_queue
    // row. Without this filter, drafts (uploaded docs / pending consents that
    // have not been submitted) leak onto the admin queue and reviewers waste
    // time triaging cases the dealer hasn't finalised yet.
    //
    // Exception: leads with a pending video_kyc bypass this gate. The dealer's
    // Submit-for-Verification is itself blocked on VKYC being admin-verified
    // first (chicken-and-egg). Surface these leads to the admin so they can
    // review the recording and unblock the dealer.
    const submittedRows = await db
      .select({ lead_id: adminVerificationQueue.lead_id })
      .from(adminVerificationQueue)
      .where(inArray(adminVerificationQueue.lead_id, candidateLeadIds));

    const videoKycLeadIds = new Set(videoKycReviewDocs.map((d) => d.lead_id));
    const activeVideoKycLeadIds = new Set(activeVideoKycReviewDocs.map((d) => d.lead_id));
    const submittedLeadIds = new Set(submittedRows.map((row) => row.lead_id));
    const leadIds = candidateLeadIds.filter(
      (id) => submittedLeadIds.has(id) || videoKycLeadIds.has(id) || activeVideoKycLeadIds.has(id),
    );

    if (leadIds.length === 0) {
      return NextResponse.json({ success: true, data: [] });
    }

    const [leadRows, coBorrowerRows] = await Promise.all([
      db
        .select({
          id: leads.id,
          owner_name: leads.owner_name,
          // The dealer name is the dealer ACCOUNT's business entity name,
          // resolved via leads.dealer_id → accounts.id (the same join coupons/
          // inventory use). `leads.business_name` is the CUSTOMER's business
          // name, not the dealer's — sourcing dealer_name from it (and then
          // falling back to owner_name) is what made the card show the customer
          // name after "Dealer:".
          dealer_id: leads.dealer_id,
          dealer_name: accounts.business_entity_name,
          kyc_status: leads.kyc_status,
        })
        .from(leads)
        .leftJoin(accounts, eq(accounts.id, leads.dealer_id))
        .where(inArray(leads.id, leadIds)),
      db
        .select({ lead_id: coBorrowers.lead_id })
        .from(coBorrowers)
        .where(inArray(coBorrowers.lead_id, leadIds)),
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
        // Never fall back to the owner/customer name here — that was the bug.
        // If the dealer account name is missing, show the dealer id (or a dash)
        // so the field stays honestly a dealer identifier.
        const dealerName =
          lead.dealer_name?.trim() || lead.dealer_id?.trim() || "—";

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
          document_type: kycDocuments.doc_type,
        })
        .from(kycDocuments)
        .where(
          and(
            eq(kycDocuments.id, documentId),
            eq(kycDocuments.lead_id, leadId),
          ),
        )
        .limit(1),
      db
        .select({
          id: coBorrowerDocuments.id,
          document_type: coBorrowerDocuments.document_type,
        })
        .from(coBorrowerDocuments)
        .where(
          and(
            eq(coBorrowerDocuments.id, documentId),
            eq(coBorrowerDocuments.lead_id, leadId),
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
      lead_id: leadId,
      review_for: reviewFor,
      document_id: documentId,
      document_type: matchedDocument.document_type,
      outcome: typedOutcome,
      rejection_reason: typedOutcome === "rejected" ? rejectionReason : null,
      additional_doc_requested:
        typedOutcome === "request_additional" ? additionalDocRequested : null,
      reviewer_id: admin.id,
      reviewer_notes: reviewerNotes || null,
      reviewed_at: now,
      created_at: now,
    });

    if (reviewFor === "primary") {
      await db
        .update(kycDocuments)
        .set({
          verification_status:
            typedOutcome === "verified"
              ? "success"
              : typedOutcome === "rejected"
                ? "failed"
                : "awaiting_action",
          failed_reason: typedOutcome === "rejected" ? rejectionReason : null,
          verified_at: typedOutcome === "verified" ? now : null,
          updated_at: now,
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
          updated_at: now,
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
