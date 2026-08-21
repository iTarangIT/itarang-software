/**
 * E-254 end-to-end check against the ACTIVE database (prints the host first).
 * Creates one throwaway wrapper + one throwaway verdict on a real lead that has
 * an NBFC assignment, drives both SLA legs by backdating the clocks and running
 * the sweep, asserts every hop, then deletes what it created and switches the
 * feature back to what it was. Nothing here touches pre-existing rows.
 *
 *   node --import tsx --env-file=.env.local scripts/_verify-e254-sla.ts
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  auditLogs,
  nbfcDocRequests,
  nbfcDocumentVerifications,
  nbfcLeadAssignments,
  otherDocumentRequests,
  notifications,
} from "@/lib/db/schema";
import {
  createNbfcDocRequest,
  recomputeWrapperStatus,
} from "@/lib/nbfc/doc-requests";
import { upsertNbfcVerdict } from "@/lib/nbfc/doc-verdict";
import { runNbfcRequestSlaTick } from "@/lib/nbfc/request-sla";
import {
  getNbfcRequestSlaSettings,
  setNbfcRequestSlaSettings,
} from "@/lib/nbfc/request-sla-settings";

function ok(cond: unknown, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log("ok -", msg);
}

const TEST_TYPES = ["nbfc.request_auto_forwarded", "nbfc.request_auto_pushed"];

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  console.log("HOST:", host);

  const before = await getNbfcRequestSlaSettings();
  console.log("settings before:", before);

  const [asg] = await db
    .select({
      id: nbfcLeadAssignments.id,
      lead_id: nbfcLeadAssignments.lead_id,
      nbfc_id: nbfcLeadAssignments.nbfc_id,
      tenant_id: nbfcLeadAssignments.tenant_id,
    })
    .from(nbfcLeadAssignments)
    .orderBy(desc(nbfcLeadAssignments.created_at))
    .limit(1);
  ok(asg, "found an NBFC assignment (lead " + asg?.lead_id + ")");

  const [anyReq] = await db
    .select({ raised_by: nbfcDocRequests.raised_by })
    .from(nbfcDocRequests)
    .limit(1);
  const actor = anyReq?.raised_by ?? "00000000-0000-4000-8000-000000000e54";

  const created: string[] = [];
  let verdictId: number | null = null;
  try {
    // 0. feature ON with tiny windows
    await setNbfcRequestSlaSettings({
      enabled: true,
      forwardSlaMinutes: 1,
      pushSlaMinutes: 1,
      autoForwardToDealer: true,
      autoPushToNbfc: true,
    });

    // 1. leg 1, wrapper
    const { id: reqId } = await createNbfcDocRequest({
      leadId: asg.lead_id,
      assignmentId: asg.id,
      nbfcId: asg.nbfc_id,
      tenantId: asg.tenant_id,
      requestType: "additional_docs",
      docFor: "primary",
      comments: "E254-TEST 1. Updated bank statement (required) - last 6 months",
      raisedBy: actor,
      requestedItems: [
        { doc_label: "E254-TEST Updated bank statement", reason: "last 6 months", is_required: true },
      ],
    });
    created.push(reqId);
    let [w] = await db.select().from(nbfcDocRequests).where(eq(nbfcDocRequests.id, reqId));
    ok(w.status === "nbfc_raised" && w.sla_due_at, "wrapper born nbfc_raised with sla_due_at=" + w.sla_due_at?.toISOString());

    let r = await runNbfcRequestSlaTick();
    [w] = await db.select().from(nbfcDocRequests).where(eq(nbfcDocRequests.id, reqId));
    ok(w.status === "nbfc_raised", "sweep left an in-window wrapper alone (forwarded=" + r.forwarded + ")");

    await db.update(nbfcDocRequests).set({ sla_due_at: sql`now() - interval '1 minute'` }).where(eq(nbfcDocRequests.id, reqId));
    r = await runNbfcRequestSlaTick();
    [w] = await db.select().from(nbfcDocRequests).where(eq(nbfcDocRequests.id, reqId));
    ok(w.status === "forwarded_to_dealer", "wrapper auto-forwarded (status=" + w.status + ")");
    ok(w.forward_source === "system" && w.auto_forwarded_at && w.sla_due_at === null && w.reviewed_by === null, "forward_source=system, auto_forwarded_at set, clock cleared, no admin actor");
    const kids = await db.select().from(otherDocumentRequests).where(eq(otherDocumentRequests.nbfc_request_id, reqId));
    ok(kids.length === 1 && kids[0].doc_label === "E254-TEST Updated bank statement" && kids[0].source === "nbfc", "one child created from requested_items: " + kids[0]?.doc_label + " (reason: " + kids[0]?.rejection_reason + ")");

    // 2. leg 2
    await db.update(otherDocumentRequests).set({ upload_status: "uploaded", file_url: "https://example.invalid/e254.pdf", uploaded_at: new Date() }).where(eq(otherDocumentRequests.id, kids[0].id));
    const st = await recomputeWrapperStatus(reqId);
    [w] = await db.select().from(nbfcDocRequests).where(eq(nbfcDocRequests.id, reqId));
    ok(st === "admin_review_upload" && w.sla_due_at, "after upload: admin_review_upload with push clock " + w.sla_due_at?.toISOString());

    await db.update(otherDocumentRequests).set({ upload_status: "rejected" }).where(eq(otherDocumentRequests.id, kids[0].id));
    await recomputeWrapperStatus(reqId);
    [w] = await db.select().from(nbfcDocRequests).where(eq(nbfcDocRequests.id, reqId));
    ok(w.status === "forwarded_to_dealer" && w.sla_due_at === null, "admin reject -> back to dealer, push clock cleared");
    await db.update(otherDocumentRequests).set({ upload_status: "uploaded" }).where(eq(otherDocumentRequests.id, kids[0].id));
    await recomputeWrapperStatus(reqId);
    [w] = await db.select().from(nbfcDocRequests).where(eq(nbfcDocRequests.id, reqId));
    ok(w.status === "admin_review_upload" && w.sla_due_at, "re-upload -> fresh push clock");

    await db.update(nbfcDocRequests).set({ sla_due_at: sql`now() - interval '1 minute'` }).where(eq(nbfcDocRequests.id, reqId));
    r = await runNbfcRequestSlaTick();
    [w] = await db.select().from(nbfcDocRequests).where(eq(nbfcDocRequests.id, reqId));
    ok(w.status === "pushed_to_nbfc" && w.push_source === "system" && w.auto_pushed_at, "wrapper auto-pushed (status=" + w.status + ", pushed=" + r.pushed + ")");
    const [kid] = await db.select().from(otherDocumentRequests).where(eq(otherDocumentRequests.id, kids[0].id));
    ok(kid.upload_status === "verified" && kid.review_source === "system" && kid.reviewed_by === null, "child verified with review_source=system, no admin actor");

    // 3. leg 1, verdict
    const base = { leadId: asg.lead_id, assignmentId: asg.id, nbfcId: asg.nbfc_id, tenantId: asg.tenant_id, docFor: "primary" as const, docKey: "e254_test_doc", verifiedBy: actor };
    await upsertNbfcVerdict({ ...base, verdict: "queried", notes: "E254-TEST please re-upload a clearer scan" });
    let [v] = await db.select().from(nbfcDocumentVerifications).where(and(eq(nbfcDocumentVerifications.assignment_id, asg.id), eq(nbfcDocumentVerifications.doc_key, "e254_test_doc")));
    verdictId = v.id;
    ok(v.sla_due_at, "verdict queried -> sla_due_at " + v.sla_due_at?.toISOString());
    const firstDue = v.sla_due_at!.getTime();
    await upsertNbfcVerdict({ ...base, verdict: "queried", notes: "E254-TEST edited" });
    [v] = await db.select().from(nbfcDocumentVerifications).where(eq(nbfcDocumentVerifications.id, v.id));
    ok(v.sla_due_at?.getTime() === firstDue, "re-saving the verdict keeps the same deadline");
    await upsertNbfcVerdict({ ...base, verdict: "verified" });
    [v] = await db.select().from(nbfcDocumentVerifications).where(eq(nbfcDocumentVerifications.id, v.id));
    ok(v.sla_due_at === null, "verified -> clock cleared");
    await upsertNbfcVerdict({ ...base, verdict: "rejected", notes: null });
    [v] = await db.select().from(nbfcDocumentVerifications).where(eq(nbfcDocumentVerifications.id, v.id));
    ok(v.sla_due_at, "rejected (no notes) -> clock re-armed");

    await db.update(nbfcDocumentVerifications).set({ sla_due_at: sql`now() - interval '1 minute'` }).where(eq(nbfcDocumentVerifications.id, v.id));
    r = await runNbfcRequestSlaTick();
    [v] = await db.select().from(nbfcDocumentVerifications).where(eq(nbfcDocumentVerifications.id, v.id));
    ok(v.forwarded_at && v.forward_source === "system" && v.forwarded_by === null && v.forwarded_request_id, "verdict auto-forwarded (verdicts=" + r.verdictsForwarded + ") -> wrapper " + v.forwarded_request_id);
    created.push(v.forwarded_request_id!);
    const [vw] = await db.select().from(nbfcDocRequests).where(eq(nbfcDocRequests.id, v.forwarded_request_id!));
    ok(vw.status === "forwarded_to_dealer" && vw.request_type === "correction" && vw.raised_by === actor, "spawned correction wrapper forwarded, raised_by = NBFC user (NOT NULL column)");
    const vkids = await db.select().from(otherDocumentRequests).where(eq(otherDocumentRequests.nbfc_request_id, vw.id));
    ok(vkids.length === 1 && /rejected the e254_test_doc/.test(vkids[0].rejection_reason ?? ""), "child reason falls back to a sentence when notes are null: " + vkids[0]?.rejection_reason);

    // 4. audit + admin notifications
    const audits = await db.select({ action: auditLogs.action, entity_id: auditLogs.entity_id }).from(auditLogs).where(and(eq(auditLogs.entity_type, "nbfc_request_sla"), inArray(auditLogs.entity_id, created)));
    ok(audits.some((a) => a.action === "auto_forwarded") && audits.some((a) => a.action === "auto_pushed"), "audit rows: " + audits.map((a) => a.action).join(", "));
    const notifs = await db.select({ type: notifications.type }).from(notifications).where(and(inArray(notifications.type, TEST_TYPES), inArray(sql`${notifications.data} ->> 'requestId'`, created))).orderBy(desc(notifications.created_at)).limit(50);
    ok(notifs.length > 0, "admin notifications emitted: " + [...new Set(notifs.map((n) => n.type))].join(", ") + " (" + notifs.length + " rows)");

    // 5. feature OFF -> inert
    await setNbfcRequestSlaSettings({ enabled: false });
    r = await runNbfcRequestSlaTick();
    ok(r.ran === false && r.reason === "disabled", "disabled -> tick returns immediately");
  } finally {
    await setNbfcRequestSlaSettings({ ...before });
    if (created.length) {
      await db.delete(otherDocumentRequests).where(inArray(otherDocumentRequests.nbfc_request_id, created));
      await db.delete(auditLogs).where(and(eq(auditLogs.entity_type, "nbfc_request_sla"), inArray(auditLogs.entity_id, created)));
      await db.delete(nbfcDocRequests).where(inArray(nbfcDocRequests.id, created));
    }
    if (verdictId) await db.delete(nbfcDocumentVerifications).where(eq(nbfcDocumentVerifications.id, verdictId));
    // Only the rows THIS run emitted — never a blanket delete by type.
    if (created.length) {
      await db.delete(notifications).where(and(inArray(notifications.type, TEST_TYPES), inArray(sql`${notifications.data} ->> 'requestId'`, created)));
    }
    console.log("cleanup done; settings restored to", await getNbfcRequestSlaSettings());
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
