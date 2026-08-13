/**
 * NBFC Acquire — document/KYC request thread service (E-200).
 *
 * The heart of the interactive Acquire loop. A `nbfc_doc_requests` wrapper row
 * is the NBFC-originated request/thread; its `otherDocumentRequests` children
 * carry the actual files, reusing the existing tokenised /upload-docs machinery
 * unchanged. This module owns:
 *   - creating a wrapper (NBFC raise, or admin direct message),
 *   - forwarding a wrapper to the dealer (creating the children — the SAME insert
 *     shape as /api/admin/kyc/[leadId]/step3/request-docs),
 *   - recomputing the wrapper's hop-status as a pure projection of its children,
 *   - pushing a completed wrapper up to the NBFC, and acking/closing it.
 *
 * The 7-hop cycle (NBFC → Admin → Dealer → Customer → Dealer → Admin → NBFC) is
 * expressed by `nbfc_doc_requests.status`. Hops 4–6 are DERIVED from the child
 * min-state and stored denormalised so list views stay one-row.
 *
 * E-239 adds a SECOND, direct channel beside that cycle. A wrapper flagged
 * `dealer_direct` skips the admin's forward click: it is born
 * 'forwarded_to_dealer', has NO children at all, and carries its conversation in
 * `nbfc_doc_request_messages` instead — the dealer answers from the Step-4
 * pre-sanction card and the reply flips it straight to 'pushed_to_nbfc'. The
 * admin-gated path above is untouched, and the admin still sees every direct
 * thread. Anything that projects status from children must early-return on these
 * wrappers (see recomputeWrapperStatus / pushNbfcDocRequest).
 */
import crypto from "crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  kycVerificationMetadata,
  leads,
  nbfc,
  nbfcDocRequestMessages,
  nbfcDocRequests,
  nbfcDocumentVerifications,
  otherDocumentRequests,
} from "@/lib/db/schema";

// --- Status + type vocabularies (mirror the E-202 CHECK constraints) ---

export const NBFC_DOC_STATUS = {
  RAISED: "nbfc_raised",
  ADMIN_REVIEW: "admin_review",
  FORWARDED: "forwarded_to_dealer",
  WITH_CUSTOMER: "with_customer",
  DEALER_REVIEW: "dealer_review",
  ADMIN_REVIEW_UPLOAD: "admin_review_upload",
  PUSHED: "pushed_to_nbfc",
  CLOSED: "closed",
  REJECTED: "rejected",
} as const;

export type NbfcDocStatus =
  (typeof NBFC_DOC_STATUS)[keyof typeof NBFC_DOC_STATUS];

export const NBFC_REQUEST_TYPES = [
  "correction",
  "additional_docs",
  "step4_extra_items",
  "message",
  // Manual DPDP consent: the NBFC uploads a consent PDF for wet/manual signing;
  // it rides this same loop (admin forwards to the dealer, who returns the
  // customer-signed copy, admin reviews, pushes back to the NBFC to verify).
  "manual_consent",
  // NBFC-initiated co-borrower: the NBFC asks the admin to add a co-borrower on
  // a lead the admin didn't flag. No children — the admin actions it with a
  // one-click "Request co-borrower from dealer" (triggers the dealer KYC flow),
  // then the wrapper is pushed back to the NBFC. E-204.
  "co_borrower",
] as const;
export type NbfcRequestType = (typeof NBFC_REQUEST_TYPES)[number];

export const STEP4_MAX_ITEMS = 10;

/** Human-readable label for a hop status (UI badges). */
export const NBFC_DOC_STATUS_LABEL: Record<string, string> = {
  nbfc_raised: "Raised by NBFC",
  admin_review: "With admin",
  forwarded_to_dealer: "Forwarded to dealer",
  with_customer: "Collecting from customer",
  dealer_review: "Dealer reviewing",
  admin_review_upload: "Admin reviewing upload",
  pushed_to_nbfc: "Pushed to NBFC",
  closed: "Closed",
  rejected: "Declined by admin",
};

// --- ID generation (matches the OTHERDOC-YYYYMMDD-SSSS-i convention) ---

function dateStamp(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}
function seq4(): string {
  return Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
}
export function generateNbfcRequestId(now: Date): string {
  return `NBFCREQ-${dateStamp(now)}-${seq4()}`;
}
export function generateNbfcMessageId(now: Date): string {
  return `NBFCMSG-${dateStamp(now)}-${seq4()}`;
}
function slugKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 100);
}

// --- Types ---

/** A file stored in the private nbfc-documents bucket (E-207/E-210 shape). */
export interface RequestAttachment {
  url: string;
  name: string;
  type: string;
  size: number;
}

export interface CreateWrapperInput {
  leadId: string;
  assignmentId: string;
  nbfcId: number;
  tenantId: string;
  requestType: NbfcRequestType;
  docFor?: "primary" | "co_borrower";
  targetDocKey?: string | null;
  comments?: string | null;
  raisedBy: string;
  /** Message requests are already 'pushed_to_nbfc'; NBFC-raised start 'nbfc_raised'. */
  initialStatus?: NbfcDocStatus;
  /** E-210 — documents the admin uploaded and is sending to the NBFC. */
  attachments?: RequestAttachment[];
  /** E-210 — the NBFC verdict this reply answers (groups it under that verdict). */
  verdictId?: number | null;
}

export interface ForwardItem {
  doc_label: string;
  doc_key?: string;
  is_required?: boolean;
  reason?: string;
}

/**
 * Create a wrapper row. Used by the NBFC raise route (status 'nbfc_raised') and
 * the admin direct-message route (request_type='message', status
 * 'pushed_to_nbfc').
 */
export async function createNbfcDocRequest(
  input: CreateWrapperInput,
): Promise<{ id: string }> {
  const now = new Date();
  const id = generateNbfcRequestId(now);
  await db.insert(nbfcDocRequests).values({
    id,
    lead_id: input.leadId,
    assignment_id: input.assignmentId,
    nbfc_id: input.nbfcId,
    tenant_id: input.tenantId,
    request_type: input.requestType,
    doc_for: input.docFor ?? "primary",
    target_doc_key: input.targetDocKey ?? null,
    nbfc_comments: input.comments ?? null,
    attachments: input.attachments ?? [],
    verdict_id: input.verdictId ?? null,
    status: input.initialStatus ?? NBFC_DOC_STATUS.RAISED,
    item_count: 0,
    raised_by: input.raisedBy,
    created_at: now,
    updated_at: now,
  });
  return { id };
}

/* ------------------------------------------------------------------ *
 * E-239 — the DIRECT NBFC ⇄ Dealer channel
 * ------------------------------------------------------------------ */

export type MessageParty = "nbfc" | "dealer" | "admin";

/**
 * The NBFC asks the dealer for a document DIRECTLY, skipping the admin forward
 * gate (E-239). Born 'forwarded_to_dealer' — i.e. already with the dealer — and
 * flagged `dealer_direct` so `recomputeWrapperStatus` leaves it alone: it has no
 * children, and the files come back on the message thread instead.
 *
 * `step4_extra_items` is reused as the request type deliberately: it is already
 * permitted by the E-202 CHECK and means exactly this ("the NBFC wants extra
 * documents at Step 4"), so no constraint has to be widened.
 *
 * The admin is not cut out — the wrapper and every message in it still render in
 * the admin "NBFC KYC Verification" card, and the route notifies admins too.
 */
export async function createDirectDealerRequest(input: {
  leadId: string;
  assignmentId: string;
  nbfcId: number;
  tenantId: string;
  comments: string;
  raisedBy: string;
  docFor?: "primary" | "co_borrower";
  attachments?: RequestAttachment[];
}): Promise<{ id: string }> {
  const { id } = await createNbfcDocRequest({
    leadId: input.leadId,
    assignmentId: input.assignmentId,
    nbfcId: input.nbfcId,
    tenantId: input.tenantId,
    requestType: "step4_extra_items",
    docFor: input.docFor ?? "primary",
    comments: input.comments,
    raisedBy: input.raisedBy,
    initialStatus: NBFC_DOC_STATUS.FORWARDED,
    attachments: input.attachments ?? [],
  });
  await db
    .update(nbfcDocRequests)
    .set({ dealer_direct: true })
    .where(eq(nbfcDocRequests.id, id));

  // Seed the thread with the NBFC's ask so the dealer and the NBFC read the same
  // conversation — `nbfc_comments` alone would leave round 1 outside the thread.
  await appendRequestMessage({
    requestId: id,
    leadId: input.leadId,
    party: "nbfc",
    authorUserId: input.raisedBy,
    message: input.comments,
    attachments: input.attachments ?? [],
  });
  return { id };
}

/** Append one message (with any files) to a request thread. Append-only. */
export async function appendRequestMessage(input: {
  requestId: string;
  leadId: string;
  party: MessageParty;
  authorUserId?: string | null;
  message?: string | null;
  attachments?: RequestAttachment[];
}): Promise<{ id: string }> {
  const now = new Date();
  const id = generateNbfcMessageId(now);
  await db.insert(nbfcDocRequestMessages).values({
    id,
    request_id: input.requestId,
    lead_id: input.leadId,
    party: input.party,
    author_user_id: input.authorUserId ?? null,
    message: input.message ?? null,
    attachments: input.attachments ?? [],
    created_at: now,
  });
  // Keep the wrapper's updated_at meaningful — the thread list sorts on it.
  await db
    .update(nbfcDocRequests)
    .set({ updated_at: now })
    .where(eq(nbfcDocRequests.id, input.requestId));
  return { id };
}

/**
 * Messages for a set of wrappers, grouped by request id. One query for the whole
 * page — never call this inside a loop over requests.
 */
export async function messagesByRequest(
  requestIds: string[],
): Promise<Map<string, Array<typeof nbfcDocRequestMessages.$inferSelect>>> {
  const byRequest = new Map<
    string,
    Array<typeof nbfcDocRequestMessages.$inferSelect>
  >();
  if (requestIds.length === 0) return byRequest;
  const rows = await db
    .select()
    .from(nbfcDocRequestMessages)
    .where(inArray(nbfcDocRequestMessages.request_id, requestIds))
    .orderBy(asc(nbfcDocRequestMessages.created_at));
  for (const m of rows) {
    const arr = byRequest.get(m.request_id) ?? [];
    arr.push(m);
    byRequest.set(m.request_id, arr);
  }
  return byRequest;
}

/**
 * Admin forwards an NBFC request to the dealer. Creates one
 * `otherDocumentRequests` child per item — the SAME insert shape as
 * /api/admin/kyc/[leadId]/step3/request-docs — tagged `source='nbfc'` +
 * `nbfc_request_id`, flips the lead into the Step-3 waiting state, unlocks
 * dealer edits, and advances the wrapper to 'forwarded_to_dealer'.
 *
 * Returns the tokenised upload links so the admin/dealer can share them.
 */
export async function forwardNbfcDocRequest(opts: {
  requestId: string;
  adminUserId: string;
  items: ForwardItem[];
  adminNotes?: string | null;
  /**
   * When true (default) the lead is flipped into the Step-3 waiting state
   * (`awaiting_additional_docs`/`awaiting_both`, `has_additional_docs_required`)
   * so the dealer is routed to Step 3. Pass false to leave the lead's routing
   * untouched — used for a primary/customer verdict forward, whose child shows
   * in the Step-2 "Additional Documents" section without pulling the dealer off
   * Step 2.
   */
  routeToStep3?: boolean;
}): Promise<{
  lead_status: string;
  requests: Array<{ id: string; doc_label: string; upload_link: string }>;
}> {
  const [wrapper] = await db
    .select()
    .from(nbfcDocRequests)
    .where(eq(nbfcDocRequests.id, opts.requestId))
    .limit(1);
  if (!wrapper) throw new Error("NOT_FOUND: nbfc request not found");
  if (wrapper.request_type === "message") {
    throw new Error("BAD_REQUEST: a message request has no documents to forward");
  }
  if (opts.items.length === 0) {
    throw new Error("BAD_REQUEST: at least one item is required");
  }
  // Step-4 extra items are capped at 10 total across the wrapper's lifetime; 10
  // is also a sane ceiling for the other request types, so it applies globally
  // (matches the E-202 CHECK backstop).
  if ((wrapper.item_count ?? 0) + opts.items.length > STEP4_MAX_ITEMS) {
    throw new Error(
      `BAD_REQUEST: this request already has ${wrapper.item_count} item(s); adding ${opts.items.length} would exceed the ${STEP4_MAX_ITEMS}-item limit`,
    );
  }

  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const dateStr = dateStamp(now);
  const docFor = (wrapper.doc_for ?? "primary") as "primary" | "co_borrower";
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "";

  const created: Array<{ id: string; doc_label: string; upload_link: string }> =
    [];

  for (let i = 0; i < opts.items.length; i += 1) {
    const item = opts.items[i];
    const childId = `OTHERDOC-${dateStr}-${seq4()}-${i}`;
    const token = crypto.randomBytes(32).toString("hex");
    const doc_key = item.doc_key?.trim() || slugKey(item.doc_label);

    await db.insert(otherDocumentRequests).values({
      id: childId,
      lead_id: wrapper.lead_id,
      doc_for: docFor,
      doc_label: item.doc_label,
      doc_key,
      is_required: item.is_required ?? true,
      upload_status: "not_uploaded",
      rejection_reason: item.reason ?? null,
      requested_by: opts.adminUserId,
      upload_token: token,
      token_expires_at: expires,
      // E-200 tags — this is an NBFC-originated child.
      nbfc_request_id: wrapper.id,
      source: "nbfc",
      created_at: now,
    });

    created.push({
      id: childId,
      doc_label: item.doc_label,
      upload_link: `${base}/upload-docs/${wrapper.lead_id}/${childId}/${token}`,
    });
  }

  // Flip the lead into the Step-3 waiting state (reuses the step3 route's rule).
  // Skipped for a primary verdict forward (routeToStep3 === false): its child
  // surfaces in the Step-2 Additional Documents section, so we must not pull the
  // dealer off Step 2 into Step 3.
  const routeToStep3 = opts.routeToStep3 !== false;
  const [lead] = await db
    .select({ id: leads.id, kyc_status: leads.kyc_status })
    .from(leads)
    .where(eq(leads.id, wrapper.lead_id))
    .limit(1);
  const currentStatus = lead?.kyc_status ?? "";
  const nextStatus = !routeToStep3
    ? currentStatus
    : currentStatus === "awaiting_co_borrower_kyc" ||
        currentStatus === "awaiting_co_borrower_replacement" ||
        currentStatus === "awaiting_both"
      ? "awaiting_both"
      : "awaiting_additional_docs";
  if (lead && routeToStep3) {
    await db
      .update(leads)
      .set({
        kyc_status: nextStatus,
        has_additional_docs_required: true,
        updated_at: now,
      })
      .where(eq(leads.id, wrapper.lead_id));
  }

  // Release the dealer-edits lock so the dealer can upload on Step 3.
  const metaRows = await db
    .select({ lead_id: kycVerificationMetadata.lead_id })
    .from(kycVerificationMetadata)
    .where(eq(kycVerificationMetadata.lead_id, wrapper.lead_id))
    .limit(1);
  if (metaRows.length > 0) {
    await db
      .update(kycVerificationMetadata)
      .set({ dealer_edits_locked: false, updated_at: now })
      .where(eq(kycVerificationMetadata.lead_id, wrapper.lead_id));
  } else {
    await db.insert(kycVerificationMetadata).values({
      lead_id: wrapper.lead_id,
      dealer_edits_locked: false,
      created_at: now,
      updated_at: now,
    });
  }

  // Advance the wrapper.
  await db
    .update(nbfcDocRequests)
    .set({
      status: NBFC_DOC_STATUS.FORWARDED,
      item_count: (wrapper.item_count ?? 0) + created.length,
      admin_notes: opts.adminNotes ?? wrapper.admin_notes ?? null,
      reviewed_by: opts.adminUserId,
      updated_at: now,
    })
    .where(eq(nbfcDocRequests.id, wrapper.id));

  return { lead_status: nextStatus, requests: created };
}

/** Friendly document labels for the standard NBFC verdict doc_keys. */
const VERDICT_DOC_LABELS: Record<string, string> = {
  aadhaar: "Aadhaar Card",
  pan: "PAN Card",
  bank: "Bank Statement / Proof",
  cibil: "CIBIL / Credit Report",
  rc: "RC (Vehicle)",
};

/**
 * Admin "Forward to dealer" on an NBFC per-document verdict (E-209).
 *
 * Turns a single 'queried' (correction requested) or 'rejected' verdict from
 * `nbfc_document_verifications` into a real dealer re-upload request: spins up a
 * `correction` wrapper (E-200) and forwards it, creating one
 * `otherDocumentRequests` child that lands on
 *   • the dealer's Step 2 (customer KYC)     when doc_for = 'primary'
 *   • the dealer's Step 3 (co-borrower docs) when doc_for = 'co_borrower'
 * A co-borrower forward also flags `leads.has_co_borrower` so Step 3's
 * co-borrower section renders. The verdict row is stamped so the button flips to
 * a "Forwarded" badge and a second click can't create a duplicate request.
 */
export async function forwardVerdictToDealer(opts: {
  verdictId: number;
  adminUserId: string;
  /** The admin's instruction to the dealer — required; shown as the re-upload reason. */
  message: string;
}): Promise<{
  leadId: string;
  requestId: string;
  docFor: "primary" | "co_borrower";
  step: 2 | 3;
  docLabel: string;
}> {
  const [verdict] = await db
    .select()
    .from(nbfcDocumentVerifications)
    .where(eq(nbfcDocumentVerifications.id, opts.verdictId))
    .limit(1);
  if (!verdict) throw new Error("NOT_FOUND: verdict not found");
  if (verdict.forwarded_at) {
    throw new Error(
      "BAD_REQUEST: this verdict has already been forwarded to the dealer",
    );
  }
  if (verdict.verdict !== "queried" && verdict.verdict !== "rejected") {
    throw new Error(
      "BAD_REQUEST: only a correction-requested or rejected document can be forwarded to the dealer",
    );
  }

  const message = opts.message.trim();
  if (!message) {
    throw new Error("BAD_REQUEST: a message for the dealer is required");
  }

  const docFor: "primary" | "co_borrower" =
    verdict.doc_for === "co_borrower" ? "co_borrower" : "primary";
  const docLabel = VERDICT_DOC_LABELS[verdict.doc_key] ?? verdict.doc_key;
  // The admin's typed message is what the dealer sees as the re-upload reason.
  const reason = message;

  // Wrapper (correction) → child (otherDocumentRequests), reusing the loop.
  const { id: requestId } = await createNbfcDocRequest({
    leadId: verdict.lead_id,
    assignmentId: verdict.assignment_id,
    nbfcId: verdict.nbfc_id,
    tenantId: verdict.tenant_id,
    requestType: "correction",
    docFor,
    targetDocKey: verdict.doc_key,
    comments: verdict.notes ?? null,
    raisedBy: opts.adminUserId,
  });

  await forwardNbfcDocRequest({
    requestId,
    adminUserId: opts.adminUserId,
    items: [
      {
        doc_label: docLabel,
        doc_key: verdict.doc_key,
        is_required: true,
        reason,
      },
    ],
    adminNotes: message,
    routeToStep3: docFor === "co_borrower",
  });

  const now = new Date();

  // A co-borrower re-upload must render Step 3's co-borrower section, which is
  // gated on has_co_borrower / a co-borrower kyc_status.
  if (docFor === "co_borrower") {
    await db
      .update(leads)
      .set({ has_co_borrower: true, updated_at: now })
      .where(eq(leads.id, verdict.lead_id));
  }

  await db
    .update(nbfcDocumentVerifications)
    .set({
      forwarded_at: now,
      forwarded_request_id: requestId,
      forwarded_by: opts.adminUserId,
      updated_at: now,
    })
    .where(eq(nbfcDocumentVerifications.id, opts.verdictId));

  return {
    leadId: verdict.lead_id,
    requestId,
    docFor,
    step: docFor === "co_borrower" ? 3 : 2,
    docLabel,
  };
}

/**
 * Admin answers an NBFC per-document verdict by sending the document HIMSELF
 * (E-210) — no dealer round-trip.
 *
 * When the admin already holds the correct customer document (a fresh CIBIL
 * pull, a clearer Aadhaar scan, the bank's own statement…), forwarding the
 * verdict to the dealer only adds delay. This uploads the file(s) against the
 * verdict and hands them straight to the NBFC as a `message` wrapper born
 * 'pushed_to_nbfc' — the NBFC sees it in its request thread, opens the
 * document, and acknowledges/re-verifies. `verdict_id` groups the reply under
 * the verdict it answers in the admin's NBFC Actions card.
 *
 * Independent of "Forward to dealer": the admin may do either, both, or send
 * several documents over time.
 */
export async function sendVerdictDocumentToNbfc(opts: {
  verdictId: number;
  adminUserId: string;
  /** The admin's note to the NBFC — required. */
  message: string;
  attachments: RequestAttachment[];
}): Promise<{
  requestId: string;
  leadId: string;
  tenantId: string;
  docLabel: string;
  attachmentCount: number;
}> {
  const [verdict] = await db
    .select()
    .from(nbfcDocumentVerifications)
    .where(eq(nbfcDocumentVerifications.id, opts.verdictId))
    .limit(1);
  if (!verdict) throw new Error("NOT_FOUND: verdict not found");

  const message = opts.message.trim();
  if (!message) throw new Error("BAD_REQUEST: a message for the NBFC is required");
  if (opts.attachments.length === 0) {
    throw new Error("BAD_REQUEST: attach at least one document to send");
  }

  const docFor: "primary" | "co_borrower" =
    verdict.doc_for === "co_borrower" ? "co_borrower" : "primary";
  const docLabel = VERDICT_DOC_LABELS[verdict.doc_key] ?? verdict.doc_key;
  const applicant = docFor === "co_borrower" ? "co-borrower" : "customer";
  const comments = [
    `iTarang admin uploaded the ${applicant}'s ${docLabel} in response to your ${
      verdict.verdict === "rejected" ? "rejection" : "correction request"
    }.`,
    message,
  ].join("\n");

  // A message wrapper: no children, already with the NBFC.
  const { id: requestId } = await createNbfcDocRequest({
    leadId: verdict.lead_id,
    assignmentId: verdict.assignment_id,
    nbfcId: verdict.nbfc_id,
    tenantId: verdict.tenant_id,
    requestType: "message",
    docFor,
    targetDocKey: verdict.doc_key,
    comments,
    raisedBy: opts.adminUserId,
    initialStatus: NBFC_DOC_STATUS.PUSHED,
    attachments: opts.attachments,
    verdictId: verdict.id,
  });

  await db
    .update(nbfcDocumentVerifications)
    .set({ updated_at: new Date() })
    .where(eq(nbfcDocumentVerifications.id, verdict.id));

  return {
    requestId,
    leadId: verdict.lead_id,
    tenantId: verdict.tenant_id,
    docLabel,
    attachmentCount: opts.attachments.length,
  };
}

/** Admin declines the NBFC ask outright — no children created. */
export async function declineNbfcDocRequest(opts: {
  requestId: string;
  adminUserId: string;
  adminNotes?: string | null;
}): Promise<void> {
  const now = new Date();
  await db
    .update(nbfcDocRequests)
    .set({
      status: NBFC_DOC_STATUS.REJECTED,
      admin_notes: opts.adminNotes ?? null,
      reviewed_by: opts.adminUserId,
      closed_at: now,
      updated_at: now,
    })
    .where(eq(nbfcDocRequests.id, opts.requestId));
}

/**
 * Pure projection: recompute a wrapper's hop-status from its children's
 * `upload_status`. Called after every child upload/review. A message request
 * (no children) is never touched. Admin-origin rows never reach here — the
 * child review route guards on `row.nbfc_request_id`.
 */
export async function recomputeWrapperStatus(
  requestId: string,
): Promise<NbfcDocStatus | null> {
  const [wrapper] = await db
    .select()
    .from(nbfcDocRequests)
    .where(eq(nbfcDocRequests.id, requestId))
    .limit(1);
  if (!wrapper) return null;
  // E-239 — a direct NBFC→dealer request has no children at all; its status is
  // driven by the message thread (dealer replies → PUSHED), so projecting from
  // child min-state here would pin it at its current value forever.
  if (wrapper.dealer_direct) return wrapper.status as NbfcDocStatus;
  // Terminal / message states are not projected.
  if (
    wrapper.request_type === "message" ||
    wrapper.status === NBFC_DOC_STATUS.PUSHED ||
    wrapper.status === NBFC_DOC_STATUS.CLOSED ||
    wrapper.status === NBFC_DOC_STATUS.REJECTED
  ) {
    return wrapper.status as NbfcDocStatus;
  }

  const children = await db
    .select({ upload_status: otherDocumentRequests.upload_status })
    .from(otherDocumentRequests)
    .where(eq(otherDocumentRequests.nbfc_request_id, requestId));
  if (children.length === 0) return wrapper.status as NbfcDocStatus;

  const isUploaded = (s: string | null) => s === "uploaded" || s === "verified";
  const anyPending = children.some((c) => !isUploaded(c.upload_status));
  const allUploaded = children.every((c) => isUploaded(c.upload_status));

  let next: NbfcDocStatus;
  if (children.every((c) => !isUploaded(c.upload_status))) {
    // Nothing collected yet — out with the dealer/customer.
    next = NBFC_DOC_STATUS.FORWARDED;
  } else if (anyPending) {
    // Partially fulfilled — still collecting the rest.
    next = NBFC_DOC_STATUS.WITH_CUSTOMER;
  } else if (allUploaded) {
    // Everything is in (uploaded/verified) — admin reviews then pushes.
    next = NBFC_DOC_STATUS.ADMIN_REVIEW_UPLOAD;
  } else {
    next = NBFC_DOC_STATUS.WITH_CUSTOMER;
  }

  if (next !== wrapper.status) {
    await db
      .update(nbfcDocRequests)
      .set({ status: next, updated_at: new Date() })
      .where(eq(nbfcDocRequests.id, requestId));
  }
  return next;
}

/** True when every child of the wrapper is `verified` (gate for push). */
export async function allChildrenVerified(requestId: string): Promise<boolean> {
  const children = await db
    .select({ upload_status: otherDocumentRequests.upload_status })
    .from(otherDocumentRequests)
    .where(eq(otherDocumentRequests.nbfc_request_id, requestId));
  return children.length > 0 && children.every((c) => c.upload_status === "verified");
}

/**
 * Admin pushes a completed request up to the NBFC. Requires every child to be
 * `verified` (skipped for message requests, which have no children).
 */
export async function pushNbfcDocRequest(opts: {
  requestId: string;
  adminUserId: string;
}): Promise<void> {
  const [wrapper] = await db
    .select()
    .from(nbfcDocRequests)
    .where(eq(nbfcDocRequests.id, opts.requestId))
    .limit(1);
  if (!wrapper) throw new Error("NOT_FOUND: nbfc request not found");
  // E-239 — a direct request has no children to verify; the dealer's reply is
  // what hands it back (see markDirectRequestAnswered).
  if (wrapper.request_type !== "message" && !wrapper.dealer_direct) {
    const ok = await allChildrenVerified(opts.requestId);
    if (!ok) {
      throw new Error(
        "BAD_REQUEST: every requested document must be verified before pushing to the NBFC",
      );
    }
  }
  const now = new Date();
  await db
    .update(nbfcDocRequests)
    .set({
      status: NBFC_DOC_STATUS.PUSHED,
      reviewed_by: opts.adminUserId,
      updated_at: now,
    })
    .where(eq(nbfcDocRequests.id, opts.requestId));
}

/**
 * Auto-push (E-209): the moment the admin verifies the LAST outstanding child of
 * an NBFC-originated wrapper, hand it straight back to the NBFC — no manual
 * "Push to NBFC" click. A no-op (returns { pushed: false }) for admin-origin
 * rows, message wrappers, already-terminal wrappers, or wrappers with any child
 * still unverified. The caller fires the NBFC notification when pushed is true.
 */
export async function autoPushNbfcIfAllVerified(
  requestId: string,
  adminUserId: string,
): Promise<{ pushed: boolean; tenantId?: string; leadId?: string }> {
  const [wrapper] = await db
    .select({
      id: nbfcDocRequests.id,
      lead_id: nbfcDocRequests.lead_id,
      tenant_id: nbfcDocRequests.tenant_id,
      status: nbfcDocRequests.status,
      request_type: nbfcDocRequests.request_type,
    })
    .from(nbfcDocRequests)
    .where(eq(nbfcDocRequests.id, requestId))
    .limit(1);
  if (!wrapper) return { pushed: false };
  if (
    wrapper.request_type === "message" ||
    wrapper.status === NBFC_DOC_STATUS.PUSHED ||
    wrapper.status === NBFC_DOC_STATUS.CLOSED ||
    wrapper.status === NBFC_DOC_STATUS.REJECTED
  ) {
    return { pushed: false };
  }
  const ok = await allChildrenVerified(requestId);
  if (!ok) return { pushed: false };

  await pushNbfcDocRequest({ requestId, adminUserId });
  return {
    pushed: true,
    tenantId: wrapper.tenant_id,
    leadId: wrapper.lead_id,
  };
}

/**
 * E-239 — the dealer answered a direct request: hand it straight back to the
 * NBFC. `pushed_to_nbfc` is reused deliberately, so the NBFC's existing
 * "Acknowledge & close" button lights up with no new UI state.
 *
 * A CLOSED thread is left closed — the NBFC acknowledged it, and a late dealer
 * message should not silently reopen a thread the NBFC has stopped watching.
 */
export async function markDirectRequestAnswered(
  requestId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(nbfcDocRequests)
    .set({ status: NBFC_DOC_STATUS.PUSHED, updated_at: now })
    .where(
      and(
        eq(nbfcDocRequests.id, requestId),
        eq(nbfcDocRequests.dealer_direct, true),
        ne(nbfcDocRequests.status, NBFC_DOC_STATUS.CLOSED),
      ),
    );
}

/**
 * E-239 — the NBFC replied again on a direct thread: pull it back to the dealer
 * so it reappears on the Step-4 card. A closed thread stays closed.
 */
export async function markDirectRequestReopened(
  requestId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(nbfcDocRequests)
    .set({ status: NBFC_DOC_STATUS.FORWARDED, updated_at: now })
    .where(
      and(
        eq(nbfcDocRequests.id, requestId),
        eq(nbfcDocRequests.dealer_direct, true),
        ne(nbfcDocRequests.status, NBFC_DOC_STATUS.CLOSED),
      ),
    );
}

/** NBFC (or admin) acknowledges a pushed request — closes the thread. */
export async function ackNbfcDocRequest(requestId: string): Promise<void> {
  const now = new Date();
  await db
    .update(nbfcDocRequests)
    .set({ status: NBFC_DOC_STATUS.CLOSED, closed_at: now, updated_at: now })
    .where(eq(nbfcDocRequests.id, requestId));
}

export interface ThreadEntry {
  request: typeof nbfcDocRequests.$inferSelect;
  items: Array<typeof otherDocumentRequests.$inferSelect>;
  /** E-239 — the NBFC ⇄ Dealer conversation on this request, oldest first. */
  messages: Array<typeof nbfcDocRequestMessages.$inferSelect>;
}

/**
 * The full request/message thread for a lead, oldest first, each wrapper with
 * its children. Used by the NBFC lead-detail thread UI and the admin CaseReview
 * "NBFC KYC Verification" card. When `tenantId` is passed, scope to that NBFC.
 */
export async function listThreadForLead(
  leadId: string,
  opts?: { tenantId?: string },
): Promise<ThreadEntry[]> {
  const where = opts?.tenantId
    ? and(
        eq(nbfcDocRequests.lead_id, leadId),
        eq(nbfcDocRequests.tenant_id, opts.tenantId),
      )
    : eq(nbfcDocRequests.lead_id, leadId);
  const wrappers = await db
    .select()
    .from(nbfcDocRequests)
    .where(where)
    .orderBy(asc(nbfcDocRequests.created_at));
  if (wrappers.length === 0) return [];

  const ids = wrappers.map((w) => w.id);
  const allItems = await db
    .select()
    .from(otherDocumentRequests)
    .where(inArray(otherDocumentRequests.nbfc_request_id, ids));
  const byWrapper = new Map<string, Array<typeof otherDocumentRequests.$inferSelect>>();
  for (const it of allItems) {
    if (it.nbfc_request_id) {
      const arr = byWrapper.get(it.nbfc_request_id) ?? [];
      arr.push(it);
      byWrapper.set(it.nbfc_request_id, arr);
    }
  }
  const byMessages = await messagesByRequest(ids);
  return wrappers.map((request) => ({
    request,
    items: byWrapper.get(request.id) ?? [],
    messages: byMessages.get(request.id) ?? [],
  }));
}

/** One direct request as the DEALER sees it — no tenant/assignment internals. */
export interface DealerRequestEntry {
  id: string;
  nbfcName: string;
  status: string;
  doc_for: string;
  created_at: Date;
  messages: Array<{
    id: string;
    party: string;
    message: string | null;
    attachments: RequestAttachment[];
    created_at: Date;
  }>;
}

/**
 * The direct (E-239) NBFC requests on a lead, for the dealer's Step-4 card.
 *
 * Scoped to `dealer_direct` wrappers ONLY: admin-gated requests reach the dealer
 * through the existing `other_document_requests` surface on Step 2/3, and
 * showing them here too would double-ask for the same document. Closed threads
 * are dropped — the dealer's card is a to-do list, not an archive.
 *
 * The caller MUST have already checked that this dealer owns the lead.
 */
export async function listDealerRequestsForLead(
  leadId: string,
): Promise<DealerRequestEntry[]> {
  const wrappers = await db
    .select({
      id: nbfcDocRequests.id,
      nbfc_id: nbfcDocRequests.nbfc_id,
      status: nbfcDocRequests.status,
      doc_for: nbfcDocRequests.doc_for,
      created_at: nbfcDocRequests.created_at,
    })
    .from(nbfcDocRequests)
    .where(
      and(
        eq(nbfcDocRequests.lead_id, leadId),
        eq(nbfcDocRequests.dealer_direct, true),
      ),
    )
    .orderBy(asc(nbfcDocRequests.created_at));
  const open = wrappers.filter((w) => w.status !== NBFC_DOC_STATUS.CLOSED);
  if (open.length === 0) return [];

  const byMessages = await messagesByRequest(open.map((w) => w.id));
  const names = await nbfcDisplayNames([...new Set(open.map((w) => w.nbfc_id))]);

  return open.map((w) => ({
    id: w.id,
    nbfcName: names.get(w.nbfc_id) ?? "Your lender",
    status: w.status,
    doc_for: w.doc_for,
    created_at: w.created_at,
    messages: (byMessages.get(w.id) ?? []).map((m) => ({
      id: m.id,
      party: m.party,
      message: m.message,
      attachments: (m.attachments as RequestAttachment[] | null) ?? [],
      created_at: m.created_at,
    })),
  }));
}

/**
 * Display name per nbfc.id. Best-effort — the dealer's card falls back to
 * "Your lender" rather than failing, and the lender's legal name is not
 * load-bearing here (the dealer already knows who the lead was routed to).
 */
async function nbfcDisplayNames(
  nbfcIds: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (nbfcIds.length === 0) return out;
  try {
    const rows = await db
      .select({
        id: nbfc.id,
        short_name: nbfc.short_name,
        legal_name: nbfc.legal_name,
      })
      .from(nbfc)
      .where(inArray(nbfc.id, nbfcIds));
    for (const r of rows) {
      const name = r.short_name || r.legal_name;
      if (name) out.set(r.id, name);
    }
  } catch {
    // best-effort
  }
  return out;
}
