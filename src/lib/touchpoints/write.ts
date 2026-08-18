// The single touchpoint writer. Every mutate on a dealer_lead — call, status
// change, ownership transfer, escalation, reactivation — goes through this
// function. Audit gaps are the worst kind of bug in this domain: BRD §0.11's
// "Status Changes Without Same-Hour Touchpoint" KPI exists *because* manual
// logging is the V1 hygiene risk. Funnelling all writes through one helper
// makes that risk a code-review problem, not an ops problem.
//
// What it does in a single transaction:
//   1. INSERT into lead_touchpoints.
//   2. If statusChange is provided: INSERT into dealer_lead_status_history
//      AND UPDATE dealer_leads (lead_status, closed_at on terminal, closing_*
//      on terminal).
//   3. UPDATE dealer_leads.last_touchpoint_at + updated_at.
//
// Returns the inserted touchpoint row. Throws on transaction failure; the
// transaction is rolled back so no partial writes land.

import { db } from "@/lib/db";
import {
  dealerLeads,
  dealerLeadStatusHistory,
  leadTouchpoints,
} from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import type {
  CallStatus,
  NextAction,
  TouchpointType,
} from "@/lib/lifecycle/touchpointTypes";
import type { LeadStatus, LostReason } from "@/lib/lifecycle/transitions";
import { isTerminal } from "@/lib/lifecycle/transitions";

export type StatusChange = {
  // null = the lead had no status at all (legacy / lift-in rows). from_status
  // is nullable in dealer_lead_status_history, so the audit row still writes.
  from: LeadStatus | null;
  to: LeadStatus;
  fromLostReason?: LostReason | null;
  toLostReason?: LostReason | null;
  reasonNotes?: string | null;
  // closing_role per BRD §0.13: is_phone / asm_visit / is_post_handoff / admin / system.
  closingRole?: "is_phone" | "asm_visit" | "is_post_handoff" | "admin" | "system";
};

export type WriteTouchpointInput = {
  dealerLeadId: string;
  touchpointType: TouchpointType;
  // null performedBy = system-generated (AI reactivation, upload, etc.).
  performedBy: string | null;
  performedAt?: Date;
  callStatus?: CallStatus | null;
  callDurationSec?: number | null;
  isEngaged?: boolean;
  remarks?: string | null;
  attachments?: unknown[] | null;
  nextAction?: NextAction | null;
  nextActionAt?: Date | null;
  externalSystem?: string | null;
  externalEventId?: string | null;
  syncMethod?: "manual" | "api" | "system" | "reconciliation";
  /**
   * The CC team's L1/L2/L3 disposition for this call (E-236).
   *
   * Written by raw UPDATEs INSIDE this transaction, unlike the NeoDove webhook
   * and the AI dialer, which both write theirs post-commit. The trade differs by
   * actor: an inbound event cannot be re-fetched, so losing the TOUCHPOINT to a
   * database missing E-236 would be unacceptable while losing the LABEL is
   * merely bad. A rep watched themselves pick "Price High" from a dropdown — a
   * save that silently dropped it is a lie on screen, and their submission is
   * retryable.
   *
   * The columns are NOT in schema.ts (see its header), so the statements are raw
   * and are emitted ONLY when this field is set — no existing caller runs a
   * single extra statement.
   */
  disposition?: {
    label: string;
    bucket: string | null;
    connectStatus: string;
  } | null;
  /** 'inside_sales' | 'neodove' | 'ai_dialer'. Defaults to 'inside_sales'. */
  dispositionSource?: string | null;
  statusChange?: StatusChange;
};

export type WriteTouchpointResult = {
  touchpointId: string;
  historyId: string | null;
};

// A live transaction handle, pulled from db.transaction's callback signature so
// callers can fold this write into a larger atomic operation (e.g.
// mark-converted + onboarding creation that must commit or roll back together).
// When `opts.tx` is omitted, writeTouchpoint opens its own transaction exactly
// as before — every existing caller is unaffected.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function writeTouchpoint(
  input: WriteTouchpointInput,
  opts?: { tx?: Tx },
): Promise<WriteTouchpointResult> {
  const performedAt = input.performedAt ?? new Date();

  const run = async (tx: Tx): Promise<WriteTouchpointResult> => {
    // 1. Touchpoint row — single source of audit truth.
    const [touchpoint] = await tx
      .insert(leadTouchpoints)
      .values({
        dealer_lead_id: input.dealerLeadId,
        touchpoint_type: input.touchpointType,
        performed_by: input.performedBy,
        performed_at: performedAt,
        call_status: input.callStatus ?? null,
        call_duration_sec: input.callDurationSec ?? null,
        is_engaged: input.isEngaged ?? false,
        remarks: input.remarks ?? null,
        attachments: (input.attachments ?? []) as never,
        next_action: input.nextAction ?? null,
        next_action_at: input.nextActionAt ?? null,
        external_system: input.externalSystem ?? null,
        external_event_id: input.externalEventId ?? null,
        sync_method: input.syncMethod ?? "manual",
      })
      .returning({ touchpoint_id: leadTouchpoints.touchpoint_id });

    // 1b. The disposition, when one was picked. Two raw statements: the
    //     dealer_leads one cannot go through the Drizzle object because naming
    //     these columns there would hard-fail ~20 bare selects on any database
    //     without E-236.
    if (input.disposition) {
      const d = input.disposition;
      const at = performedAt.toISOString();

      await tx.execute(sql`
        UPDATE lead_touchpoints
           SET disposition        = ${d.label},
               disposition_bucket = ${d.bucket},
               connect_status     = ${d.connectStatus}
         WHERE touchpoint_id = ${touchpoint!.touchpoint_id}::uuid
      `);

      await tx.execute(sql`
        UPDATE dealer_leads
           SET last_disposition        = ${d.label},
               last_disposition_bucket = ${d.bucket},
               last_connect_status     = ${d.connectStatus},
               last_disposition_at     = ${at}::timestamptz,
               last_disposition_source = ${input.dispositionSource ?? "inside_sales"}
         WHERE id = ${input.dealerLeadId}
           -- The LATER CALL owns the row, whichever system observed it. Same
           -- guard the NeoDove and AI writers use; there is deliberately no
           -- source precedence.
           AND (last_disposition_at IS NULL
                OR last_disposition_at <= ${at}::timestamptz)
      `);
    }

    let historyId: string | null = null;

    // 2. Status change — both audit row and the dealer_leads update happen
    //    in the same transaction so we can never have an updated status
    //    without a history row.
    if (input.statusChange) {
      const sc = input.statusChange;
      const [history] = await tx
        .insert(dealerLeadStatusHistory)
        .values({
          dealer_lead_id: input.dealerLeadId,
          from_status: sc.from,
          to_status: sc.to,
          from_lost_reason: sc.fromLostReason ?? null,
          to_lost_reason: sc.toLostReason ?? null,
          changed_by:
            input.performedBy ?? "system",
          changed_at: performedAt,
          reason_notes: sc.reasonNotes ?? null,
        })
        .returning({ history_id: dealerLeadStatusHistory.history_id });

      historyId = history?.history_id ?? null;

      // BRD §0.7: terminal transitions set closed_at + closing_owner_id +
      // closing_role; non-terminal transitions just update lead_status (+
      // lost_reason on Lost, which is terminal so it's already covered).
      const updatePayload: Record<string, unknown> = {
        lead_status: sc.to,
        last_touchpoint_at: performedAt,
        updated_at: performedAt,
      };

      if (sc.toLostReason !== undefined) {
        updatePayload.lost_reason = sc.toLostReason;
      }

      if (isTerminal(sc.to)) {
        updatePayload.closed_at = performedAt;
        if (input.performedBy) {
          updatePayload.closing_owner_id = input.performedBy;
        }
        if (sc.closingRole) {
          updatePayload.closing_role = sc.closingRole;
        }
      } else if (sc.from === "Lost" && sc.to === "Assigned_Not_Contacted") {
        // Reactivation (BRD §0.9) — clear terminal residue.
        updatePayload.closed_at = null;
        updatePayload.closing_owner_id = null;
        updatePayload.closing_role = null;
      }

      await tx
        .update(dealerLeads)
        .set(updatePayload)
        .where(eq(dealerLeads.id, input.dealerLeadId));
    } else {
      // 3. No status change — still bump last_touchpoint_at so stale-lead
      //    visual cues (BRD §0.5) reset.
      await tx
        .update(dealerLeads)
        .set({
          last_touchpoint_at: performedAt,
          updated_at: performedAt,
        })
        .where(eq(dealerLeads.id, input.dealerLeadId));
    }

    return {
      touchpointId: touchpoint!.touchpoint_id,
      historyId,
    };
  };

  return opts?.tx ? run(opts.tx) : db.transaction(run);
}
