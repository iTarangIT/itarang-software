/**
 * One-off end-to-end test of the 23 Nov 2026 Battery Pool changes on the
 * SANDBOX database (database-1) only. Creates two throwaway test leads under
 * the sandbox NBFC "Electro F", runs the real library functions and route
 * handlers, checks the rows they write, then deletes everything it created
 * (and restores the NBFC wallet balance).
 *
 *   AGENTMAIL_API_KEY= SMTP_HOST= WA_DRY_RUN=1 NBFC_TEST_BYPASS_SECRET=t3st \
 *     node --import tsx --env-file=.env.local scripts/_test-battery-pool-23nov.ts
 *
 * Email is disabled (no transport → the best-effort sends just log), WhatsApp
 * runs on the dry-run adapter, so nobody is messaged.
 */
import crypto from "crypto";
import { NextRequest } from "next/server";
import { and, eq, gte, inArray, like, sql } from "drizzle-orm";

const TENANT = "b02c0ab4-3618-4281-b893-fc69e6799d25";
const NBFC_ID = 102;
const CHILD = "13e80816-df13-4ed8-8ab8-dc4a036cc2c9";
const PARENT = "3b81862f-5734-4f2e-8197-851e923dd9cf";
const BASE_LEAD = "LEAD-20261119-1bd28304";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, info?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && info !== undefined ? `  → ${JSON.stringify(info)}` : ""}`);
}

const PDF = Buffer.from(
  "%PDF-1.4\n" + "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj " +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" + "x".repeat(700) + "\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

function bypass(role: string): Headers {
  return new Headers({
    "x-nbfc-test-bypass": process.env.NBFC_TEST_BYPASS_SECRET ?? "",
    "x-nbfc-test-tenant-id": TENANT,
    "x-nbfc-test-user-id": PARENT,
    "x-nbfc-test-user-role": role,
  });
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!new URL(url).host.startsWith("database-1.")) throw new Error("refusing: not the sandbox database");
  if (process.env.WA_DRY_RUN !== "1") throw new Error("set WA_DRY_RUN=1");

  const { db } = await import("@/lib/db");
  const S = await import("@/lib/db/schema");
  const started = new Date();
  const leadIds: string[] = [];
  const createdLeadIds: string[] = [];
  let walletBefore: string | null = null;
  let agreementMethodBefore: string | null | undefined = undefined;
  const ledgerIds: string[] = [];

  async function makeLead(tag: string) {
    const [base] = await db.select().from(S.leads).where(eq(S.leads.id, BASE_LEAD)).limit(1);
    if (!base) throw new Error("base lead missing");
    const id = `LEAD-T23NOV-${tag}-${crypto.randomBytes(3).toString("hex")}`;
    await db.insert(S.leads).values({
      ...base,
      id,
      reference_id: `T23NOV-${tag}`,
      full_name: `Test BP ${tag}`,
      kyc_status: "step_3_cleared",
      payment_method: "finance",
      city: "Pune",
      requested_loan_amount: 60000,
      recalled_at: null,
      resubmitted_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    leadIds.push(id);
    const [a] = await db
      .insert(S.nbfcLeadAssignments)
      .values({ lead_id: id, nbfc_id: NBFC_ID, tenant_id: TENANT, status: "pending", assigned_at: new Date() })
      .returning({ id: S.nbfcLeadAssignments.id });
    // one KYC document, so the new-case copy has something to carry
    await db.insert(S.kycDocuments).values({
      id: `KYCDOC-T-${crypto.randomUUID()}`,
      lead_id: id,
      doc_type: "pan_card",
      file_url: "/files/test/pan.pdf",
      doc_status: "uploaded",
      verification_status: "verified",
    });
    return { id, assignmentId: a.id };
  }

  try {
    const [w] = await db.select({ b: S.nbfcWallets.balance }).from(S.nbfcWallets).where(eq(S.nbfcWallets.tenant_id, TENANT)).limit(1);
    walletBefore = w?.b ?? null;

    // ── Task 1 — child notified when a file is assigned; WhatsApp on notices ──
    const L1 = await makeLead("A");
    const cibil = await import("@/lib/nbfc/cibil-review");
    await cibil.notifyCibilVerifiersOfAssignment(L1.id);
    await cibil.notifyCibilVerifiersOfAssignment(L1.id); // second call must not repeat
    const notices = await db
      .select({ id: S.nbfcAuditLog.id })
      .from(S.nbfcAuditLog)
      .where(and(eq(S.nbfcAuditLog.action_type, "cibil_file_assigned_notice"), eq(S.nbfcAuditLog.action_id, L1.assignmentId)));
    check("T1 assignment notice recorded once (dedupe)", notices.length === 1, notices.length);
    await new Promise((r) => setTimeout(r, 1500));
    const bells = await db
      .select({ id: S.notifications.id })
      .from(S.notifications)
      .where(and(eq(S.notifications.lead_id, L1.id), eq(S.notifications.type, "nbfc.cibil_file_assigned"), eq(S.notifications.user_id, CHILD)));
    check("T1 child got the 'new file for CIBIL review' bell", bells.length >= 1, bells.length);

    // child uploads → parent notified (bell + email + WhatsApp)
    const child = { tenant_id: TENANT, user_id: CHILD, role: "credit_underwriting" };
    const sub = await cibil.submitCibilReview({ actor: child, leadId: L1.id, file: { buf: PDF, name: "cibil.pdf" }, note: "Score fine", score: 742 });
    check("T1 child CIBIL submit → pending for parent", sub.status === "pending", sub);
    await new Promise((r) => setTimeout(r, 1500));
    const parentBell = await db
      .select({ id: S.notifications.id })
      .from(S.notifications)
      .where(and(eq(S.notifications.lead_id, L1.id), eq(S.notifications.type, "nbfc.cibil_submitted"), eq(S.notifications.user_id, PARENT)));
    check("T1 parent got 'CIBIL report waiting for your approval' bell", parentBell.length >= 1, parentBell.length);

    // ── Task 3 — approve with conditions: multi-select documents ──
    const [pRole] = await db.select({ role: S.nbfcUsers.role }).from(S.nbfcUsers).where(and(eq(S.nbfcUsers.user_id, PARENT), eq(S.nbfcUsers.tenant_id, TENANT))).limit(1);
    const parent = { tenant_id: TENANT, user_id: PARENT, role: pRole?.role ?? "nbfc_admin" };
    await cibil.decideCibilReview({
      actor: parent,
      leadId: L1.id,
      decision: "approve_with_conditions",
      reason: null,
      conditions: "Max tenure 12 months",
      conditionDocs: ["cb_pan", "rc_copy", "not_a_doc"],
    });
    const [rev] = await db.select().from(S.nbfcCibilReviews).where(eq(S.nbfcCibilReviews.id, sub.id)).limit(1);
    check("T3 review approved", rev?.status === "approved", rev?.status);
    check("T3 condition_docs stored (known keys only, ordered)", JSON.stringify(rev?.condition_docs) === JSON.stringify(["rc_copy", "cb_pan"]), rev?.condition_docs);
    check(
      "T3 conditions text names the documents + note",
      rev?.conditions === "Documents required: RC Copy, Co-borrower PAN Card. Max tenure 12 months",
      rev?.conditions,
    );
    const reqs = await db.select().from(S.nbfcDocRequests).where(eq(S.nbfcDocRequests.cibil_review_id, sub.id));
    check("T3 two document requests raised (customer + co-borrower)", reqs.length === 2 && new Set(reqs.map((r) => r.doc_for)).size === 2, reqs.map((r) => r.doc_for));
    await new Promise((r) => setTimeout(r, 1500));
    const credit = await db.select({ id: S.notifications.id }).from(S.notifications).where(and(eq(S.notifications.lead_id, L1.id), eq(S.notifications.type, "nbfc.credit_approved")));
    check("T10 'credit check approved' milestone sent to iTarang/dealer", credit.length >= 1, credit.length);

    // ── Task 2 — documents in batches ──
    const dr = await import("@/lib/nbfc/doc-requests");
    const first = reqs.find((r) => r.doc_for === "primary")!;
    const att = { url: "/files/test/rc-part1.pdf", name: "rc-part1.pdf", type: "application/pdf", size: 1000 };
    const part = await dr.fulfilNbfcDocRequestByAdmin({ requestId: first.id, adminUserId: PARENT, message: "First part", attachments: [att], keepOpen: true });
    const [afterPart] = await db.select().from(S.nbfcDocRequests).where(eq(S.nbfcDocRequests.id, first.id)).limit(1);
    check("T2 part sent: request stays open", part.keptOpen && afterPart.status === first.status, afterPart.status);
    check("T2 part sent: attachment added", (afterPart.attachments as unknown[]).length === 1);
    await dr.fulfilNbfcDocRequestByAdmin({ requestId: first.id, adminUserId: PARENT, message: "Rest", attachments: [{ ...att, name: "rc-part2.pdf" }] });
    const [afterAll] = await db.select().from(S.nbfcDocRequests).where(eq(S.nbfcDocRequests.id, first.id)).limit(1);
    check("T2 final batch: pushed to NBFC with both files", afterAll.status === "pushed_to_nbfc" && (afterAll.attachments as unknown[]).length === 2, afterAll.status);
    const more = await dr.fulfilNbfcDocRequestByAdmin({ requestId: first.id, adminUserId: PARENT, message: "One more", attachments: [{ ...att, name: "rc-part3.pdf" }], keepOpen: true });
    check("T2 another batch after the push is accepted", more.keptOpen === true);

    // ── Tasks 4 + 5 — signed agreement upload; Sanction then Disburse ──
    await db
      .update(S.nbfcLeadAssignments)
      .set({ status: "selected", service_config_snapshot: { track_completion_gate: false } })
      .where(eq(S.nbfcLeadAssignments.id, L1.assignmentId));
    await db.insert(S.enachMandates).values({ lead_id: L1.id, nbfc_id: NBFC_ID, tenant_id: TENANT, enach_ref: `T-${Date.now()}`, status: "skipped" });

    // T4 needs the agreement rail on; switch it on for this run, restored in finally.
    const [cfg] = await db.select({ m: S.nbfcServiceConfig.doc_agreement_method }).from(S.nbfcServiceConfig).where(eq(S.nbfcServiceConfig.tenant_id, TENANT)).limit(1);
    agreementMethodBefore = cfg ? cfg.m : undefined;
    if (cfg && !cfg.m) await db.update(S.nbfcServiceConfig).set({ doc_agreement_method: "upload" }).where(eq(S.nbfcServiceConfig.tenant_id, TENANT));
    const up = await import("@/app/api/nbfc/agreement/[leadId]/upload/route");
    const fd = new FormData();
    fd.append("file", new File([PDF], "signed.pdf", { type: "application/pdf" }));
    fd.append("signed", "1");
    const upRes = await up.POST(new NextRequest("http://x/api", { method: "POST", body: fd, headers: bypass("operations") }), {
      params: Promise.resolve({ leadId: L1.id }),
    });
    const upJson = await upRes.json();
    const optIn = await (await import("@/lib/nbfc/service-opt-in")).resolveServiceOptIn(TENANT, { track_completion_gate: false });
    if (optIn.doc_agreement_method) {
      check("T4 signed agreement upload accepted", upRes.status === 200 && upJson.signed === true, upJson);
      const [ag] = await db.select().from(S.nbfcLoanAgreements).where(eq(S.nbfcLoanAgreements.lead_id, L1.id)).limit(1);
      check("T4 agreement row is 'signed' via upload, no e-sign", ag?.status === "signed" && ag?.method === "upload" && !ag?.digio_document_id, ag?.status);
      const pdfRoute = await import("@/app/api/nbfc/agreement/[leadId]/signed-pdf/route");
      const pdfRes = await pdfRoute.GET(new NextRequest("http://x/api", { headers: bypass("operations") }), { params: Promise.resolve({ leadId: L1.id }) });
      check("T4 signed PDF downloads", pdfRes.status === 200 && (pdfRes.headers.get("content-type") ?? "").includes("pdf"), pdfRes.status);
    } else {
      console.log("SKIP  T4 — agreement rail is switched off for this sandbox NBFC (Settings → Document Handling)");
    }

    const sanctionRoute = await import("@/app/api/nbfc/sanction/[leadId]/route");
    const ctx = { params: Promise.resolve({ leadId: L1.id }) };
    let g = await (await sanctionRoute.GET(new NextRequest("http://x/api", { headers: bypass("nbfc_admin") }), ctx)).json();
    check("T5 before: can sanction, cannot disburse", g.can_sanction === true && g.can_disburse === false, g);
    const s1 = await sanctionRoute.POST(new NextRequest("http://x/api", { method: "POST", headers: bypass("nbfc_admin"), body: "{}" }), { params: Promise.resolve({ leadId: L1.id }) });
    const s1j = await s1.json();
    check("T5 Sanction ok", s1.status === 200 && s1j.ok && s1j.lead_status === "loan_sanctioned", s1j);
    const [ls1] = await db.select().from(S.loanSanctions).where(eq(S.loanSanctions.lead_id, L1.id)).limit(1);
    check("T5 sanction row 'sanctioned', NOT disbursed", ls1?.status === "sanctioned" && ls1?.disbursed_at == null, { s: ls1?.status, d: ls1?.disbursed_at });
    g = await (await sanctionRoute.GET(new NextRequest("http://x/api", { headers: bypass("nbfc_admin") }), { params: Promise.resolve({ leadId: L1.id }) })).json();
    check("T5 after sanction: can disburse", g.can_disburse === true && g.already_disbursed === false, g);
    const d1 = await sanctionRoute.POST(
      new NextRequest("http://x/api", { method: "POST", headers: bypass("nbfc_admin"), body: JSON.stringify({ action: "disburse", amount: 55000, reference: "UTR-T23" }) }),
      { params: Promise.resolve({ leadId: L1.id }) },
    );
    const d1j = await d1.json();
    ledgerIds.push(...((d1j.charged_ledger_ids as string[]) ?? []));
    const [ls2] = await db.select().from(S.loanSanctions).where(eq(S.loanSanctions.lead_id, L1.id)).limit(1);
    check("T5 Disburse ok → 'disbursed' with amount + date", d1j.ok && ls2?.status === "disbursed" && !!ls2?.disbursed_at && Number(ls2?.disbursement_amount) === 55000, { s: ls2?.status, a: ls2?.disbursement_amount });
    const d2j = await (
      await sanctionRoute.POST(new NextRequest("http://x/api", { method: "POST", headers: bypass("nbfc_admin"), body: JSON.stringify({ action: "disburse" }) }), {
        params: Promise.resolve({ leadId: L1.id }),
      })
    ).json();
    check("T5 second Disburse is a no-op", d2j.already === true, d2j);
    await new Promise((r) => setTimeout(r, 1500));
    const disb = await db.select({ id: S.notifications.id }).from(S.notifications).where(and(eq(S.notifications.lead_id, L1.id), eq(S.notifications.type, "loan.disbursed")));
    check("T5/T10 'loan disbursed' notice sent", disb.length >= 1, disb.length);

    // ── Tasks 8 + 9 — resume a rejected file ──
    const L2 = await makeLead("B");
    const { rejectNbfcFile } = await import("@/lib/nbfc/reject-file");
    await rejectNbfcFile({ actor: parent, leadId: L2.id, note: "Bank statement unreadable" });
    const R = await import("@/lib/leads/resume-rejected");
    let v = await R.getResumeView(L2.id);
    check("T8 rejected file can be resumed", v?.can_resume === true && v.rejections.length === 1, v);
    const admin = { id: PARENT, name: "Test Admin", role: "admin" };
    await R.resumeRejectedLead({ leadId: L2.id, mode: "same_nbfc", note: "New bank statement uploaded", actor: admin });
    const [a2] = await db.select().from(S.nbfcLeadAssignments).where(eq(S.nbfcLeadAssignments.lead_id, L2.id)).limit(1);
    check("T8 same NBFC: assignment back to pending", a2.status === "pending" && a2.rejection_note == null, a2.status);
    const { getLatestCibilReview } = await import("@/lib/nbfc/approval-hierarchy");
    check("T8 same NBFC: a fresh CIBIL round (old review not blocking)", (await getLatestCibilReview(TENANT, L2.id)) === null);

    await rejectNbfcFile({ actor: parent, leadId: L2.id, note: "Still not fine" });
    const { searchActiveDealers } = await import("@/lib/leads/dealerByMobile");
    const others: Array<{ dealerId: string; financeEnabled: boolean }> = [];
    for (const q of ["a", "e", "i", "o", "s", "t"]) others.push(...(await searchActiveDealers(q, 10, { financeOnly: true })));
    const [lead2] = await db.select({ dealer_id: S.leads.dealer_id }).from(S.leads).where(eq(S.leads.id, L2.id)).limit(1);
    const target = others.find((d) => d.dealerId !== lead2.dealer_id);
    if (target) {
      const r = await R.resumeRejectedLead({ leadId: L2.id, mode: "new_dealer", note: "Customer moved to another dealer", actor: admin, newDealerId: target.dealerId });
      createdLeadIds.push(r.leadId);
      const [nl] = await db.select().from(S.leads).where(eq(S.leads.id, r.leadId)).limit(1);
      check("T9 new case created for the other dealer", !!nl && nl.dealer_id === target.dealerId && nl.id !== L2.id, nl?.dealer_id);
      const docs = await db.select({ id: S.kycDocuments.id, v: S.kycDocuments.verification_status }).from(S.kycDocuments).where(eq(S.kycDocuments.lead_id, r.leadId));
      check("T9 KYC documents copied for re-verification", docs.length >= 1 && docs.every((d) => d.v === "pending"), docs);
      const [old] = await db.select({ dealer_id: S.leads.dealer_id }).from(S.leads).where(eq(S.leads.id, L2.id)).limit(1);
      check("T9 old rejected case kept as it was", old.dealer_id === lead2.dealer_id);
      v = await R.getResumeView(L2.id);
      check("T9 old case shows the history and cannot be resumed again", v?.can_resume === false && v.moved_to_lead_id === r.leadId && v.history.length === 2, v?.history.length);
      const v2 = await R.getResumeView(r.leadId);
      check("T9 new case links back to the rejected one", v2?.history.some((h) => h.old_lead_id === L2.id) === true);
    } else {
      // Sandbox has no approved, open dealer besides the house: test the two halves.
      const [closed] = await db
        .select({ code: S.dealers.dealer_id })
        .from(S.dealers)
        .innerJoin(S.accounts, eq(S.accounts.id, S.dealers.dealer_id))
        .where(sql`${S.dealers.dealer_id} <> ${lead2.dealer_id ?? ""}`)
        .limit(1);
      let refused = "";
      try {
        await R.resumeRejectedLead({ leadId: L2.id, mode: "new_dealer", note: "x", actor: admin, newDealerId: closed?.code ?? "NOPE" });
      } catch (e) {
        refused = e instanceof Error ? e.message : String(e);
        const c = (e as { cause?: { message?: string; detail?: string; constraint_name?: string } }).cause;
        if (c) console.log("CAUSE", c.message, c.detail ?? "", c.constraint_name ?? "");
      }
      check("T9 a dealer that is not approved / open is refused", /not found|closed|not enabled/i.test(refused), refused);
      const newId = await R.copyLeadForDealer({ oldLeadId: L2.id, dealerCode: closed?.code ?? "X", actor: admin, now: new Date() });
      createdLeadIds.push(newId);
      const [nl] = await db.select().from(S.leads).where(eq(S.leads.id, newId)).limit(1);
      check("T9 new case: own lead id, new dealer, customer details copied, KYC restarts",
        nl?.id !== L2.id && nl?.dealer_id === closed?.code && nl?.full_name === "Test BP B" && nl?.kyc_status === "pending" && nl?.requested_loan_amount === 60000,
        { d: nl?.dealer_id, k: nl?.kyc_status });
      const docs = await db.select({ v: S.kycDocuments.verification_status }).from(S.kycDocuments).where(eq(S.kycDocuments.lead_id, newId));
      check("T9 KYC documents copied for re-verification", docs.length === 1 && docs[0].v === "pending", docs);
      const asgNew = await db.select({ id: S.nbfcLeadAssignments.id }).from(S.nbfcLeadAssignments).where(eq(S.nbfcLeadAssignments.lead_id, newId));
      check("T9 new case starts with no lender history", asgNew.length === 0);
      const [old] = await db.select({ dealer_id: S.leads.dealer_id }).from(S.leads).where(eq(S.leads.id, L2.id)).limit(1);
      const [oldA] = await db.select({ s: S.nbfcLeadAssignments.status }).from(S.nbfcLeadAssignments).where(eq(S.nbfcLeadAssignments.lead_id, L2.id)).limit(1);
      check("T9 old rejected case untouched (dealer + declined)", old.dealer_id === lead2.dealer_id && oldA.s === "declined");
    }

    // ── Task 6 — scheme pick beats the routing rules ──
    const SP = await import("@/lib/leads/scheme-pick");
    const L3 = await makeLead("C");
    await db.delete(S.nbfcLeadAssignments).where(eq(S.nbfcLeadAssignments.lead_id, L3.id));
    const opts = await SP.listSchemeOptions(L3.id);
    if (opts.length) {
      await SP.setLeadSchemePick({ leadId: L3.id, pick: { nbfcId: opts[0].nbfcId, loanProductId: opts[0].loanProductId }, byUserId: PARENT, byName: "Test SH", channel: "web" });
      const { resolveRoutingTarget } = await import("@/lib/leads/nbfc-routing");
      const t = await resolveRoutingTarget(L3.id);
      check("T6 routing uses the sales head's scheme pick", t.ok && t.source === "scheme_pick" && t.nbfcId === opts[0].nbfcId, t);
      let refused = false;
      try {
        await SP.setLeadSchemePick({ leadId: L3.id, pick: { nbfcId: 999999, loanProductId: 1 }, byUserId: PARENT, byName: "x", channel: "web" });
      } catch {
        refused = true;
      }
      check("T6 a scheme that does not fit the lead is refused", refused);
    } else {
      console.log("SKIP  T6 — no scheme fits the test lead on sandbox");
    }
    const { parseRupees } = await import("@/lib/leads/requested-loan-amount");
    check("T6 loan amount parsing for the WhatsApp step", parseRupees("1.5 lakh") === 150000 && parseRupees("60000") === 60000);

    // ── Task 10 — the iTarang salesperson hears milestones on WhatsApp ──
    await db.insert(S.leadDealerReviews).values({ lead_id: L1.id, dealer_id: "ACC-ITARANG-001", reason_kind: "manual_pick", initiator_wa_phone: "919999900001", status: "approved" });
    const { pushInitiatorWhatsApp } = await import("@/lib/notifications/initiator-whatsapp");
    await pushInitiatorWhatsApp({ type: "loan.sanctioned", title: "Loan sanctioned", message: "Test sanction", leadId: L1.id });
    const wa = await db
      .select({ id: S.whatsappMessages.id })
      .from(S.whatsappMessages)
      .where(and(like(S.whatsappMessages.text_body, "%Loan sanctioned%T23NOV-A%"), gte(S.whatsappMessages.created_at, started)));
    check("T10 salesperson WhatsApp sent (dry-run adapter)", wa.length >= 1, wa.length);

    // ── Task 11 — 9 PM report figures ──
    const { nbfcDailyDigest } = await import("@/lib/digests/kinds/nbfc-daily");
    const { istDate } = await import("@/lib/operations/istClock");
    const today = istDate(new Date());
    const all = await nbfcDailyDigest.collect(today);
    const get = (f: typeof all.figures, label: string) => f.activity.find((l) => l.label.startsWith(label))?.value ?? -1;
    check("T11 report builds (all NBFCs)", all.ok, all.error);
    check("T11 counts today's received / sanctioned / disbursed", get(all.figures, "Files received") >= 2 && get(all.figures, "Sanctioned") >= 1 && get(all.figures, "Disbursed") >= 1, all.figures.activity);
    const city = all.figures.tables?.find((t) => t.key === "city");
    check("T11 city-wise table has Pune", !!city?.rows.some((r) => r[0] === "Pune"), city?.rows);
    check("T11 NBFC-wise table for iTarang", !!all.figures.tables?.find((t) => t.key === "nbfc"));
    const own = await nbfcDailyDigest.perRecipient!.collect(today, { id: PARENT, name: "P", email: "p@x", role: "nbfc_admin" });
    check("T11 NBFC admin copy has no NBFC-wise table (own NBFC only)", own.ok && !own.figures.tables?.find((t) => t.key === "nbfc"), own.figures.tables?.map((t) => t.key));
    const people = await nbfcDailyDigest.perRecipient!.resolve({ roles: { admin: true, sales_head: true, nbfc_admin: true } });
    check("T11 recipients include admins/sales heads and NBFC admins", people.some((p) => p.role === "admin" || p.role === "sales_head") && people.some((p) => p.role === "nbfc_admin"), people.map((p) => p.role));
    const { defaultSettings } = await import("@/lib/digests/schedule");
    const ds = defaultSettings(nbfcDailyDigest.sections, nbfcDailyDigest.defaults);
    check("T11 default time is 21:00 IST, evening only", ds.eveningHour === 21 && ds.eveningMinute === 0 && JSON.stringify(nbfcDailyDigest.slots) === '["evening"]');
  } catch (e) {
    fail++;
    console.error("TEST ERROR", e);
  } finally {
    // ── Cleanup ──
    const ids = [...leadIds, ...createdLeadIds];
    if (ids.length) {
      const asg = await db.select({ id: S.nbfcLeadAssignments.id }).from(S.nbfcLeadAssignments).where(inArray(S.nbfcLeadAssignments.lead_id, ids));
      const asgIds = asg.map((a) => a.id);
      const revs = await db.select({ id: S.nbfcCibilReviews.id }).from(S.nbfcCibilReviews).where(inArray(S.nbfcCibilReviews.lead_id, ids));
      const reqIds = (await db.select({ id: S.nbfcDocRequests.id }).from(S.nbfcDocRequests).where(inArray(S.nbfcDocRequests.lead_id, ids))).map((r) => r.id);
      const auditIds = [...asgIds, ...revs.map((r) => r.id)];
      if (auditIds.length) await db.delete(S.nbfcAuditLog).where(inArray(S.nbfcAuditLog.action_id, auditIds));
      await db.delete(S.notifications).where(inArray(S.notifications.lead_id, ids));
      if (reqIds.length) await db.delete(S.otherDocumentRequests).where(inArray(S.otherDocumentRequests.nbfc_request_id, reqIds));
      await db.delete(S.nbfcDocRequests).where(inArray(S.nbfcDocRequests.lead_id, ids));
      await db.delete(S.nbfcCibilReviews).where(inArray(S.nbfcCibilReviews.lead_id, ids));
      await db.delete(S.nbfcLoanAgreements).where(inArray(S.nbfcLoanAgreements.lead_id, ids));
      await db.delete(S.enachMandates).where(inArray(S.enachMandates.lead_id, ids));
      await db.delete(S.loanSanctions).where(inArray(S.loanSanctions.lead_id, ids));
      if (asgIds.length) await db.delete(S.nbfcFinancingOffers).where(inArray(S.nbfcFinancingOffers.assignment_id, asgIds));
      await db.delete(S.nbfcLeadAssignments).where(inArray(S.nbfcLeadAssignments.lead_id, ids));
      await db.delete(S.leadResumes).where(inArray(S.leadResumes.old_lead_id, ids));
      await db.delete(S.leadSchemePicks).where(inArray(S.leadSchemePicks.lead_id, ids));
      await db.delete(S.leadDealerReviews).where(inArray(S.leadDealerReviews.lead_id, ids));
      await db.delete(S.kycDocuments).where(inArray(S.kycDocuments.lead_id, ids));
      await db.delete(S.personalDetails).where(inArray(S.personalDetails.lead_id, ids));
      await db.delete(S.auditLogs).where(inArray(S.auditLogs.entity_id, ids));
      await db.execute(sql`DELETE FROM lead_flow_events WHERE lead_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`).catch(() => {});
      await db.execute(sql`DELETE FROM kyc_events WHERE lead_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`).catch(() => {});
      await db.delete(S.leads).where(inArray(S.leads.id, ids));
    }
    await db
      .delete(S.whatsappMessages)
      .where(and(like(S.whatsappMessages.text_body, "%T23NOV-%"), gte(S.whatsappMessages.created_at, started)));
    if (ledgerIds.length) await db.delete(S.nbfcWalletLedger).where(inArray(S.nbfcWalletLedger.id, ledgerIds));
    if (agreementMethodBefore !== undefined) {
      await db.update(S.nbfcServiceConfig).set({ doc_agreement_method: agreementMethodBefore }).where(eq(S.nbfcServiceConfig.tenant_id, TENANT));
      console.log("restored doc_agreement_method:", agreementMethodBefore);
    }
    if (walletBefore != null) await db.update(S.nbfcWallets).set({ balance: walletBefore }).where(eq(S.nbfcWallets.tenant_id, TENANT));
    const left = await db.select({ id: S.leads.id }).from(S.leads).where(like(S.leads.id, "LEAD-T23NOV-%"));
    console.log(`\ncleanup: ${left.length === 0 ? "all test rows removed" : `LEFT ${left.length} test leads`}; wallet restored: ${walletBefore != null}`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
