/**
 * NBFC request SLA — the E-254 sweep.
 *
 * WHAT IT DOES. The NBFC ⇄ Admin ⇄ Dealer document-request loop has two places
 * where a request sits waiting on a human at iTarang, and this sweep is what
 * moves it on when nobody does:
 *
 *   leg 1  a wrapper born 'nbfc_raised' (correction / additional docs / Step-4
 *          extras / manual consent / co-borrower), or a per-document verdict of
 *          'queried' | 'rejected' the admin has not forwarded → forwarded to the
 *          dealer exactly as an admin's click would do it, with the NBFC's own
 *          comments relayed verbatim as the dealer-facing reason.
 *   leg 2  a wrapper at 'admin_review_upload' (the dealer uploaded everything,
 *          iTarang owes a review) → every child the dealer actually uploaded is
 *          marked verified with review_source='system' (E-246 vocabulary — NOBODY
 *          OPENED THE FILES) and the wrapper is pushed to the NBFC.
 *
 * WHERE THE CLOCK COMES FROM. `sla_due_at` is stamped when a row ENTERS a leg
 * (createNbfcDocRequest / upsertNbfcVerdict / recomputeWrapperStatus) from
 * app_settings.nbfc_request_sla, and NULLed by every admin action. So this
 * file never decides whether something is due — it only acts on what the
 * write path already scheduled — and an admin who acts before the deadline
 * always wins because their write clears the deadline first.
 *
 * THE CLAIM IS THE LOCK, AND IT IS EXACTLY-ONCE. Each loop claims the oldest
 * due row with `UPDATE … SET sla_due_at = NULL WHERE id = (SELECT … FOR UPDATE
 * SKIP LOCKED) RETURNING *`. Nulling the deadline in the same statement that
 * reads the row means the in-process ticker and a concurrent cron hit cannot
 * both process it, AND a row is attempted once whatever the outcome — a
 * deterministic failure is written to `sla_failure` and surfaced to the admins
 * rather than retried on every tick for the rest of its life.
 *
 * THE CLOCK IS THE DATABASE'S, NOT THIS PROCESS'S. Every comparison runs
 * against Postgres `now()` — see the identical note in kyc/auto-approval.ts
 * and nbfc/auction/scheduler.ts for the ~1s VPS↔RDS drift that motivated it.
 * `now` is a test override only, bound as ISO text cast to timestamptz.
 *
 * DIRECT THREADS ARE OUT OF SCOPE. A `dealer_direct` wrapper (E-240) never
 * waits on iTarang, so every claim carries `dealer_direct = false`.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  auditLogs,
  nbfcDocRequests,
  nbfcDocumentVerifications,
  nbfcLeadAssignments,
  otherDocumentRequests,
} from "@/lib/db/schema";
import { createWorkflowId } from "@/lib/kyc/admin-workflow";
import { actionNbfcCoBorrowerRequest } from "@/lib/nbfc/doc-request-actions";
import {
  notifyDealerOfForward,
  notifyDealerOfVerdictForward,
  notifyNbfcOfUpdate,
} from "@/lib/nbfc/doc-request-notify";
import {
  NBFC_DOC_STATUS,
  VERDICT_DOC_LABELS,
  deriveForwardItems,
  forwardNbfcDocRequest,
  forwardVerdictToDealer,
  pushNbfcDocRequest,
} from "@/lib/nbfc/doc-requests";
import {
  type NbfcRequestSlaSettings,
  formatSlaWindow,
  getNbfcRequestSlaSettings,
} from "@/lib/nbfc/request-sla-settings";
import { forwardRejectionToDealer } from "@/lib/nbfc/rejection-forward";
import { tenantDisplayName } from "@/lib/notifications/emit";
import { notifyNbfcRequestAutoRouted } from "@/lib/notifications/events";
import { SYSTEM_PARTY } from "@/lib/notifications/provenance";

/** Bound each loop so a pathological backlog cannot pin one tick for minutes. */
const MAX_PER_LOOP = 100;

function clockOf(now?: Date) {
  return now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;
}

export type NbfcRequestSlaTickResult = {
  ran: boolean;
  reason?: string;
  forwarded: number;
  verdictsForwarded: number;
  pushed: number;
  /** E-275 — NBFC file rejections auto-forwarded to the dealer. */
  rejectionsForwarded: number;
  failed: number;
};

type WrapperRow = typeof nbfcDocRequests.$inferSelect;
type VerdictRow = typeof nbfcDocumentVerifications.$inferSelect;
type AssignmentRow = typeof nbfcLeadAssignments.$inferSelect;

/**
 * Claim and process every request whose SLA has expired.
 */
export async function runNbfcRequestSlaTick(
  now?: Date,
): Promise<NbfcRequestSlaTickResult> {
  const empty: NbfcRequestSlaTickResult = {
    ran: false,
    forwarded: 0,
    verdictsForwarded: 0,
    pushed: 0,
    rejectionsForwarded: 0,
    failed: 0,
  };

  const settings = await getNbfcRequestSlaSettings();
  if (!settings.enabled) return { ...empty, reason: "disabled" };

  const nowSql = clockOf(now);
  const result: NbfcRequestSlaTickResult = { ...empty, ran: true };

  if (settings.autoForwardToDealer) {
    await sweepWrapperForwards(nowSql, settings, result);
    await sweepVerdictForwards(nowSql, settings, result);
  }
  if (settings.autoPushToNbfc) {
    await sweepPushes(nowSql, settings, result);
  }
  if (settings.autoForwardRejection) {
    await sweepRejectionForwards(nowSql, settings, result);
  }

  if (
    result.forwarded +
      result.verdictsForwarded +
      result.pushed +
      result.rejectionsForwarded +
      result.failed >
    0
  ) {
    console.log(
      `[nbfc-request-sla] forwarded=${result.forwarded} verdicts=${result.verdictsForwarded} pushed=${result.pushed} rejections=${result.rejectionsForwarded} failed=${result.failed}`,
    );
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Loop A — leg 1, wrappers: nbfc_raised → forwarded_to_dealer
 * ------------------------------------------------------------------ */

async function sweepWrapperForwards(
  nowSql: ReturnType<typeof clockOf>,
  settings: NbfcRequestSlaSettings,
  out: NbfcRequestSlaTickResult,
): Promise<void> {
  const window = formatSlaWindow(settings.forwardSlaMinutes);
  for (let i = 0; i < MAX_PER_LOOP; i++) {
    const claimed = await db.execute<WrapperRow>(sql`
      UPDATE nbfc_doc_requests
         SET sla_due_at = NULL, updated_at = ${nowSql}
       WHERE id = (
             SELECT id FROM nbfc_doc_requests
              WHERE sla_due_at IS NOT NULL
                AND sla_due_at <= ${nowSql}
                AND status IN ('nbfc_raised', 'admin_review')
                AND request_type <> 'message'
                AND dealer_direct = false
              ORDER BY sla_due_at ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED
       )
   RETURNING *
    `);
    const row = claimed[0];
    if (!row) break;

    const nbfcName = await tenantDisplayName(row.tenant_id);
    try {
      let docLabels: string[] = [];
      if (row.request_type === "co_borrower") {
        // No documents to forward — actioning the ask IS the forward.
        await actionNbfcCoBorrowerRequest({
          requestId: row.id,
          adminUserId: null,
          source: "system",
        });
        docLabels = ["Co-borrower"];
      } else {
        const items = deriveForwardItems(row, nbfcName);
        if (items.length === 0) {
          throw new Error(
            "this request already carries the maximum number of items, so nothing more can be forwarded",
          );
        }
        // Mirror forwardVerdictToDealer's routing: a correction on the primary
        // applicant's own document lands on Step 2 without pulling the dealer
        // off it; everything else routes to Step 3.
        const routeToStep3 = !(
          row.request_type === "correction" && row.doc_for !== "co_borrower"
        );
        await forwardNbfcDocRequest({
          requestId: row.id,
          adminUserId: null,
          source: "system",
          items,
          adminNotes: `Auto-forwarded to the dealer after the ${window} SLA elapsed with no admin action — the NBFC's comments were relayed verbatim as the reason.`,
          routeToStep3,
        });
        docLabels = items.map((it) => it.doc_label);
        await notifyDealerOfForward({
          leadId: row.lead_id,
          requestId: row.id,
          docLabels,
          nbfcName,
          targetStep: routeToStep3 ? "borrower-consent" : "kyc",
          from: SYSTEM_PARTY,
        }).catch(() => {});
      }

      out.forwarded++;
      await recordAudit("auto_forwarded", row.id, {
        lead_id: row.lead_id,
        request_type: row.request_type,
        nbfc_name: nbfcName,
        sla_minutes: settings.forwardSlaMinutes,
        doc_labels: docLabels,
      });
      notifyNbfcRequestAutoRouted({
        leadId: row.lead_id,
        requestId: row.id,
        kind: "forwarded",
        ok: true,
        slaWindow: window,
        nbfcName,
        docLabels,
      }).catch(() => {});
    } catch (err) {
      await failWrapper(row, "forwarded", err, window, nbfcName, out);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Loop B — leg 1, verdicts: queried/rejected, not forwarded → forwarded
 * ------------------------------------------------------------------ */

async function sweepVerdictForwards(
  nowSql: ReturnType<typeof clockOf>,
  settings: NbfcRequestSlaSettings,
  out: NbfcRequestSlaTickResult,
): Promise<void> {
  const window = formatSlaWindow(settings.forwardSlaMinutes);
  for (let i = 0; i < MAX_PER_LOOP; i++) {
    const claimed = await db.execute<VerdictRow>(sql`
      UPDATE nbfc_document_verifications
         SET sla_due_at = NULL, updated_at = ${nowSql}
       WHERE id = (
             SELECT id FROM nbfc_document_verifications
              WHERE sla_due_at IS NOT NULL
                AND sla_due_at <= ${nowSql}
                AND verdict IN ('queried', 'rejected')
                AND forwarded_at IS NULL
              ORDER BY sla_due_at ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED
       )
   RETURNING *
    `);
    const row = claimed[0];
    if (!row) break;

    const nbfcName = await tenantDisplayName(row.tenant_id);
    const docLabel = VERDICT_DOC_LABELS[row.doc_key] ?? row.doc_key;
    try {
      // The dealer-facing reason is the NBFC's own words. forwardVerdictToDealer
      // requires a non-empty message and notes can be null, so fall back to a
      // one-line statement of what the NBFC did.
      const notes = (row.notes ?? "").trim();
      const message = notes
        ? `${nbfcName}: ${notes}`
        : `${nbfcName} ${
            row.verdict === "rejected" ? "rejected" : "requested a correction on"
          } the ${docLabel}.`;

      const fwd = await forwardVerdictToDealer({
        verdictId: row.id,
        adminUserId: null,
        source: "system",
        message,
      });
      await notifyDealerOfVerdictForward({
        leadId: fwd.leadId,
        requestId: fwd.requestId,
        docFor: fwd.docFor,
        step: fwd.step,
        docLabel: fwd.docLabel,
        message,
        bySystem: true,
      });

      out.verdictsForwarded++;
      await recordAudit("auto_forwarded", fwd.requestId, {
        lead_id: row.lead_id,
        verdict_id: row.id,
        verdict: row.verdict,
        doc_key: row.doc_key,
        nbfc_name: nbfcName,
        sla_minutes: settings.forwardSlaMinutes,
        doc_labels: [fwd.docLabel],
      });
      notifyNbfcRequestAutoRouted({
        leadId: row.lead_id,
        requestId: fwd.requestId,
        kind: "forwarded",
        ok: true,
        slaWindow: window,
        nbfcName,
        docLabels: [fwd.docLabel],
      }).catch(() => {});
    } catch (err) {
      out.failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[nbfc-request-sla] verdict ${row.id} auto-forward failed:`, message);
      try {
        await db
          .update(nbfcDocumentVerifications)
          .set({ sla_failure: message, updated_at: new Date() })
          .where(eq(nbfcDocumentVerifications.id, row.id));
      } catch {
        /* the deadline is already cleared; nothing else to do */
      }
      await recordAudit("failed", `verdict:${row.id}`, {
        lead_id: row.lead_id,
        kind: "forwarded",
        error: message,
      });
      notifyNbfcRequestAutoRouted({
        leadId: row.lead_id,
        requestId: `verdict:${row.id}`,
        kind: "forwarded",
        ok: false,
        slaWindow: window,
        nbfcName,
        docLabels: [docLabel],
        error: message,
      }).catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ *
 * Loop C — leg 2, wrappers: admin_review_upload → pushed_to_nbfc
 * ------------------------------------------------------------------ */

async function sweepPushes(
  nowSql: ReturnType<typeof clockOf>,
  settings: NbfcRequestSlaSettings,
  out: NbfcRequestSlaTickResult,
): Promise<void> {
  const window = formatSlaWindow(settings.pushSlaMinutes);
  for (let i = 0; i < MAX_PER_LOOP; i++) {
    const claimed = await db.execute<WrapperRow>(sql`
      UPDATE nbfc_doc_requests
         SET sla_due_at = NULL, updated_at = ${nowSql}
       WHERE id = (
             SELECT id FROM nbfc_doc_requests
              WHERE sla_due_at IS NOT NULL
                AND sla_due_at <= ${nowSql}
                AND status = 'admin_review_upload'
                AND request_type <> 'message'
                AND dealer_direct = false
              ORDER BY sla_due_at ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED
       )
   RETURNING *
    `);
    const row = claimed[0];
    if (!row) break;

    const nbfcName = await tenantDisplayName(row.tenant_id);
    try {
      // Between the stamp and this claim an admin may have rejected a child
      // (recomputeWrapperStatus would then have cleared the clock, but re-read
      // to be sure) — the guard below on upload_status='uploaded' means a
      // rejected or still-missing child is never touched either way.
      const [fresh] = await db
        .select({ status: nbfcDocRequests.status })
        .from(nbfcDocRequests)
        .where(eq(nbfcDocRequests.id, row.id))
        .limit(1);
      if (fresh?.status !== NBFC_DOC_STATUS.ADMIN_REVIEW_UPLOAD) {
        throw new Error(
          `request is no longer awaiting admin review (status ${fresh?.status ?? "unknown"})`,
        );
      }

      const stamp = new Date();
      const verified = await db
        .update(otherDocumentRequests)
        .set({
          upload_status: "verified",
          status: "verified",
          reviewed_by: null,
          review_source: "system",
          reviewed_at: stamp,
          updated_at: stamp,
        })
        .where(
          and(
            eq(otherDocumentRequests.nbfc_request_id, row.id),
            eq(otherDocumentRequests.upload_status, "uploaded"),
          ),
        )
        .returning({
          id: otherDocumentRequests.id,
          doc_key: otherDocumentRequests.doc_key,
          doc_label: otherDocumentRequests.doc_label,
        });

      // One audit row per child, the same shape the admin's Approve writes, so
      // the document's own history reads the same either way — with the actor
      // NULL and review_source saying 'system'.
      for (const child of verified) {
        await db.insert(auditLogs).values({
          id: createWorkflowId("AUDIT", stamp),
          entity_type: "supporting_doc_review",
          entity_id: child.id,
          action: "approve",
          changes: {
            lead_id: row.lead_id,
            doc_key: child.doc_key,
            doc_label: child.doc_label,
            previous_status: "uploaded",
            new_status: "verified",
            note: `Auto-verified by the NBFC request SLA after ${window} with no admin review. Nobody opened the file.`,
            review_source: "system",
            nbfc_request_id: row.id,
          },
          performed_by: null,
          timestamp: stamp,
        });
      }

      // pushNbfcDocRequest re-checks that EVERY child is verified — if a child
      // was neither uploaded nor verified this throws, the failure is recorded
      // and the request stays with the admin.
      await pushNbfcDocRequest({
        requestId: row.id,
        adminUserId: null,
        source: "system",
      });
      await notifyNbfcOfUpdate({
        tenantId: row.tenant_id,
        leadId: row.lead_id,
        requestId: row.id,
        from: SYSTEM_PARTY,
      }).catch(() => {});

      const docLabels = verified.map((c) => c.doc_label);
      out.pushed++;
      await recordAudit("auto_pushed", row.id, {
        lead_id: row.lead_id,
        request_type: row.request_type,
        nbfc_name: nbfcName,
        sla_minutes: settings.pushSlaMinutes,
        docs_verified: verified.length,
        doc_labels: docLabels,
        files_opened: false,
      });
      notifyNbfcRequestAutoRouted({
        leadId: row.lead_id,
        requestId: row.id,
        kind: "pushed",
        ok: true,
        slaWindow: window,
        nbfcName,
        docLabels,
      }).catch(() => {});
    } catch (err) {
      await failWrapper(row, "pushed", err, window, nbfcName, out);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Loop D — E-275, NBFC file rejections: declined, not forwarded → dealer
 * ------------------------------------------------------------------ */

async function sweepRejectionForwards(
  nowSql: ReturnType<typeof clockOf>,
  settings: NbfcRequestSlaSettings,
  out: NbfcRequestSlaTickResult,
): Promise<void> {
  const window = formatSlaWindow(settings.rejectionSlaMinutes);
  for (let i = 0; i < MAX_PER_LOOP; i++) {
    const claimed = await db.execute<AssignmentRow>(sql`
      UPDATE nbfc_lead_assignments
         SET rejection_admin_due_at = NULL, updated_at = ${nowSql}
       WHERE id = (
             SELECT id FROM nbfc_lead_assignments
              WHERE rejection_admin_due_at IS NOT NULL
                AND rejection_admin_due_at <= ${nowSql}
                AND status = 'declined'
                AND rejection_forwarded_at IS NULL
              ORDER BY rejection_admin_due_at ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED
       )
   RETURNING *
    `);
    const row = claimed[0];
    if (!row) break;

    const nbfcName = await tenantDisplayName(row.tenant_id);
    try {
      const fwd = await forwardRejectionToDealer({
        assignmentId: row.id,
        source: "system",
        adminUserId: null,
      });
      out.rejectionsForwarded++;
      await recordAudit("auto_forwarded", `rejection:${row.id}`, {
        lead_id: row.lead_id,
        kind: "rejection",
        nbfc_name: fwd.nbfcName,
        sla_minutes: settings.rejectionSlaMinutes,
        note: fwd.note,
      });
      notifyNbfcRequestAutoRouted({
        leadId: row.lead_id,
        requestId: `rejection:${row.id}`,
        kind: "forwarded",
        ok: true,
        slaWindow: window,
        nbfcName: fwd.nbfcName,
        docLabels: ["File rejection"],
      }).catch(() => {});
    } catch (err) {
      out.failed++;
      const message = (err instanceof Error ? err.message : String(err)).replace(
        /^(BAD_REQUEST|NOT_FOUND):\s*/,
        "",
      );
      console.error(`[nbfc-request-sla] rejection ${row.id} auto-forward failed:`, message);
      await recordAudit("failed", `rejection:${row.id}`, {
        lead_id: row.lead_id,
        kind: "rejection",
        error: message,
      });
      notifyNbfcRequestAutoRouted({
        leadId: row.lead_id,
        requestId: `rejection:${row.id}`,
        kind: "forwarded",
        ok: false,
        slaWindow: window,
        nbfcName,
        docLabels: ["File rejection"],
        error: message,
      }).catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

async function failWrapper(
  row: WrapperRow,
  kind: "forwarded" | "pushed",
  err: unknown,
  window: string,
  nbfcName: string,
  out: NbfcRequestSlaTickResult,
): Promise<void> {
  out.failed++;
  const message = (err instanceof Error ? err.message : String(err)).replace(
    /^(BAD_REQUEST|NOT_FOUND):\s*/,
    "",
  );
  console.error(`[nbfc-request-sla] ${row.id} auto-${kind} failed:`, message);
  try {
    await db
      .update(nbfcDocRequests)
      .set({ sla_failure: message, updated_at: new Date() })
      .where(eq(nbfcDocRequests.id, row.id));
  } catch {
    /* the deadline is already cleared; nothing else to do */
  }
  await recordAudit("failed", row.id, {
    lead_id: row.lead_id,
    kind,
    request_type: row.request_type,
    error: message,
  });
  notifyNbfcRequestAutoRouted({
    leadId: row.lead_id,
    requestId: row.id,
    kind,
    ok: false,
    slaWindow: window,
    nbfcName,
    error: message,
  }).catch(() => {});
}

async function recordAudit(
  action: "auto_forwarded" | "auto_pushed" | "failed",
  entityId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  try {
    const stamp = new Date();
    await db.insert(auditLogs).values({
      id: createWorkflowId("AUDIT", stamp),
      entity_type: "nbfc_request_sla",
      entity_id: entityId,
      action,
      changes,
      // NULL actor = the system. Same convention as the E-246 sweep.
      performed_by: null,
      timestamp: stamp,
    });
  } catch (err) {
    // The action is already committed; a logging failure must not make a
    // successful auto-route look broken.
    console.error("[nbfc-request-sla] audit insert failed:", err);
  }
}
