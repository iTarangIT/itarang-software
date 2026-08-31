// E-276 FULL-FLOW test: fires all 8 NBFC event emails with REAL lead data.
//
//   node --import tsx --env-file=.env.local scripts/_verify-e276-full-flow.ts [LEAD-ID]
//
// Picks a real lead that is routed to an NBFC (or the LEAD-ID you pass),
// resolves its real dealer name, customer name and uploaded file names, then
// sends one email per event — built with exactly the same fields as the live
// call sites — through the real helper + mailer.
//
// SAFE: business data is never modified. The only write is pointing the target
// tenant's notification_email at the test inbox for the duration of the run
// (restored in a finally), so no real NBFC receives test mail.

import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  leads,
  loanSanctions,
  nbfc,
  nbfcDocRequests,
  nbfcLeadAssignments,
  nbfcNotificationChannels,
  productSelections,
} from "@/lib/db/schema";
import { dealerDisplayName } from "@/lib/notifications/emit";
import { sendNbfcEventEmail } from "@/lib/nbfc/event-mailer";

const TEST_INBOX = process.env.NBFC_GLOBAL_NOTIFY_EMAIL?.trim();

async function main() {
  console.log("DB HOST:", new URL(process.env.DATABASE_URL!).hostname);
  console.log("GLOBAL :", TEST_INBOX ?? "(unset!)");
  if (!TEST_INBOX) throw new Error("NBFC_GLOBAL_NOTIFY_EMAIL is not set");

  // ---- pick a real routed lead -------------------------------------------
  const leadIdArg = process.argv[2];
  const assignmentQuery = db
    .select({
      lead_id: nbfcLeadAssignments.lead_id,
      tenant_id: nbfcLeadAssignments.tenant_id,
      nbfc_id: nbfcLeadAssignments.nbfc_id,
      assignment_status: nbfcLeadAssignments.status,
    })
    .from(nbfcLeadAssignments)
    .orderBy(desc(nbfcLeadAssignments.created_at));
  const assignments = leadIdArg
    ? await assignmentQuery.where(eq(nbfcLeadAssignments.lead_id, leadIdArg))
    : await assignmentQuery.limit(25);
  const pick = assignments.find((a) => a.tenant_id) ?? assignments[0];
  if (!pick) throw new Error("no nbfc_lead_assignments rows found — route a lead to an NBFC first");
  const leadId = pick.lead_id;

  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) throw new Error(`lead ${leadId} not found`);
  const [lender] = await db
    .select({ legal_name: nbfc.legal_name, short_name: nbfc.short_name })
    .from(nbfc)
    .where(eq(nbfc.id, pick.nbfc_id))
    .limit(1);
  const [selection] = await db
    .select({
      pre_sanction_doc_urls: productSelections.pre_sanction_doc_urls,
      battery_serial: productSelections.battery_serial,
    })
    .from(productSelections)
    .where(eq(productSelections.lead_id, leadId))
    .orderBy(desc(productSelections.created_at))
    .limit(1);
  const [docReq] = await db
    .select({ requested_items: nbfcDocRequests.requested_items, request_type: nbfcDocRequests.request_type })
    .from(nbfcDocRequests)
    .where(eq(nbfcDocRequests.lead_id, leadId))
    .orderBy(desc(nbfcDocRequests.created_at))
    .limit(1);
  const [loan] = await db
    .select({ loan_amount: loanSanctions.loan_amount, emi: loanSanctions.emi, loan_approved_by: loanSanctions.loan_approved_by })
    .from(loanSanctions)
    .where(eq(loanSanctions.lead_id, leadId))
    .orderBy(desc(loanSanctions.created_at))
    .limit(1);

  const customerName = lead.full_name ?? lead.owner_name ?? "the customer";
  const dealerName = await dealerDisplayName(lead.dealer_id);
  const lenderName = lender?.legal_name || lender?.short_name || "NBFC";
  const bucket = Array.isArray(selection?.pre_sanction_doc_urls)
    ? (selection!.pre_sanction_doc_urls as Array<{ name?: string }>).map((f) => f?.name).filter(Boolean)
    : [];
  const files = bucket.length ? (bucket as string[]) : ["aadhaar_front.jpg", "pan_card.pdf", "bank_statement.pdf"];
  const reqItems = Array.isArray(docReq?.requested_items)
    ? (docReq!.requested_items as Array<{ doc_label?: string; reason?: string }>)
        .map((it) => (it.reason ? `${it.doc_label} — ${it.reason}` : it.doc_label))
        .filter(Boolean)
    : ["Salary slip (last 3 months)", "Address proof — current address unclear"];

  console.log(`\nReal lead     : ${leadId}`);
  console.log(`Customer      : ${customerName}`);
  console.log(`Dealer        : ${dealerName}`);
  console.log(`NBFC / tenant : ${lenderName} (${pick.tenant_id ?? "NO TENANT"})`);
  console.log(`Bucket files  : ${bucket.length ? bucket.join(", ") : "(none — using sample names)"}`);
  console.log(`Loan sanction : ${loan ? `₹${loan.loan_amount} EMI ₹${loan.emi}` : "(none — using sample figures)"}`);

  const tenantId = pick.tenant_id;
  if (!tenantId) throw new Error("picked assignment has no tenant_id");

  // ---- override recipient, restore after ---------------------------------
  const [existingRow] = await db
    .select()
    .from(nbfcNotificationChannels)
    .where(eq(nbfcNotificationChannels.tenant_id, tenantId))
    .limit(1);
  const previous = existingRow?.notification_email ?? null;
  if (existingRow) {
    await db
      .update(nbfcNotificationChannels)
      .set({ notification_email: TEST_INBOX, updated_at: new Date() })
      .where(eq(nbfcNotificationChannels.tenant_id, tenantId));
  } else {
    await db.insert(nbfcNotificationChannels).values({ tenant_id: tenantId, notification_email: TEST_INBOX });
  }
  console.log(`\nRecipient override: ${TEST_INBOX} (was ${previous ?? "null"})\n`);

  const send = async (n: number, label: string, input: Parameters<typeof sendNbfcEventEmail>[0]) => {
    await sendNbfcEventEmail({ ...input, subject: `[TEST ${n}/8] ${input.subject}` });
    console.log(`  ${n}/8 sent — ${label}`);
  };

  try {
    // 1 — Step 4 "Send to NBFC" (mirrors submit-step4.ts)
    await send(1, "file routed to NBFC", {
      tenantId,
      leadId,
      subject: `iTarang — New loan file routed to you (Lead ${leadId})`,
      eventLabel: `Dealer ${dealerName} has sent a new customer loan file to your NBFC account.`,
      customerName,
      dealerName,
      extraRows: [
        ["Loan product", "EV Battery Loan"],
        ["Requested loan amount", lead.requested_loan_amount ? `₹${lead.requested_loan_amount}` : "₹45,000"],
      ],
      bodyHtml: `<p>Update: the file is now in your <b>Acquire queue</b> awaiting your review — verify the customer's KYC documents and submit your financing offer from the NBFC dashboard.</p>`,
    });

    // 2 — dealer uploads pre-sanction docs (mirrors pre-sanction-doc PATCH)
    await send(2, "pre-sanction docs uploaded", {
      tenantId,
      leadId,
      subject: `iTarang — Dealer uploaded ${files.length} pre-sanction document${files.length === 1 ? "" : "s"} (Lead ${leadId})`,
      eventLabel: `Dealer ${dealerName} has uploaded pre-sanction documents on Lead ${leadId}.`,
      customerName,
      dealerName,
      files,
      bodyHtml: `<p>Update: the files are now visible in your NBFC dashboard under the lead's <b>Documents</b> tab (Step 4 · Pre-sanction documents).</p>`,
    });

    // 3 — NBFC raises a correction request (mirrors doc-requests POST)
    await send(3, "correction request raised", {
      tenantId,
      leadId,
      subject: `iTarang — Correction request raised for Lead ${leadId}`,
      eventLabel: `Your correction request for Lead ${leadId} has been raised and routed to the iTarang admin.`,
      customerName,
      dealerName,
      files: reqItems as string[],
      extraRows: [["Request type", "Correction request"]],
      bodyHtml: `<p>Update: the admin will either fulfil the request himself or forward it to the dealer; you will be emailed again when the documents are pushed back to your dashboard.</p>`,
    });

    // 4 — dealer replies with docs (mirrors reply route)
    await send(4, "dealer replied to request", {
      tenantId,
      leadId,
      subject: `iTarang — Dealer replied to your document request (Lead ${leadId})`,
      eventLabel: `Dealer ${dealerName} has replied to your document request for Lead ${leadId} and uploaded ${files.length} file${files.length === 1 ? "" : "s"}.`,
      customerName,
      dealerName,
      files,
      extraRows: [["Message", "Requested corrections attached."]],
      bodyHtml: `<p>Update: the reply is with the iTarang admin for verification; the verified documents will be pushed to your dashboard next.</p>`,
    });

    // 5 — admin pushes verified docs (mirrors push route)
    await send(5, "admin pushed docs to NBFC", {
      tenantId,
      leadId,
      subject: `iTarang — Requested documents delivered to your dashboard (Lead ${leadId})`,
      eventLabel: `The iTarang admin has completed your document request for Lead ${leadId} and pushed the verified documents to your NBFC dashboard.`,
      customerName,
      dealerName,
      files,
      bodyHtml: `<p>Update: open the lead's <b>Documents</b> tab in your NBFC dashboard to review the delivered files.</p>`,
    });

    // 6 — NBFC rejects (mirrors reject route)
    await send(6, "NBFC rejected application", {
      tenantId,
      leadId,
      subject: `iTarang — Application rejected by ${lenderName} (Lead ${leadId})`,
      eventLabel: `${lenderName} has rejected the loan application for Lead ${leadId}.`,
      customerName,
      dealerName,
      extraRows: [
        ["Rejected by", lenderName],
        ["Rejection reason", "TEST — income documents insufficient"],
      ],
      bodyHtml: `<p>Update: the rejection is recorded and now sits with the iTarang admin, who will forward the decision to the dealer (the dealer may then re-route the file to another lender).</p>`,
    });

    // 7 — offer accepted (mirrors select-winner.ts)
    await send(7, "offer accepted", {
      tenantId,
      leadId,
      subject: `iTarang — Your offer was accepted (Lead ${leadId})`,
      eventLabel: `Customer ${customerName} has accepted the financing offer from ${lenderName} on Lead ${leadId}.`,
      customerName,
      dealerName,
      extraRows: [["Selected lender", lenderName]],
      bodyHtml: `<p>Update: the lead has moved to <b>awaiting E-NACH</b>. Please proceed with the next steps (E-NACH mandate, agreement, sanction) in your NBFC dashboard.</p>`,
    });

    // 8 — disbursed (mirrors confirm-dispatch.ts)
    await send(8, "loan disbursed", {
      tenantId,
      leadId,
      subject: `iTarang — Loan disbursed, battery dispatched (Lead ${leadId})`,
      eventLabel: `The loan for Lead ${leadId} is now disbursed — the battery has been dispatched to the customer and the loan is live in your portfolio.`,
      customerName,
      dealerName,
      extraRows: [
        ["Lender", loan?.loan_approved_by ?? lenderName],
        ["Loan amount", loan?.loan_amount ? `₹${loan.loan_amount}` : "₹45,000"],
        ["EMI", loan?.emi ? `₹${loan.emi}` : "₹4,100"],
        ["Battery serial", selection?.battery_serial ?? "BAT-TEST-0001"],
      ],
      bodyHtml: `<p>Update: the loan now appears in your NBFC dashboard's Portfolio Overview with its EMI schedule.</p>`,
    });
  } finally {
    await db
      .update(nbfcNotificationChannels)
      .set({ notification_email: previous, updated_at: new Date() })
      .where(eq(nbfcNotificationChannels.tenant_id, tenantId));
    console.log(`\nRecipient restored to: ${previous ?? "null"}`);
  }

  console.log(`\nDone. Check ${TEST_INBOX} — 8 mails, subjects "[TEST 1/8] … [TEST 8/8]".`);
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
