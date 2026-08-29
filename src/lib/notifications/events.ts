/**
 * The event vocabulary of the notification hub.
 *
 * One exported function per business event. Route handlers call exactly one of
 * these on their success path and pass only the facts; everything else — who
 * gets told, what each portal's copy says, which page each recipient lands on,
 * which one-click actions they get, whether it emails — is decided HERE.
 *
 * WHY A LAYER AT ALL, RATHER THAN emit() AT EVERY CALL SITE. There are ~65 call
 * sites across the lead, KYC, NBFC, product and onboarding flows. Inlining the
 * audience/copy/href decision at each one guarantees they drift: three routes
 * that all mean "the NBFC asked for something" would word it three ways and
 * link to three places. Keeping the decision in one file means a route diff is a
 * single line, and changing where (say) an FI notification points is one edit.
 *
 * BEST-EFFORT BY CONTRACT — inherited from `emit()`, which never throws. A
 * notification can never be the reason a business action fails, so callers do
 * not need their own try/catch (though existing ones do no harm).
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import {
  ADMIN_AUDIENCE_ROLES,
  emit,
  tenantDisplayName,
  toAdmins,
  toLeadDealer,
  toLeadNbfcs,
  toNbfc,
  type NotifAction,
  type Recipient,
} from "@/lib/notifications/emit";
import {
  ADMIN_PARTY,
  SYSTEM_PARTY,
  actingParty,
  agentParty,
  customerParty,
  dealerParty,
  nbfcParty,
  type Party,
} from "@/lib/notifications/provenance";

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Admin's workspace for a lead — the one page that holds the whole file. */
const adminLead = (leadId: string, hash = "") => `/admin/kyc-review/${leadId}${hash}`;
const nbfcLead = (leadId: string, hash = "") => `/nbfc/acquire/${leadId}${hash}`;
const dealerLead = (leadId: string, sub = "") => `/dealer-portal/leads/${leadId}${sub}`;

/** Customer name for copy, so a row reads "Ravi Kumar" not "LEAD-00231". */
export async function leadLabel(leadId: string): Promise<string> {
  try {
    const [row] = await db
      .select({ full_name: leads.full_name, owner_name: leads.owner_name })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    return row?.full_name || row?.owner_name || leadId;
  } catch {
    return leadId;
  }
}

/* ================================================================== *
 * LEADS
 * ================================================================== */

/**
 * A dealer committed Step 1 — the first moment a lead is a real person rather
 * than a draft placeholder. Draft creation deliberately does NOT notify: a
 * dealer opening the wizard and abandoning it is not news.
 */
export async function notifyLeadCreated(p: {
  leadId: string;
  customerName?: string | null;
  paymentMethod?: string | null;
  source?: "portal" | "whatsapp" | "import";
  dealerName?: string | null;
}) {
  const who = p.customerName || (await leadLabel(p.leadId));
  const via =
    p.source === "whatsapp" ? " over WhatsApp" : p.source === "import" ? " via import" : "";
  await emit({
    type: "lead.created",
    title: "New lead created",
    message:
      `${p.dealerName ?? "A dealer"} created a new ${p.paymentMethod === "cash" || p.paymentMethod === "upfront" ? "cash" : "finance"} lead for ${who}${via}.`,
    leadId: p.leadId,
    stage: "Step 1",
    from: p.dealerName ? dealerParty(p.dealerName) : await actingParty(),
    data: { customer_name: who, payment_method: p.paymentMethod ?? null, source: p.source ?? "portal" },
    to: [toAdmins({ href: adminLead(p.leadId) })],
  });
}

/** A lead was routed to a specific internal owner. */
export async function notifyLeadAssigned(p: {
  leadId: string;
  assigneeUserId: string;
  customerName?: string | null;
}) {
  const who = p.customerName || (await leadLabel(p.leadId));
  await emit({
    type: "lead.assigned",
    title: "Lead assigned to you",
    message: `${who} has been assigned to you.`,
    leadId: p.leadId,
    stage: "Lead pipeline",
    from: await actingParty(),
    to: [
      {
        audience: { kind: "user", userId: p.assigneeUserId },
        as: ADMIN_PARTY,
        href: adminLead(p.leadId),
      },
    ],
  });
}

/** A lead was discarded or closed out. */
export async function notifyLeadClosed(p: {
  leadId: string;
  outcome: "discarded" | "closed";
  reason?: string | null;
}) {
  const who = await leadLabel(p.leadId);
  await emit({
    type: p.outcome === "discarded" ? "lead.discarded" : "lead.closed",
    title: p.outcome === "discarded" ? "Lead discarded" : "Lead closed",
    message: `${who} was ${p.outcome}${p.reason ? `. Reason: ${p.reason}` : "."}`,
    leadId: p.leadId,
    stage: "Lead pipeline",
    from: await actingParty(),
    data: { reason: p.reason ?? null },
    to: [toAdmins({ href: adminLead(p.leadId) })],
  });
}

/* ================================================================== *
 * DEALER ONBOARDING (portal + WhatsApp)
 * ================================================================== */

/** A dealer started the WhatsApp onboarding conversation. */
export async function notifyOnboardingChatStarted(p: {
  phone: string;
  sessionId?: string | null;
}) {
  await emit({
    type: "onboarding.chat_started",
    title: "WhatsApp onboarding started",
    message: `A dealer started onboarding over WhatsApp from ${p.phone}.`,
    stage: "Onboarding · WhatsApp",
    from: { party: "dealer", label: `WhatsApp ${p.phone}` },
    data: { phone: p.phone, session_id: p.sessionId ?? null },
    // NOT /admin/dealer-verification: that queue hides unfinished applications,
    // so this link used to land the admin on a page where the new contact was
    // nowhere to be seen. The WhatsApp console shows them from message one.
    to: [toAdmins({ href: "/admin/whatsapp-onboarding?tab=live" })],
  });
}

/** Documents arrived over WhatsApp and were read. */
export async function notifyOnboardingDocsUploaded(p: {
  phone: string;
  docLabel: string;
  businessName?: string | null;
}) {
  await emit({
    type: "onboarding.docs_uploaded",
    title: "Onboarding document received",
    message: `${p.businessName ?? p.phone} sent "${p.docLabel}" over WhatsApp.`,
    stage: "Onboarding · WhatsApp",
    from: dealerParty(p.businessName ?? `WhatsApp ${p.phone}`),
    data: { phone: p.phone, doc_label: p.docLabel },
    // Same reason as above — the document is on file long before the dealer
    // submits, and only the WhatsApp console will show it that early.
    to: [toAdmins({ href: "/admin/whatsapp-onboarding?tab=live" })],
  });
}

/** A dealer submitted their onboarding application for verification. */
export async function notifyOnboardingSubmitted(p: {
  dealerId?: string | null;
  applicationId?: string | null;
  businessName: string;
  channel?: "portal" | "whatsapp";
}) {
  const href = p.dealerId ? `/admin/dealer-verification/${p.dealerId}` : "/admin/dealer-verification";
  await emit({
    type: "onboarding.submitted",
    title: "Dealer onboarding submitted",
    message: `${p.businessName} submitted their onboarding application${
      p.channel === "whatsapp" ? " over WhatsApp" : ""
    } and is awaiting verification.`,
    stage: "Onboarding",
    from: dealerParty(p.businessName),
    data: { dealerId: p.dealerId ?? null, application_id: p.applicationId ?? null },
    to: [toAdmins({ href })],
  });
}

/**
 * The dealer agreement was sent for signature. Names BOTH signers, because the
 * usual question at this point is "who is it waiting on" — the dealer's own
 * signer or the iTarang counter-signatory.
 */
export async function notifyDealerAgreementInitiated(p: {
  dealerId: string;
  businessName: string;
  dealerSigner?: string | null;
  itarangSigner?: string | null;
  channel?: "email" | "whatsapp";
}) {
  const signers = [
    p.dealerSigner ? `dealer: ${p.dealerSigner}` : null,
    p.itarangSigner ? `iTarang: ${p.itarangSigner}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  await emit({
    type: "onboarding.agreement_initiated",
    title: "Dealer agreement sent for signature",
    message: `The agreement for ${p.businessName} was sent for signing${
      p.channel === "whatsapp" ? " over WhatsApp" : " by email"
    }${signers ? ` (${signers})` : ""}.`,
    stage: "Onboarding · Agreement",
    from: await actingParty(),
    data: {
      dealerId: p.dealerId,
      dealer_signer: p.dealerSigner ?? null,
      itarang_signer: p.itarangSigner ?? null,
    },
    to: [
      toAdmins({ href: `/admin/dealer-verification/${p.dealerId}` }),
      {
        audience: { kind: "dealer", dealerId: p.dealerId },
        as: dealerParty(p.businessName),
        href: "/dealer-portal/onboarding-status",
        title: "Your agreement is ready to sign",
        message: p.dealerSigner
          ? `The dealer agreement was sent to ${p.dealerSigner} for signature.`
          : "The dealer agreement was sent to you for signature.",
      },
    ],
  });
}

/** One party signed. Says who signed and who is still outstanding. */
export async function notifyDealerAgreementSigned(p: {
  dealerId: string;
  businessName: string;
  signerName?: string | null;
  signerSide: "dealer" | "itarang";
  allSigned: boolean;
}) {
  const signer = p.signerName || (p.signerSide === "dealer" ? p.businessName : "iTarang");
  const message = p.allSigned
    ? `The dealer agreement for ${p.businessName} is fully signed.`
    : `${signer} signed the dealer agreement. Awaiting the ${
        p.signerSide === "dealer" ? "iTarang" : "dealer"
      } signature.`;
  await emit({
    type: "onboarding.agreement_signed",
    title: p.allSigned ? "Dealer agreement fully signed" : "Dealer agreement signed",
    message,
    stage: "Onboarding · Agreement",
    from: p.signerSide === "dealer" ? dealerParty(p.businessName, signer) : ADMIN_PARTY,
    data: { dealerId: p.dealerId, signer: signer, signer_side: p.signerSide, all_signed: p.allSigned },
    to: [
      toAdmins({ href: `/admin/dealer-verification/${p.dealerId}` }),
      {
        audience: { kind: "dealer", dealerId: p.dealerId },
        as: dealerParty(p.businessName),
        href: "/dealer-portal/onboarding-status",
      },
    ],
  });
}

/** Admin approved / rejected / asked for corrections on an onboarding file. */
export async function notifyOnboardingDecision(p: {
  dealerId: string;
  businessName: string;
  decision: "approved" | "rejected" | "correction_requested";
  reason?: string | null;
}) {
  const copy = {
    approved: {
      type: "onboarding.approved",
      title: "Onboarding approved",
      message: "Your dealer account has been approved. You can now sign in and start creating leads.",
    },
    rejected: {
      type: "onboarding.rejected",
      title: "Onboarding rejected",
      message: p.reason
        ? `Your onboarding application was rejected. Reason: ${p.reason}`
        : "Your onboarding application was rejected. Please contact iTarang for details.",
    },
    correction_requested: {
      type: "onboarding.correction_requested",
      title: "Corrections needed on your application",
      message: p.reason
        ? `iTarang asked for corrections before approving your application. ${p.reason}`
        : "iTarang asked for corrections before approving your application.",
    },
  }[p.decision];

  await emit({
    type: copy.type,
    title: copy.title,
    message: copy.message,
    stage: "Onboarding",
    from: await actingParty(),
    data: { dealerId: p.dealerId, decision: p.decision, reason: p.reason ?? null },
    // The dealer's own bespoke approval/rejection email already goes out from
    // the route, so this in-app row does not send a second one.
    email: false,
    to: [
      {
        audience: { kind: "dealer", dealerId: p.dealerId },
        as: dealerParty(p.businessName),
        href: "/dealer-portal/onboarding-status",
      },
      toAdmins({
        href: `/admin/dealer-verification/${p.dealerId}`,
        title: `Dealer ${p.decision.replace("_", " ")}`,
        message: `${p.businessName} was ${p.decision.replace("_", " ")}.`,
      }),
    ],
  });
}

/* ================================================================== *
 * KYC & CONSENT
 * ================================================================== */

/** A dealer submitted KYC for admin review (and the NBFCs on the lead, if any). */
export async function notifyKycSubmitted(p: {
  leadId: string;
  customerName?: string | null;
  dealerName?: string | null;
  cardCount?: number | null;
}) {
  const who = p.customerName || (await leadLabel(p.leadId));
  await emit({
    type: "kyc.submitted",
    title: "KYC submitted for verification",
    message: `${p.dealerName ?? "A dealer"} submitted KYC for ${who}${
      p.cardCount ? ` (${p.cardCount} verification${p.cardCount === 1 ? "" : "s"})` : ""
    }. Awaiting your review.`,
    leadId: p.leadId,
    stage: "Step 2 · KYC",
    from: p.dealerName ? dealerParty(p.dealerName) : await actingParty(),
    to: [
      toAdmins({ href: adminLead(p.leadId) }),
      toLeadNbfcs(p.leadId, { message: `KYC for ${who} was submitted and is now available.` }),
    ],
  });
}

/** The dealer sent the DPDP consent to the customer for signature. */
export async function notifyConsentSent(p: {
  leadId: string;
  customerName?: string | null;
  channel?: string | null;
  sentBy?: Party;
}) {
  const who = p.customerName || (await leadLabel(p.leadId));
  await emit({
    type: "consent.sent",
    title: "Consent sent for signature",
    message: `The DPDP consent for ${who} was sent${p.channel ? ` by ${p.channel}` : ""} and is awaiting signature.`,
    leadId: p.leadId,
    stage: "Step 2 · Consent",
    from: p.sentBy ?? (await actingParty()),
    to: [
      toAdmins({ href: adminLead(p.leadId, "#consent") }),
      toLeadNbfcs(p.leadId, { href: nbfcLead(p.leadId, "#consent") }),
    ],
  });
}

/**
 * The consent was signed — by whom, and against which Aadhaar. "Who signed" is
 * the whole point of this one: the signer must match the captured Aadhaar, and
 * a co-borrower signing in the borrower's place is exactly what the gate exists
 * to catch.
 */
export async function notifyConsentSigned(p: {
  leadId: string;
  signerName?: string | null;
  signerRole?: "borrower" | "co_borrower";
  method?: "esign" | "otp" | "manual";
}) {
  const who = p.signerName || (await leadLabel(p.leadId));
  const role = p.signerRole === "co_borrower" ? "co-borrower" : "borrower";
  await emit({
    type: "consent.signed",
    title: "Consent signed",
    message: `${who} (${role}) signed the DPDP consent${
      p.method === "manual" ? " — recorded manually" : p.method === "otp" ? " by OTP" : ""
    }.`,
    leadId: p.leadId,
    stage: "Step 2 · Consent",
    from: customerParty(who),
    data: { signer_name: p.signerName ?? null, signer_role: p.signerRole ?? "borrower", method: p.method ?? null },
    to: [
      toAdmins({ href: adminLead(p.leadId, "#consent") }),
      toLeadNbfcs(p.leadId, { href: nbfcLead(p.leadId, "#consent") }),
    ],
  });
}

/**
 * The dealer shared documents — Step-3 supporting docs, a re-upload against a
 * request, or the Step-4 pre-sanction bucket.
 */
export async function notifyDocsShared(p: {
  leadId: string;
  docLabel: string;
  count?: number | null;
  dealerName?: string | null;
  stage?: string;
}) {
  const who = await leadLabel(p.leadId);
  const n = p.count ?? 1;
  await emit({
    type: "kyc.docs_shared",
    title: "Documents shared by dealer",
    message: `${p.dealerName ?? "The dealer"} uploaded ${n} document${n === 1 ? "" : "s"} (${p.docLabel}) for ${who}.`,
    leadId: p.leadId,
    stage: p.stage ?? "Step 3 · Documents",
    from: p.dealerName ? dealerParty(p.dealerName) : await actingParty(),
    data: { doc_label: p.docLabel, count: n },
    to: [
      toAdmins({ href: adminLead(p.leadId, "#other-documentation") }),
      toLeadNbfcs(p.leadId, { href: nbfcLead(p.leadId, "#documents") }),
    ],
  });
}

/** Admin asked the dealer for a co-borrower. */
export async function notifyCoBorrowerRequested(p: {
  leadId: string;
  reason?: string | null;
  requestedBy?: Party;
}) {
  await emit({
    type: "kyc.coborrower_requested",
    title: "Co-borrower required",
    message: p.reason
      ? `A co-borrower is required on this application. ${p.reason}`
      : "A co-borrower is required on this application. Please add their details and KYC.",
    leadId: p.leadId,
    stage: "Step 3 · Co-borrower",
    from: p.requestedBy ?? (await actingParty()),
    to: [
      toLeadDealer(p.leadId, { href: dealerLead(p.leadId, "/borrower-consent") }),
      toAdmins({
        href: adminLead(p.leadId),
        title: "Co-borrower requested from dealer",
        message: "A co-borrower request was sent to the dealer.",
        email: false,
      }),
    ],
  });
}

/* ================================================================== *
 * THE NBFC ⇄ ADMIN ⇄ DEALER REQUEST LOOP
 * ================================================================== */

/**
 * In-bell actions for an NBFC request sitting with the admin.
 *
 * These are the SESSION-authenticated admin routes (`requireAdminAppUser`), not
 * `/act` — `/act` is the tokenised twin used by the "act from email" page
 * (src/app/request-action/[id]/page.tsx) and REQUIRES a `token` in its body,
 * which a bell click has no way to mint. Same underlying service functions
 * (`forwardNbfcDocRequest` / `declineNbfcDocRequest` / `pushNbfcDocRequest`),
 * different front door.
 *
 * Only no-input decisions get a button. Forwarding needs the admin to type
 * which documents to ask the dealer for, so it opens the page instead — a
 * half-filled form in a dropdown helps nobody.
 */
function nbfcRequestActions(requestId: string, kind: "review" | "push"): NotifAction[] {
  if (kind === "push") {
    return [
      {
        label: "Push to NBFC",
        endpoint: `/api/admin/nbfc-requests/${requestId}/push`,
        variant: "primary",
        successLabel: "Pushed to NBFC",
      },
    ];
  }
  return [
    { label: "Review & forward", endpoint: "", opensHref: true, variant: "primary" },
    {
      label: "Decline",
      endpoint: `/api/admin/nbfc-requests/${requestId}/forward`,
      body: { action: "decline" },
      confirm: "Decline this NBFC request?",
      variant: "danger",
      successLabel: "Declined",
    },
  ];
}

/** An NBFC raised a request against a lead. Lands with the admin to route. */
export async function notifyNbfcRequestRaised(p: {
  leadId: string;
  requestId: string;
  requestType: string;
  nbfcName: string;
  tenantId?: string | null;
  comments?: string | null;
}) {
  const typeLabel =
    {
      correction: "document correction",
      additional_docs: "additional documents",
      step4_extra_items: "extra Step-4 items",
      manual_consent: "manual DPDP consent signing",
      co_borrower: "a co-borrower",
    }[p.requestType] ?? "a message";
  const who = await leadLabel(p.leadId);

  await emit({
    type: "nbfc.request_raised",
    title: `NBFC request: ${typeLabel}`,
    message: `${p.nbfcName} requested ${typeLabel} on ${who}.${p.comments ? ` "${p.comments}"` : ""}`,
    leadId: p.leadId,
    stage: "NBFC request",
    from: nbfcParty(p.nbfcName),
    data: { requestId: p.requestId, requestType: p.requestType },
    to: [
      toAdmins({
        href: adminLead(p.leadId, "#nbfc-actions"),
        actions: nbfcRequestActions(p.requestId, "review"),
      }),
    ],
  });
}

/**
 * Admin forwarded an NBFC request down to the dealer. E-257 — or the SLA sweep
 * did, in which case `from` is SYSTEM_PARTY and the wording says so.
 */
export async function notifyNbfcRequestForwarded(p: {
  leadId: string;
  requestId: string;
  docLabels: string[];
  nbfcName?: string | null;
  targetStep?: "kyc" | "borrower-consent";
  from?: Party;
}) {
  const list = p.docLabels.filter(Boolean).join(", ");
  const bySystem = p.from?.party === "system";
  await emit({
    type: "nbfc.request_forwarded",
    title: "Documents requested",
    message: `${bySystem ? "iTarang" : "iTarang admin"} needs ${list || "additional documents"} for this application${
      p.nbfcName ? ` (requested by ${p.nbfcName})` : ""
    }. Please upload and re-submit.`,
    leadId: p.leadId,
    stage: "NBFC request",
    from: p.from ?? ADMIN_PARTY,
    data: { requestId: p.requestId, doc_labels: p.docLabels },
    to: [
      toLeadDealer(p.leadId, {
        href: dealerLead(p.leadId, `/${p.targetStep ?? "kyc"}#other-documentation`),
      }),
    ],
  });
}

/**
 * E-240 — the NBFC asked the DEALER directly, skipping the admin forward gate.
 *
 * The dealer is the actionable recipient and lands on the Step-4 pre-sanction
 * card, where the ask and the upload control sit together. Admins are told too,
 * on the same event, because the direct channel removes the admin as a blocker —
 * not as an observer; without this row the first an admin hears of a lender
 * question is the dealer's answer.
 */
export async function notifyNbfcDocRequestDirect(p: {
  leadId: string;
  requestId: string;
  nbfcName?: string | null;
  comments?: string | null;
}) {
  const lender = p.nbfcName || "Your lender";
  const ask = (p.comments ?? "").trim();
  const short = ask.length > 160 ? `${ask.slice(0, 157)}…` : ask;
  await emit({
    type: "nbfc.doc_req_direct",
    title: "Lender needs a document",
    message: short
      ? `${lender} needs a document for this application: ${short}`
      : `${lender} needs an additional document for this application.`,
    leadId: p.leadId,
    stage: "Step 4 · NBFC request",
    from: nbfcParty(lender),
    data: { requestId: p.requestId },
    to: [
      toLeadDealer(p.leadId, {
        href: dealerLead(p.leadId, "/product-selection#nbfc-requests"),
      }),
      toAdmins({ href: adminLead(p.leadId, "#nbfc-actions") }),
    ],
  });
}

/** E-240 — the dealer answered a direct NBFC request. Goes straight back. */
export async function notifyDealerRepliedToNbfc(p: {
  leadId: string;
  requestId: string;
  tenantId?: string | null;
  dealerName?: string | null;
  count?: number | null;
}) {
  const who = await leadLabel(p.leadId);
  const n = p.count ?? 0;
  const files =
    n > 0 ? `${n} document${n === 1 ? "" : "s"}` : "a reply with no attachment";
  await emit({
    type: "nbfc.doc_req_reply",
    title: "Dealer answered your request",
    message: `${p.dealerName ?? "The dealer"} sent ${files} for ${who}.`,
    leadId: p.leadId,
    stage: "Step 4 · NBFC request",
    from: p.dealerName ? dealerParty(p.dealerName) : await actingParty(),
    data: { requestId: p.requestId, count: n },
    to: [
      // Scoped to the NBFC that asked, not every routed lender — a competing
      // lender has no business seeing what was sent to the one that asked.
      ...(p.tenantId
        ? [
            toNbfc(p.tenantId, await tenantDisplayName(p.tenantId), {
              href: nbfcLead(p.leadId, "#nbfc-requests"),
            }),
          ]
        : [toLeadNbfcs(p.leadId, { href: nbfcLead(p.leadId, "#nbfc-requests") })]),
      toAdmins({ href: adminLead(p.leadId, "#nbfc-actions") }),
    ],
  });
}

/** The dealer uploaded against an NBFC request — back with the admin to push. */
export async function notifyNbfcRequestUpload(p: {
  leadId: string;
  requestId: string;
  docLabel: string;
  dealerName?: string | null;
}) {
  const who = await leadLabel(p.leadId);
  await emit({
    type: "nbfc.doc_uploaded",
    title: "Requested document uploaded",
    message: `${p.dealerName ?? "The dealer"} uploaded "${p.docLabel}" for ${who}. Ready to push to the NBFC.`,
    leadId: p.leadId,
    stage: "NBFC request",
    from: p.dealerName ? dealerParty(p.dealerName) : await actingParty(),
    data: { requestId: p.requestId, doc_label: p.docLabel },
    to: [
      toAdmins({
        href: adminLead(p.leadId, "#nbfc-actions"),
        actions: nbfcRequestActions(p.requestId, "push"),
      }),
    ],
  });
}

/**
 * Admin pushed the finished documents (or a direct message) up to the NBFC.
 * E-257 — or the SLA sweep did (`from` = SYSTEM_PARTY).
 */
export async function notifyNbfcRequestPushed(p: {
  leadId: string;
  requestId: string;
  tenantId: string;
  isMessage?: boolean;
  from?: Party;
}) {
  const who = await leadLabel(p.leadId);
  const label = await tenantDisplayName(p.tenantId);
  await emit({
    type: "nbfc.request_pushed",
    title: p.isMessage ? "Update from iTarang admin" : "Requested documents are ready",
    message: p.isMessage
      ? `The iTarang admin posted an update on ${who}.`
      : `The documents you requested for ${who} have been updated and are now available.`,
    leadId: p.leadId,
    stage: "NBFC request",
    from: p.from ?? ADMIN_PARTY,
    data: { requestId: p.requestId },
    to: [toNbfc(p.tenantId, label, { href: nbfcLead(p.leadId, "#documents") })],
  });
}

/** An NBFC verified / queried / rejected one document on the lead. */
export async function notifyNbfcDocVerdict(p: {
  leadId: string;
  nbfcName: string;
  docLabel: string;
  verdict: "verified" | "queried" | "rejected";
  comments?: string | null;
  verdictId?: string | number | null;
}) {
  const who = await leadLabel(p.leadId);
  const type =
    p.verdict === "verified"
      ? "nbfc.doc_verified"
      : p.verdict === "rejected"
        ? "nbfc.doc_rejected"
        : "nbfc.verdict_raised";
  await emit({
    type,
    title: `NBFC ${p.verdict} a document`,
    message: `${p.nbfcName} marked "${p.docLabel}" as ${p.verdict} on ${who}.${
      p.comments ? ` "${p.comments}"` : ""
    }`,
    leadId: p.leadId,
    stage: "NBFC verification",
    from: nbfcParty(p.nbfcName),
    data: { doc_label: p.docLabel, verdict: p.verdict, verdictId: p.verdictId ?? null },
    to: [toAdmins({ href: adminLead(p.leadId, "#nbfc-verdicts") })],
  });
}

/* ================================================================== *
 * FIELD INVESTIGATION — the full from → to chain
 * ================================================================== */

export async function notifyFiEvent(p: {
  leadId: string;
  event: "requested" | "assigned" | "submitted" | "reviewed" | "reinspection";
  nbfcName: string;
  tenantId?: string | null;
  agentName?: string | null;
  outcome?: string | null;
  notes?: string | null;
}) {
  const who = await leadLabel(p.leadId);
  const copy: Record<typeof p.event, { type: string; title: string; message: string; from: Party }> = {
    requested: {
      type: "fi.requested",
      title: "Field Investigation requested",
      message: `${p.nbfcName} raised a Field Investigation on ${who}.`,
      from: nbfcParty(p.nbfcName),
    },
    assigned: {
      type: "fi.assigned",
      title: "Field Investigation assigned",
      message: `${p.nbfcName} assigned the Field Investigation for ${who} to ${p.agentName ?? "a field agent"}.`,
      from: nbfcParty(p.nbfcName),
    },
    submitted: {
      type: "fi.submitted",
      title: "Field Investigation submitted",
      message: `${p.agentName ?? "The field agent"} submitted the FI report for ${who}. Awaiting review.`,
      from: agentParty(p.agentName ?? "Field agent"),
    },
    reviewed: {
      type: "fi.reviewed",
      title: "Field Investigation reviewed",
      message: `${p.nbfcName} reviewed the FI for ${who}${p.outcome ? ` — ${p.outcome}` : ""}.${
        p.notes ? ` ${p.notes}` : ""
      }`,
      from: nbfcParty(p.nbfcName),
    },
    reinspection: {
      type: "fi.reinspection",
      title: "Re-inspection ordered",
      message: `${p.nbfcName} ordered a re-inspection for ${who}.${p.notes ? ` ${p.notes}` : ""}`,
      from: nbfcParty(p.nbfcName),
    },
  };
  const c = copy[p.event];

  // Who holds it next drives who gets told: an agent submission is news for the
  // NBFC, an NBFC decision is news for iTarang (and the dealer when it means
  // more work for them).
  const to: Recipient[] = [toAdmins({ href: adminLead(p.leadId, "#fi") })];
  if (p.tenantId) {
    to.push(toNbfc(p.tenantId, p.nbfcName, { href: nbfcLead(p.leadId, "#fi") }));
  } else {
    to.push(toLeadNbfcs(p.leadId, { href: nbfcLead(p.leadId, "#fi") }));
  }
  if (p.event === "reinspection") {
    to.push(toLeadDealer(p.leadId, { href: dealerLead(p.leadId) }));
  }

  await emit({
    type: c.type,
    title: c.title,
    message: c.message,
    leadId: p.leadId,
    stage: "Field Investigation",
    from: c.from,
    data: { agent_name: p.agentName ?? null, outcome: p.outcome ?? null },
    to,
  });
}

/* ================================================================== *
 * BATTERY RECOVERY — the physical collection leg (E-262 / E-263)
 * ================================================================== */

/**
 * Tells the NBFC what its recovery agent just did.
 *
 * The agent has no account and no way into the portal, so everything they
 * report reaches the NBFC through this — including, for a visit that produced
 * nothing, the coordinates they stood at. That is the part that matters: a
 * report saying "nobody home" is a claim, and the same report with a map pin at
 * the borrower's address is a record.
 *
 * Audience is the owning NBFC only. iTarang admins are deliberately NOT copied:
 * a repossession is the lender's operation, and E-231's mute gate exists
 * precisely so feeds are not filled with other people's routine work.
 */
export async function notifyRecoveryEvent(p: {
  tenantId: string;
  nbfcName: string;
  event: "assigned" | "visit" | "collected" | "cancelled";
  borrowerName: string;
  agentName?: string | null;
  batterySerial?: string | null;
  /** Where the agent actually stood. Rendered as a map link in the message. */
  lat?: number | null;
  lng?: number | null;
  /** Metres from the geocoded borrower address, when there was an anchor. */
  distanceM?: number | null;
  /** Visit only: why nothing was collected, and when they will return. */
  outcomeLabel?: string | null;
  nextVisitAt?: Date | null;
  notes?: string | null;
  /** Cancel only. */
  reason?: string | null;
  /** e.g. "the borrower paid" */
  cause?: string | null;
}) {
  const what = p.batterySerial ? `${p.batterySerial} (${p.borrowerName})` : p.borrowerName;
  const agent = p.agentName ?? "The recovery agent";

  // Plain text, in the message itself rather than only in `data`, so it
  // survives into the email body — which is where an operator reading this on a
  // phone will actually see it.
  const where =
    p.lat != null && p.lng != null
      ? ` Location: https://www.google.com/maps?q=${p.lat},${p.lng}` +
        (p.distanceM != null ? ` (${Math.round(p.distanceM)} m from the address).` : ".")
      : "";

  const copy: Record<typeof p.event, { type: string; title: string; message: string }> = {
    assigned: {
      type: "recovery.assigned",
      title: "Recovery agent dispatched",
      message: `${agent} has been sent to collect ${what}.`,
    },
    visit: {
      type: "recovery.visit",
      title: "Agent attended — nothing collected",
      message:
        `${agent} attended for ${what} but could not collect` +
        (p.outcomeLabel ? ` — ${p.outcomeLabel.toLowerCase()}.` : ".") +
        (p.notes ? ` "${p.notes}"` : "") +
        (p.nextVisitAt
          ? ` Returning ${p.nextVisitAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST.`
          : " They are not going back.") +
        where,
    },
    collected: {
      type: "recovery.collected",
      title: "Battery collected — awaiting your review",
      message:
        `${agent} collected ${what}. Review the photographs and approve to file them ` +
        `against the battery.` + where,
    },
    cancelled: {
      type: "recovery.cancelled",
      title: "Battery collection cancelled",
      message:
        `The collection of ${what} was cancelled` +
        (p.cause ? ` — ${p.cause}` : "") +
        `. ${agent} has been told not to collect.` +
        (p.reason ? ` Reason: ${p.reason}` : ""),
    },
  };

  const c = copy[p.event];
  await emit({
    type: c.type,
    title: c.title,
    message: c.message,
    stage: "Recovery",
    from: p.event === "assigned" || p.event === "cancelled"
      ? nbfcParty(p.nbfcName)
      : agentParty(p.agentName ?? "Recovery agent"),
    data: {
      agent_name: p.agentName ?? null,
      battery_serial: p.batterySerial ?? null,
      lat: p.lat ?? null,
      lng: p.lng ?? null,
      distance_from_address_m: p.distanceM ?? null,
      next_visit_at: p.nextVisitAt ? p.nextVisitAt.toISOString() : null,
    },
    to: [
      toNbfc(p.tenantId, p.nbfcName, { href: "/nbfc/recovery/queue" }),
    ],
  });
}

/* ================================================================== *
 * VIDEO KYC / E-NACH / LOAN AGREEMENT
 * ================================================================== */

export async function notifyVkycEvent(p: {
  leadId: string;
  event: "initiated" | "captured" | "approved" | "rejected";
  nbfcName: string;
  tenantId?: string | null;
  reason?: string | null;
}) {
  const who = await leadLabel(p.leadId);
  const copy = {
    initiated: {
      type: "vkyc.initiated",
      title: "Video KYC link sent",
      message: `A Video KYC link was sent to ${who}.`,
    },
    captured: {
      type: "vkyc.captured",
      title: "Video KYC submitted",
      message: `${who} completed their Video KYC. Awaiting review.`,
    },
    approved: {
      type: "vkyc.approved",
      title: "Video KYC approved",
      message: `${p.nbfcName} approved the Video KYC for ${who}.`,
    },
    rejected: {
      type: "vkyc.rejected",
      title: "Video KYC rejected",
      message: `${p.nbfcName} rejected the Video KYC for ${who}.${p.reason ? ` Reason: ${p.reason}` : ""}`,
    },
  }[p.event];

  await emit({
    type: copy.type,
    title: copy.title,
    message: copy.message,
    leadId: p.leadId,
    stage: "Video KYC",
    from: p.event === "captured" ? customerParty(who) : nbfcParty(p.nbfcName),
    data: { reason: p.reason ?? null },
    to: [
      toAdmins({ href: adminLead(p.leadId, "#vkyc") }),
      p.tenantId
        ? toNbfc(p.tenantId, p.nbfcName, { href: nbfcLead(p.leadId, "#vkyc") })
        : toLeadNbfcs(p.leadId, { href: nbfcLead(p.leadId, "#vkyc") }),
      toLeadDealer(p.leadId, { href: dealerLead(p.leadId) }),
    ],
  });
}

export async function notifyEnachEvent(p: {
  leadId: string;
  event: "registered" | "confirmed" | "failed" | "waived";
  nbfcName: string;
  tenantId?: string | null;
  reason?: string | null;
}) {
  const who = await leadLabel(p.leadId);
  const copy = {
    registered: {
      type: "enach.registered",
      title: "E-NACH mandate sent",
      message: `An E-NACH mandate was sent to ${who} for registration.`,
    },
    confirmed: {
      type: "enach.confirmed",
      title: "E-NACH mandate active",
      message: `The E-NACH mandate for ${who} is registered and active.`,
    },
    failed: {
      type: "enach.failed",
      title: "E-NACH mandate failed",
      message: `The E-NACH mandate for ${who} failed.${p.reason ? ` Reason: ${p.reason}` : ""}`,
    },
    waived: {
      type: "enach.waived",
      title: "E-NACH waived",
      message: `${p.nbfcName} marked E-NACH as not required for ${who}.${p.reason ? ` ${p.reason}` : ""}`,
    },
  }[p.event];

  await emit({
    type: copy.type,
    title: copy.title,
    message: copy.message,
    leadId: p.leadId,
    stage: "E-NACH",
    from: p.event === "confirmed" ? customerParty(who) : nbfcParty(p.nbfcName),
    data: { reason: p.reason ?? null },
    to: [
      toAdmins({ href: adminLead(p.leadId, "#enach") }),
      p.tenantId
        ? toNbfc(p.tenantId, p.nbfcName, { href: nbfcLead(p.leadId, "#enach") })
        : toLeadNbfcs(p.leadId, { href: nbfcLead(p.leadId, "#enach") }),
      toLeadDealer(p.leadId, { href: dealerLead(p.leadId) }),
    ],
  });
}

/**
 * Loan agreement lifecycle. `initiated` names the signers for the same reason
 * the dealer agreement does — the useful question is who it is waiting on.
 */
export async function notifyLoanAgreementEvent(p: {
  leadId: string;
  event: "initiated" | "signed" | "recorded";
  nbfcName: string;
  tenantId?: string | null;
  signerName?: string | null;
  pendingSigner?: string | null;
}) {
  const who = await leadLabel(p.leadId);
  const copy = {
    initiated: {
      type: "agreement.initiated",
      title: "Loan agreement sent for signature",
      message: `The loan agreement for ${who} was sent for signature${
        p.signerName ? ` to ${p.signerName}` : ""
      }.`,
    },
    signed: {
      type: "agreement.signed",
      title: "Loan agreement signed",
      message: `${p.signerName ?? who} signed the loan agreement${
        p.pendingSigner ? `. Awaiting ${p.pendingSigner}.` : "."
      }`,
    },
    recorded: {
      type: "agreement.recorded",
      title: "Loan agreement recorded",
      message: `A signed loan agreement for ${who} was recorded manually.`,
    },
  }[p.event];

  await emit({
    type: copy.type,
    title: copy.title,
    message: copy.message,
    leadId: p.leadId,
    stage: "Loan agreement",
    from: p.event === "signed" ? customerParty(p.signerName ?? who) : nbfcParty(p.nbfcName),
    data: { signer: p.signerName ?? null, pending_signer: p.pendingSigner ?? null },
    to: [
      toAdmins({ href: adminLead(p.leadId, "#agreement") }),
      p.tenantId
        ? toNbfc(p.tenantId, p.nbfcName, { href: nbfcLead(p.leadId, "#agreement") })
        : toLeadNbfcs(p.leadId, { href: nbfcLead(p.leadId, "#agreement") }),
      toLeadDealer(p.leadId, { href: dealerLead(p.leadId) }),
    ],
  });
}

/* ================================================================== *
 * PRODUCT SELECTION → SANCTION → DISBURSAL
 * ================================================================== */

/**
 * Step 4 submitted. Carries WHICH NBFC(s) and WHICH loan product the dealer
 * picked — the first thing anyone asks when this lands, and the reason the
 * notification exists rather than a bare "Step 4 submitted".
 */
export async function notifyProductSubmitted(p: {
  leadId: string;
  productSelectionId: string;
  paymentMode: "cash" | "finance";
  /**
   * Null on a finance lead since the Step-4/Step-5 split — the file goes to
   * the lenders before any stock is picked, so there is no price yet. Every
   * message below drops the amount rather than printing "₹undefined".
   */
  finalPrice: number | string | null;
  nbfcNames?: string[];
  loanProduct?: string | null;
  dealerName?: string | null;
}) {
  const who = await leadLabel(p.leadId);
  const nbfcs = (p.nbfcNames ?? []).filter(Boolean);
  const financeBits = [
    nbfcs.length > 0 ? `routed to ${nbfcs.join(" and ")}` : null,
    p.loanProduct ? `product: ${p.loanProduct}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const at = p.finalPrice != null ? ` at ₹${p.finalPrice}` : "";

  await emit({
    type: "product.submitted",
    title: p.paymentMode === "cash" ? "Cash sale submitted" : "Step 4 submitted for approval",
    message:
      p.paymentMode === "cash"
        ? `${p.dealerName ?? "The dealer"} confirmed a cash sale for ${who}${at}.`
        : `${p.dealerName ?? "The dealer"} submitted product selection for ${who}${at}${
            financeBits ? ` — ${financeBits}` : ""
          }.`,
    leadId: p.leadId,
    stage: "Step 4 · Product Selection",
    from: p.dealerName ? dealerParty(p.dealerName) : await actingParty(),
    data: {
      product_selection_id: p.productSelectionId,
      payment_mode: p.paymentMode,
      final_price: p.finalPrice,
      nbfc_names: nbfcs,
      loan_product: p.loanProduct ?? null,
    },
    to: [
      toAdmins({ href: `/admin/product-review/${p.leadId}` }),
      toLeadNbfcs(p.leadId, {
        href: nbfcLead(p.leadId),
        title: "New application routed to you",
        message: `${who} selected your financing${p.loanProduct ? ` (${p.loanProduct})` : ""}.${
          p.finalPrice != null ? ` Value ₹${p.finalPrice}.` : ""
        }`,
      }),
    ],
  });
}

/** An NBFC submitted its firm financing offer. */
export async function notifyOfferSubmitted(p: {
  leadId: string;
  nbfcName: string;
  loanAmount?: number | string | null;
  emi?: number | string | null;
  tenureMonths?: number | null;
}) {
  const who = await leadLabel(p.leadId);
  const terms = [
    p.loanAmount ? `₹${p.loanAmount}` : null,
    p.emi ? `EMI ₹${p.emi}` : null,
    p.tenureMonths ? `${p.tenureMonths} months` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  await emit({
    type: "loan.offer_submitted",
    title: "NBFC submitted financing conditions",
    message: `${p.nbfcName} submitted an offer for ${who}${terms ? ` — ${terms}` : ""}.`,
    leadId: p.leadId,
    stage: "Step 4 · Offers",
    from: nbfcParty(p.nbfcName),
    data: { loan_amount: p.loanAmount ?? null, emi: p.emi ?? null, tenure_months: p.tenureMonths ?? null },
    to: [
      toAdmins({ href: adminLead(p.leadId, "#offers") }),
      // The offers card — and, since E-238, the Negotiate button — lives on
      // /product-selection. This used to point at /options, the legacy
      // loan_offers page, which landed the dealer somewhere the offer isn't.
      toLeadDealer(p.leadId, { href: dealerLead(p.leadId, "/product-selection") }),
    ],
  });
}

/**
 * E-238 / E-245 — the dealer asked an NBFC to revise its firm offer.
 *
 * The ask is free text (E-245 dropped the six editable term fields), so the
 * message IS the notification body — there is nothing else to summarise.
 *
 * Only the NBFC being negotiated with hears about it. The other lender on the
 * lead is a competitor mid-race, and telling it what the customer is asking for
 * would hand it the other side's position.
 */
export async function notifyOfferNegotiated(p: {
  leadId: string;
  nbfcTenantId: string;
  nbfcName: string;
  message: string;
}) {
  const who = await leadLabel(p.leadId);
  await emit({
    type: "loan.offer_negotiated",
    title: "Customer asked you to revise your offer",
    message: `${who} sent a negotiation request: "${p.message}"`,
    leadId: p.leadId,
    stage: "Step 4 · Offers",
    from: customerParty(who),
    data: { message: p.message },
    to: [
      toNbfc(p.nbfcTenantId, p.nbfcName, { href: nbfcLead(p.leadId, "#offer") }),
      toAdmins({
        href: adminLead(p.leadId, "#offers"),
        title: "Dealer sent a negotiation request",
        message: `${who} asked ${p.nbfcName} to revise its offer: "${p.message}"`,
      }),
    ],
  });
}

/**
 * E-245 — the dealer closed the deal with this lender.
 *
 * Terminal for this assignment: the offer goes 'withdrawn' and the dealer is
 * free to route the lead to a different lender. Scoped the same way as
 * notifyOfferNegotiated — the competing lender is not told that a rival just
 * lost the lead, because that is the rival's position, not news about this one.
 */
export async function notifyOfferClosed(p: {
  leadId: string;
  nbfcTenantId: string;
  nbfcName: string;
  message: string;
}) {
  const who = await leadLabel(p.leadId);
  await emit({
    type: "loan.offer_closed",
    title: "Customer closed the deal",
    message: `${who} closed the deal on your financing offer: "${p.message}"`,
    leadId: p.leadId,
    stage: "Step 4 · Offers",
    from: customerParty(who),
    data: { message: p.message },
    to: [
      toNbfc(p.nbfcTenantId, p.nbfcName, { href: nbfcLead(p.leadId, "#offer") }),
      toAdmins({
        href: adminLead(p.leadId, "#offers"),
        title: "Dealer closed a financing offer",
        message: `${who} closed the deal with ${p.nbfcName}: "${p.message}"`,
      }),
    ],
  });
}

/**
 * E-238 — the NBFC fixed its terms. Negotiation is over for both sides; the
 * dealer's remaining move is to select this lender or another one.
 */
export async function notifyOfferFixed(p: {
  leadId: string;
  nbfcName: string;
  loanAmount?: number | string | null;
  emi?: number | string | null;
  tenureMonths?: number | null;
}) {
  const who = await leadLabel(p.leadId);
  const terms = [
    p.loanAmount ? `₹${p.loanAmount}` : null,
    p.emi ? `EMI ₹${p.emi}` : null,
    p.tenureMonths ? `${p.tenureMonths} months` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  await emit({
    type: "loan.offer_fixed",
    title: "Financing terms are final",
    message: `${p.nbfcName} fixed its offer for ${who}${terms ? ` — ${terms}` : ""}. These terms can no longer be negotiated.`,
    leadId: p.leadId,
    stage: "Step 4 · Offers",
    from: nbfcParty(p.nbfcName),
    data: { loan_amount: p.loanAmount ?? null, emi: p.emi ?? null, tenure_months: p.tenureMonths ?? null },
    to: [
      toAdmins({ href: adminLead(p.leadId, "#offers") }),
      toLeadDealer(p.leadId, { href: dealerLead(p.leadId, "/product-selection") }),
    ],
  });
}

/**
 * E-245 — after closing a deal the dealer routed the lead to a DIFFERENT lender.
 *
 * Deliberately not notifyProductSubmitted: that fans out via toLeadNbfcs, which
 * would tell the lender the dealer just closed that a "new application" had been
 * routed to it. Only the newly picked lender and the admins hear about this.
 */
export async function notifyLeadRerouted(p: {
  leadId: string;
  nbfcTenantId: string;
  nbfcName: string;
  loanProduct?: string | null;
  dealerName?: string | null;
}) {
  const who = await leadLabel(p.leadId);
  const product = p.loanProduct ? ` (${p.loanProduct})` : "";
  await emit({
    type: "loan.lead_rerouted",
    title: "New application routed to you",
    message: `${who} selected your financing${product} after closing a deal with another lender.`,
    leadId: p.leadId,
    stage: "Step 4 · Offers",
    from: p.dealerName ? dealerParty(p.dealerName) : customerParty(who),
    data: { loan_product: p.loanProduct ?? null },
    to: [
      toNbfc(p.nbfcTenantId, p.nbfcName, { href: nbfcLead(p.leadId) }),
      toAdmins({
        href: adminLead(p.leadId, "#offers"),
        title: "Lead re-routed to another lender",
        message: `${p.dealerName ?? "The dealer"} routed ${who} to ${p.nbfcName}${product} after closing a deal.`,
      }),
    ],
  });
}

/** The customer picked a winning lender; the others lost. */
export async function notifyWinnerSelected(p: {
  leadId: string;
  winnerTenantId: string;
  winnerName: string;
}) {
  const who = await leadLabel(p.leadId);
  await emit({
    type: "loan.winner_selected",
    title: "Financing offer accepted",
    message: `${who} accepted ${p.winnerName}'s offer.`,
    leadId: p.leadId,
    stage: "Step 4 · Offers",
    from: customerParty(who),
    to: [
      toAdmins({ href: adminLead(p.leadId, "#offers") }),
      toNbfc(p.winnerTenantId, p.winnerName, {
        href: nbfcLead(p.leadId),
        title: "Your offer was accepted",
        message: `${who} accepted your financing offer. Proceed with verification and disbursal.`,
      }),
      toLeadDealer(p.leadId, { href: dealerLead(p.leadId, "/options") }),
      // Everyone else on this lead lost it — told separately, and last, so the
      // winner's copy is never overwritten by the loser's (emit de-dupes per
      // person in list order).
      toLeadNbfcs(p.leadId, {
        exceptTenantId: p.winnerTenantId,
        href: nbfcLead(p.leadId),
        title: "Application placed elsewhere",
        message: `${who} chose another lender. No further action is needed.`,
      }),
    ],
  });
}

/** The loan was sanctioned. */
export async function notifyLoanSanctionedEvent(p: {
  leadId: string;
  lenderName: string;
  tenantId?: string | null;
  loanAmount?: number | string | null;
}) {
  const who = await leadLabel(p.leadId);
  await emit({
    type: "loan.sanctioned",
    title: "Loan sanctioned",
    message: `${p.lenderName} sanctioned${p.loanAmount ? ` ₹${p.loanAmount}` : ""} for ${who}.`,
    leadId: p.leadId,
    stage: "Sanction",
    from: nbfcParty(p.lenderName),
    data: { lender_name: p.lenderName, loan_amount: p.loanAmount ?? null },
    to: [
      toAdmins({ href: adminLead(p.leadId, "#sanction") }),
      p.tenantId
        ? toNbfc(p.tenantId, p.lenderName, { href: nbfcLead(p.leadId) })
        : toLeadNbfcs(p.leadId, { href: nbfcLead(p.leadId) }),
    ],
  });
}

/** The loan was disbursed — the end of origination. */
export async function notifyLoanDisbursed(p: {
  leadId: string;
  lenderName?: string | null;
  tenantId?: string | null;
  loanAmount?: number | string | null;
}) {
  const who = await leadLabel(p.leadId);
  await emit({
    type: "loan.disbursed",
    title: "Loan disbursed",
    message: `${p.lenderName ?? "The lender"} disbursed${p.loanAmount ? ` ₹${p.loanAmount}` : ""} for ${who}.`,
    leadId: p.leadId,
    stage: "Disbursal",
    from: p.lenderName ? nbfcParty(p.lenderName) : await actingParty(),
    data: { lender_name: p.lenderName ?? null, loan_amount: p.loanAmount ?? null },
    to: [
      toAdmins({ href: adminLead(p.leadId, "#sanction") }),
      p.tenantId
        ? toNbfc(p.tenantId, p.lenderName ?? "NBFC partner", { href: nbfcLead(p.leadId) })
        : toLeadNbfcs(p.leadId, { href: nbfcLead(p.leadId) }),
      toLeadDealer(p.leadId, { href: dealerLead(p.leadId) }),
    ],
  });
}

/** Dispatch / delivery, mirrored to admin (the dealer copy comes from notifications.ts). */
export async function notifyFulfilmentToAdmin(p: {
  leadId: string;
  event: "dispatched" | "delivered" | "cash_sale";
  batterySerial?: string | null;
}) {
  const who = await leadLabel(p.leadId);
  const copy = {
    dispatched: { type: "product.dispatched", title: "Dispatch confirmed", verb: "dispatched" },
    delivered: { type: "product.delivered", title: "Delivery confirmed", verb: "delivered" },
    cash_sale: { type: "product.cash_sale", title: "Cash sale confirmed", verb: "sold (cash)" },
  }[p.event];

  await emit({
    type: copy.type,
    title: copy.title,
    message: `${who} — ${copy.verb}${p.batterySerial ? ` (${p.batterySerial})` : ""}.`,
    leadId: p.leadId,
    stage: "Step 5 · Fulfilment",
    from: await actingParty(),
    data: { battery_serial: p.batterySerial ?? null },
    to: [toAdmins({ href: adminLead(p.leadId), email: false })],
  });
}

/* ================================================================== *
 * VENDOR & NBFC OPS
 * ================================================================== */

/** A scrap vendor registered and needs approval. */
export async function notifyVendorRegistered(p: { vendorName: string; vendorId?: string | null }) {
  await emit({
    type: "vendor.registered",
    title: "New vendor registration",
    message: `${p.vendorName} registered as a scrap vendor and is awaiting approval.`,
    stage: "Vendor onboarding",
    from: { party: "vendor", label: p.vendorName },
    data: { vendor_id: p.vendorId ?? null, href: "/admin/buyback/vendors" },
    to: [toAdmins({ href: "/admin/buyback/vendors" })],
  });
}

/** A dual-approval request needs a second approver (the risk head). */
export async function notifyDualApprovalRequested(p: {
  tenantId: string;
  requestId: string;
  actionLabel: string;
  nbfcName?: string | null;
}) {
  const label = p.nbfcName ?? (await tenantDisplayName(p.tenantId));
  await emit({
    type: "nbfc.dual_approval",
    title: "Second approval needed",
    message: `${p.actionLabel} is waiting on a second approval.`,
    stage: "Dual approval",
    from: nbfcParty(label),
    data: { request_id: p.requestId, href: "/risk-head" },
    to: [
      { audience: { kind: "roles", roles: ["risk_head", "nbfc_risk_head"] }, as: nbfcParty(label), href: "/risk-head" },
      toNbfc(p.tenantId, label, { href: "/nbfc/risk", email: false }),
    ],
  });
}

/** An NBFC's prepaid wallet is running low. */
export async function notifyWalletLowBalance(p: {
  tenantId: string;
  balance: number | string;
  threshold: number | string;
}) {
  const label = await tenantDisplayName(p.tenantId);
  await emit({
    type: "nbfc.wallet_low",
    title: "Wallet balance low",
    message: `Your prepaid wallet is down to ₹${p.balance}, below the ₹${p.threshold} threshold. Top up to keep new disbursals flowing.`,
    stage: "Wallet",
    from: ADMIN_PARTY,
    data: { balance: p.balance, threshold: p.threshold },
    to: [
      toNbfc(p.tenantId, label, { href: "/nbfc/settings#wallet" }),
      toAdmins({
        href: `/admin/nbfc`,
        title: "NBFC wallet low",
        message: `${label}'s wallet is at ₹${p.balance}.`,
        email: false,
      }),
    ],
  });
}

/* ------------------------------------------------------------------ *
 * E-230 — the OEM price register
 * ------------------------------------------------------------------ */

/**
 * Admin and CEO only — NOT `toAdmins()`.
 *
 * The requirement names those two ("a notification should go to Admin and
 * CEO"), and ADMIN_AUDIENCE_ROLES is a superset that also carries business_head
 * and sales_head. Neither of them maintains the price book, and a recurring
 * nag about somebody else's screen is how an audience learns to ignore the
 * bell.
 */
const PRICE_KEEPERS: Recipient = {
  audience: { kind: "roles", roles: ["admin", "ceo"] },
  as: ADMIN_PARTY,
  href: "/oem-pricing",
};

/**
 * One or more reference prices are about to run out with nothing behind them.
 *
 * Batched into a single notification per sweep rather than one per model. The
 * OEM revises a whole price list at once, so "eleven prices lapse on 1 August"
 * is one piece of news and eleven rows would bury the bell on exactly the day
 * somebody needs to read it.
 */
export async function notifyOemPriceExpiring(p: {
  items: { product_name: string | null; model_id: string | null; valid_until: string }[];
}) {
  if (p.items.length === 0) return;

  const soonest = p.items.reduce((a, b) => (a.valid_until <= b.valid_until ? a : b));
  const when = new Date(soonest.valid_until).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const name = (i: { product_name: string | null; model_id: string | null }) =>
    i.product_name || i.model_id || "a model";

  const message =
    p.items.length === 1
      ? `The OEM price for ${name(p.items[0])} is valid only until ${when}. ` +
        `Add the next line before then, or every quotation for it starts coming ` +
        `to you for approval.`
      : `${p.items.length} OEM prices lapse from ${when}, starting with ` +
        `${name(soonest)}. Update the pricing register before then, or every ` +
        `quotation containing them starts coming to you for approval.`;

  await emit({
    type: "oem.price_expiring",
    title: "OEM prices about to lapse",
    message,
    stage: "OEM Pricing",
    from: ADMIN_PARTY,
    data: {
      count: p.items.length,
      earliest: soonest.valid_until,
      models: p.items.slice(0, 20).map(name),
    },
    to: [PRICE_KEEPERS],
  });
}

/**
 * Models with no reference price in force at all.
 *
 * `lapsed` is the count that had one and lost it — worth separating, because
 * "you never priced this" is a backlog item and "this stopped working on
 * Saturday" is a regression, and the second deserves the sharper sentence.
 */
export async function notifyOemPricesMissing(p: {
  total: number;
  lapsed: number;
  examples: string[];
}) {
  if (p.total === 0) return;

  const lead =
    p.lapsed > 0
      ? `${p.lapsed} of them had a price that has now run out.`
      : `None of them has ever been priced.`;
  const eg = p.examples.length ? ` e.g. ${p.examples.slice(0, 3).join(", ")}.` : "";

  await emit({
    type: "oem.price_missing",
    title: "Models with no OEM reference price",
    message:
      `${p.total} active model${p.total === 1 ? " has" : "s have"} no OEM reference ` +
      `price in force, so every quotation containing ${p.total === 1 ? "it" : "them"} ` +
      `goes to the approval queue. ${lead}${eg}`,
    stage: "OEM Pricing",
    from: ADMIN_PARTY,
    data: { total: p.total, lapsed: p.lapsed, examples: p.examples.slice(0, 20) },
    to: [PRICE_KEEPERS],
  });
}

/**
 * The E-246 SLA sweep acted on a KYC case that no admin had touched.
 *
 * Emitted on BOTH outcomes on purpose. `approved` is an FYI — the dealer has
 * already been told Step 4 is open by `applyKycFinalDecision`, and this is the
 * admin's record that it happened without them. `blocked` is the one that
 * matters: it means a card was already rejected, so the approve gate refused
 * and the case is now waiting on a human with nothing else to surface it.
 */
export async function notifyKycAutoApproved(p: {
  leadId: string;
  result: "approved" | "blocked";
  slaWindow: string;
  cardsAccepted?: number;
  blockers?: string[] | null;
}) {
  const who = await leadLabel(p.leadId);
  const approved = p.result === "approved";
  const message = approved
    ? `No admin action within the ${p.slaWindow} SLA, so the system accepted ${p.cardsAccepted ?? 0} pending card(s) and approved KYC for ${who}. Product Selection is now unlocked. The verification providers were not called.`
    : `The ${p.slaWindow} SLA elapsed for ${who}, but KYC could not be auto-approved: ${(p.blockers ?? []).join("; ") || "the approve gate refused"}. This case still needs you.`;

  await emit({
    type: "kyc.auto_approved",
    title: approved
      ? "KYC auto-approved by system"
      : "KYC auto-approval blocked — action needed",
    message,
    stage: "Step 3 · KYC",
    leadId: p.leadId,
    from: ADMIN_PARTY,
    data: {
      result: p.result,
      sla_window: p.slaWindow,
      cards_accepted: p.cardsAccepted ?? 0,
      blockers: p.blockers ?? null,
      providers_called: false,
    },
    to: [toAdmins({ href: adminLead(p.leadId) })],
  });
}

/**
 * E-257 — the NBFC request SLA sweep acted (or tried to) on a request no admin
 * had touched in time. Admin-facing FYI / call to action:
 *   - kind 'forwarded' ok  → the request went to the dealer without an admin click.
 *   - kind 'pushed'    ok  → the dealer's uploads went to the NBFC unreviewed.
 *   - ok=false             → the auto action threw; the request still needs a
 *                            human, and nothing else would surface that.
 */
export async function notifyNbfcRequestAutoRouted(p: {
  leadId: string;
  requestId: string;
  kind: "forwarded" | "pushed";
  ok: boolean;
  slaWindow: string;
  nbfcName?: string | null;
  docLabels?: string[];
  error?: string | null;
}) {
  const who = await leadLabel(p.leadId);
  const lender = p.nbfcName ? ` from ${p.nbfcName}` : "";
  const docs = (p.docLabels ?? []).filter(Boolean).join(", ");
  const forwarded = p.kind === "forwarded";

  const title = !p.ok
    ? forwarded
      ? "NBFC request auto-forward failed — action needed"
      : "NBFC request auto-push failed — action needed"
    : forwarded
      ? "NBFC request auto-forwarded to the dealer (SLA)"
      : "Dealer uploads auto-pushed to the NBFC (SLA)";

  const message = !p.ok
    ? `The ${p.slaWindow} SLA elapsed on the NBFC request${lender} for ${who}, but the system could not ${
        forwarded ? "forward it to the dealer" : "push the uploads to the NBFC"
      }: ${p.error || "unknown error"}. This request still needs you.`
    : forwarded
      ? `No admin action within the ${p.slaWindow} SLA, so the system forwarded the NBFC request${lender} for ${who} to the dealer${
          docs ? ` (${docs})` : ""
        }, relaying the NBFC's comments as the reason.`
      : `No admin review within the ${p.slaWindow} SLA, so the system marked the dealer's uploads${
          docs ? ` (${docs})` : ""
        } verified and pushed them to the NBFC${lender} for ${who}. Nobody at iTarang opened them.`;

  await emit({
    type: forwarded ? "nbfc.request_auto_forwarded" : "nbfc.request_auto_pushed",
    title,
    message,
    leadId: p.leadId,
    stage: "NBFC request",
    from: SYSTEM_PARTY,
    data: {
      requestId: p.requestId,
      kind: p.kind,
      ok: p.ok,
      sla_window: p.slaWindow,
      doc_labels: p.docLabels ?? [],
      error: p.error ?? null,
    },
    to: [toAdmins({ href: adminLead(p.leadId, "#nbfc-actions") })],
  });
}

/**
 * E-242 — a quotation cleared approval and its draft is ready to send.
 *
 * WHO IS TOLD, AND WHY BOTH
 *   - The LEAD OWNER (dealer_leads.current_owner_id). This is the person who
 *     raised the quote and the only one who can act on it. Until now they were
 *     told nothing at all: the decision route wrote a touchpoint and stopped, so
 *     a rep learned their quote had been approved by going and looking.
 *   - Everyone with role `sales_manager`, per the requirement ("whoever the
 *     sales manager is gets a notification that it's approved"). They oversee
 *     the deal but do not own the lead, so they get the leads list rather than
 *     the owner's lead page.
 *
 * Both land on a page that opens the draft, because the next step is a human
 * reading the document before it goes to a dealer — the notification is the
 * start of a review, not just an announcement.
 *
 * The auto/manual distinction is in the copy on purpose. "Approved by the
 * pricing rule" and "approved by the CEO" mean different things about how much
 * scrutiny the number has had, and the person about to send it to a dealer
 * should not have to go and find out which happened.
 */
/**
 * E-256 — a quote version landed `pending` and is waiting in the CEO queue.
 *
 * The queue (`PendingQuotationsPanel`) was pull-only: the OEM price gate parks
 * an out-of-band quote and nothing tells the CEO it exists, so a dealer waits
 * exactly as long as it takes someone to open the dashboard. This is the push
 * half — one notification to `ceo` (and `admin`, who can also decide), landing
 * on the CEO dashboard where the pending panel lives.
 *
 * The reason lines were flagged goes in the copy: the CEO's first question is
 * "why is this in front of me", and the answer is already computed
 * (`linesNeedingAttention`) at the moment the quote parks.
 */
export async function notifyQuotationPendingApproval(p: {
  leadId: string;
  commercialId: string;
  dealerName: string | null;
  value: number;
  /** e.g. "2 lines below OEM reference" — from the gate's evaluation. */
  reason?: string | null;
  raisedByName?: string | null;
}) {
  const dealer = p.dealerName?.trim() || "a dealer";
  const money = p.value > 0 ? ` for ₹${p.value.toLocaleString("en-IN")}` : "";
  const who = p.raisedByName?.trim() ? ` by ${p.raisedByName.trim()}` : "";
  const why = p.reason?.trim() ? ` Flagged: ${p.reason.trim()}.` : "";

  await emit({
    type: "quote.pending_approval",
    title: "Quotation awaiting your approval",
    message: `A quotation${money} was raised for ${dealer}${who} and is waiting in the approval queue.${why} The dealer sees nothing until it is approved.`,
    leadId: p.leadId,
    stage: "Quotation",
    from: ADMIN_PARTY,
    data: {
      commercialId: p.commercialId,
      value: p.value,
      reason: p.reason ?? null,
    },
    to: [
      {
        audience: { kind: "roles" as const, roles: ["ceo", "admin"] },
        as: ADMIN_PARTY,
        href: "/ceo",
      },
    ],
  });
}

export async function notifyQuotationApproved(p: {
  leadId: string;
  commercialId: string;
  ownerUserId: string | null;
  dealerName: string | null;
  quoteNumber: string | null;
  value: number;
  /** 'auto' when the OEM price rule released it, 'manual' when a human did. */
  mode: "auto" | "manual";
  approverName?: string | null;
  /** False when the PDF could not be produced — say so rather than imply a draft exists. */
  draftReady: boolean;
}) {
  const dealer = p.dealerName?.trim() || "a dealer";
  const money = p.value > 0 ? ` for ₹${p.value.toLocaleString("en-IN")}` : "";
  const ref = p.quoteNumber ? ` (${p.quoteNumber})` : "";

  const how =
    p.mode === "auto"
      ? "auto-approved — every line was at or above its OEM reference price"
      : `approved by ${p.approverName?.trim() || "the CEO"}`;

  const tail = p.draftReady
    ? "The quotation draft is ready to review and send to the dealer."
    : "The draft could not be generated — open the quote and retry before sending.";

  const message = `The quotation for ${dealer}${money}${ref} was ${how}. ${tail}`;

  await emit({
    type: "quote.approved",
    title: "Quotation approved",
    message,
    leadId: p.leadId,
    stage: "Quotation",
    from: ADMIN_PARTY,
    data: {
      commercialId: p.commercialId,
      quoteNumber: p.quoteNumber,
      value: p.value,
      mode: p.mode,
      draftReady: p.draftReady,
    },
    to: [
      // The owner may be unset on an orphaned lead; emit() skips an audience it
      // cannot resolve rather than failing the batch, but filtering here keeps
      // the intent explicit.
      ...(p.ownerUserId
        ? [
            {
              audience: { kind: "user" as const, userId: p.ownerUserId },
              as: ADMIN_PARTY,
              href: `/inside-sales/lead/${p.leadId}?quote=${p.commercialId}`,
            },
          ]
        : []),
      {
        audience: { kind: "roles" as const, roles: ["sales_manager"] },
        as: ADMIN_PARTY,
        href: `/leads?lead=${p.leadId}&quote=${p.commercialId}`,
      },
    ],
  });
}

/**
 * E-243 — the dealer answered a quotation.
 *
 * The other half of `quote.approved`. That one says we released a number; this
 * one says what came back, and it is the first time the CRM has been able to
 * say so at all — before E-243 the reply lived in a WhatsApp thread or an inbox
 * and the lead owner found out by asking.
 *
 * DECLINED IS A WARNING, APPROVED IS NOT. A decline is the one that needs
 * somebody to do something today: the deal is stalling and the reason, when the
 * dealer gave one, is the most useful thing on the notification. An approval is
 * good news that can wait for the next time the owner looks at the bell.
 * `catalog.ts` files the type as Warning for that reason, so the copy leads
 * with whichever it is.
 */
export async function notifyQuotationDealerDecision(p: {
  leadId: string;
  commercialId: string;
  ownerUserId: string | null;
  dealerName: string | null;
  quoteNumber: string | null;
  value: number;
  decision: "approved" | "declined";
  via: "link" | "whatsapp";
  note?: string | null;
}) {
  const dealer = p.dealerName?.trim() || "The dealer";
  const money = p.value > 0 ? ` (₹${p.value.toLocaleString("en-IN")})` : "";
  const ref = p.quoteNumber ? ` ${p.quoteNumber}` : "";
  const channel = p.via === "whatsapp" ? "over WhatsApp" : "using the approval link";

  const message =
    p.decision === "approved"
      ? `${dealer} APPROVED quotation${ref}${money} ${channel}. Take it forward in the CRM — ` +
        `nothing has been moved automatically.`
      : `${dealer} DECLINED quotation${ref}${money} ${channel}.` +
        (p.note ? ` They said: "${p.note}"` : "") +
        ` Follow up or raise a revision.`;

  await emit({
    type: "quote.dealer_decision",
    title:
      p.decision === "approved" ? "Dealer approved a quotation" : "Dealer declined a quotation",
    message,
    leadId: p.leadId,
    stage: "Quotation",
    from: ADMIN_PARTY,
    data: {
      commercialId: p.commercialId,
      quoteNumber: p.quoteNumber,
      decision: p.decision,
      via: p.via,
      value: p.value,
    },
    to: [
      ...(p.ownerUserId
        ? [
            {
              audience: { kind: "user" as const, userId: p.ownerUserId },
              as: ADMIN_PARTY,
              href: `/inside-sales/lead/${p.leadId}?quote=${p.commercialId}`,
            },
          ]
        : []),
      {
        audience: { kind: "roles" as const, roles: ["sales_manager"] },
        as: ADMIN_PARTY,
        href: `/leads?lead=${p.leadId}&quote=${p.commercialId}`,
      },
    ],
  });
}

/** Re-exported so routes need only one import. */
export { ADMIN_AUDIENCE_ROLES };
