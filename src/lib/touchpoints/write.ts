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
//   3. UPDATE dealer_leads.last_touchpoint_at + updated_at, and last_worked_at
//      when the touchpoint is real work (E-300, isWorkedTouchpoint).
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
import {
  isWorkedTouchpoint,
  type CallStatus,
  type NextAction,
  type TouchpointType,
} from "@/lib/lifecycle/touchpointTypes";
import type { LeadStatus, LostReason } from "@/lib/lifecycle/transitions";
import { isTerminal } from "@/lib/lifecycle/transitions";
import { checkStatusMove, type StatusEvent } from "@/lib/lifecycle/statusRules";
import type { Interest } from "@/lib/leads/autoProgress";
import { planOutcome, type TouchpointOutcome } from "@/lib/leads/outcomeRule";
import { setInterestLevel } from "@/lib/leads/interestLevel";

/**
 * A status move the S3 rules refuse (statusRules.ts). Carries an HTTP status so
 * withErrorHandler answers 409 with the sentence instead of a 500.
 */
export class StatusGuardError extends Error {
  readonly status = 409;
  constructor(reason: string) {
    super(reason);
    this.name = "StatusGuardError";
  }
}

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
  /**
   * What caused the move (statusRules.ts). Defaults to "progress": an ordinary
   * touchpoint, forward only. The writer checks it against the lead's status as
   * read INSIDE this transaction — `from` above is only the caller's view.
   */
  event?: StatusEvent;
  /**
   * An admin-driven move (ID 115.4): lets `mark_lost` take a Won lead to Lost.
   * Only the admin onboarding drop-out resolution passes it.
   */
  adminOverride?: boolean;
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
  /**
   * ID 114 — what the call or visit came to. When set, the writer derives the
   * status move and the temperature from it (outcomeRule.ts) against the lead
   * row it has locked, so every entry point applies the same rule. An explicit
   * `statusChange` still wins; without `outcome` (and `interest`) nothing is
   * derived and the write is exactly what it was before.
   */
  outcome?: TouchpointOutcome;
  /**
   * Temperature to save with this touchpoint, in the same transaction:
   * a level = the rep stated it; null = leave it as it is; undefined (absent)
   * = derive it from `outcome`, where the owned-lead rule allows (P0-10).
   * Written through setInterestLevel, so it is audited like a manual change.
   */
  interest?: Interest | null;
  /** Audit reason for the temperature change. */
  interestReason?: string | null;
  /**
   * E-295 — the ownership hop this touchpoint records, for Lead Tracking.
   *
   * `fromOwnerId` is the dealer_leads.current_owner_id BEFORE the write (null =
   * the lead was unassigned), `toOwnerId` the owner AFTER it (null = released
   * to the pool). Pass BOTH whenever the call changed hands — assignOwner,
   * claim, reassign, transfer-asm, escalation reassign, reactivation — and
   * NEITHER otherwise. `performed_by` stays the ACTOR (the admin who
   * reassigned), which is not the same person as the recipient; that
   * distinction is the whole reason these columns exist.
   *
   * Like the E-236 disposition, the columns are NOT in schema.ts (see its
   * header) and are written by a raw UPDATE inside this transaction, emitted
   * ONLY when at least one of the two is set. A host without E-295 therefore
   * fails ownership writes and nothing else — the checklist marks the
   * migration as required before deploy.
   */
  fromOwnerId?: string | null;
  toOwnerId?: string | null;
  /**
   * The idle clock (last_worked_at), tri-state:
   *   undefined — the default rule (isWorkedTouchpoint on type + status move);
   *   true      — force it for a type that is not work by default (ID 79: a
   *               WhatsApp reply proven by a screenshot is work);
   *   false     — never stamp it, even for a type or status move that would
   *               count (ID 115.5): system events — a dealer's quote decision,
   *               onboarding approval, admin corrections, backfill scripts —
   *               are not the owner's work and must not reset the idle clock.
   */
  countsAsWork?: boolean;
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

/** dealer_leads as read FOR UPDATE at the top of the write. */
type LockedLead = {
  lead_status: string | null;
  current_owner_id: string | null;
  interest_level: string | null;
  pre_transfer_status: string | null;
  interest_changed_at: string | null;
} & Record<string, unknown>;

export async function writeTouchpoint(
  input: WriteTouchpointInput,
  opts?: { tx?: Tx },
): Promise<WriteTouchpointResult> {
  const performedAt = input.performedAt ?? new Date();
  const wantsOutcome = input.outcome !== undefined || input.interest !== undefined;

  const run = async (tx: Tx): Promise<WriteTouchpointResult> => {
    // 0. The lead as it is NOW, locked for this transaction. The S3 guard
    //    (ID 115) checks a status move against this row — never the caller's
    //    possibly stale `from` — and the outcome rule (ID 114) derives from it.
    //    Read only when there is a move to check or an outcome to apply; the
    //    E-301 column goes through to_jsonb so a database without it reads null.
    let statusChange = input.statusChange;
    let interestTo: Interest | null = null;
    let current: LockedLead | undefined;
    if (statusChange || wantsOutcome) {
      const rows = await tx.execute<LockedLead>(sql`
        SELECT lead_status, current_owner_id, interest_level, pre_transfer_status,
               ${wantsOutcome ? sql`to_jsonb(dealer_leads) ->> 'interest_changed_at'` : sql`NULL::text`} AS interest_changed_at
          FROM dealer_leads WHERE id = ${input.dealerLeadId}
         FOR UPDATE
      `);
      current = (rows as unknown as LockedLead[])[0];
    }
    if (current && wantsOutcome) {
      const plan = planOutcome({
        outcome: input.outcome,
        hasExplicitStatus: !!statusChange,
        interest: input.interest,
        actorId: input.performedBy,
        performedAt,
        lead: {
          status: current.lead_status,
          interest: current.interest_level,
          preTransferStatus: current.pre_transfer_status,
          ownerId: current.current_owner_id,
          interestChangedAt: current.interest_changed_at ? new Date(current.interest_changed_at) : null,
        },
      });
      if (plan.statusTo) {
        statusChange = {
          from: current.lead_status as LeadStatus | null,
          to: plan.statusTo,
          event: plan.event,
        };
      }
      interestTo = plan.interestTo;
    }

    // S3 guard (ID 115), against the row locked in step 0 — BEFORE anything is
    // written. A same-status move is a no-op (ID 115.6): the touchpoint is still
    // recorded, the move and its history row are skipped.
    const fromStatus = current?.lead_status ?? null;
    if (statusChange) {
      const verdict = checkStatusMove({
        from: fromStatus,
        to: statusChange.to,
        event: statusChange.event ?? "progress",
        reason: statusChange.reasonNotes,
        adminOverride: statusChange.adminOverride,
      });
      if (!verdict.ok) throw new StatusGuardError(verdict.reason);
      if (verdict.noop) statusChange = undefined;
    }

    // E-300 — the idle clock moves only for work (isWorkedTouchpoint), and only
    // forward: a visit logged today for last week must not rewind a call made
    // yesterday. GREATEST ignores the NULL of a never-worked lead.
    const workedStamp = input.countsAsWork !== false &&
      (input.countsAsWork === true || isWorkedTouchpoint(input.touchpointType, !!statusChange))
      ? {
          last_worked_at: sql`GREATEST(${dealerLeads.last_worked_at}, ${performedAt.toISOString()}::timestamptz)`,
        }
      : {};

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

    // 1c. E-295 ownership hop — who held the lead before and after this
    //     touchpoint. Raw for the same reason as 1b.
    if (input.fromOwnerId !== undefined || input.toOwnerId !== undefined) {
      await tx.execute(sql`
        UPDATE lead_touchpoints
           SET from_owner_id = ${input.fromOwnerId ?? null},
               to_owner_id   = ${input.toOwnerId ?? null}
         WHERE touchpoint_id = ${touchpoint!.touchpoint_id}::uuid
      `);
    }

    let historyId: string | null = null;

    // 2. Status change — both audit row and the dealer_leads update happen
    //    in the same transaction so we can never have an updated status
    //    without a history row.
    if (statusChange) {
      const sc = statusChange;

      const [history] = await tx
        .insert(dealerLeadStatusHistory)
        .values({
          dealer_lead_id: input.dealerLeadId,
          from_status: fromStatus,
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
        ...workedStamp,
        updated_at: performedAt,
      };

      if (sc.toLostReason !== undefined) {
        updatePayload.lost_reason = sc.toLostReason;
      }

      // ID 117: credit goes to the OWNER who closed it, not whoever pressed
      // the button (an admin marking a rep's lead). The actor is the fallback
      // for an unowned lead.
      const closer = current?.current_owner_id ?? input.performedBy;
      if (sc.to === "Won") {
        // ID 74: Mark Won records the closing owner; Converted (onboarding
        // approved) later keeps it, so a reassignment in between never moves
        // the credit.
        if (fromStatus === "Converted") {
          // A correction back from Converted (onboarding not approved after
          // all): the lead is open again, and whoever closed it keeps the
          // credit — not whoever happens to own it today.
          updatePayload.closed_at = null;
          if (closer) {
            updatePayload.closing_owner_id = sql`COALESCE(${dealerLeads.closing_owner_id}, ${closer})`;
          }
        } else {
          if (fromStatus === "Lost") {
            updatePayload.closed_at = null;
            if (sc.toLostReason === undefined) updatePayload.lost_reason = null;
          }
          if (closer) updatePayload.closing_owner_id = closer;
        }
        if (sc.closingRole) updatePayload.closing_role = sc.closingRole;
      } else if (sc.to === "Converted") {
        updatePayload.closed_at = performedAt;
        updatePayload.closing_owner_id = sql`COALESCE(${dealerLeads.closing_owner_id}, ${closer})`;
        if (sc.closingRole) {
          updatePayload.closing_role = sql`COALESCE(${dealerLeads.closing_role}, ${sc.closingRole})`;
        }
      } else if (isTerminal(sc.to)) {
        updatePayload.closed_at = performedAt;
        if (closer) {
          updatePayload.closing_owner_id = closer;
        }
        if (sc.closingRole) {
          updatePayload.closing_role = sc.closingRole;
        }
      } else if (fromStatus && (isTerminal(fromStatus as LeadStatus) || fromStatus === "Won")) {
        // Leaving Converted / Lost (reactivation, correction) — clear the
        // terminal residue so the lead is not still counted as closed.
        updatePayload.closed_at = null;
        updatePayload.closing_owner_id = null;
        updatePayload.closing_role = null;
        if (sc.toLostReason === undefined) updatePayload.lost_reason = null;
      }

      await tx
        .update(dealerLeads)
        .set(updatePayload)
        .where(eq(dealerLeads.id, input.dealerLeadId));

      // E-314 (not in schema.ts): when the lead was won. Raw, and only on the
      // Won path, so hosts without E-314 fail Mark Won and nothing else.
      if (sc.to === "Won") {
        await tx.execute(sql`
          UPDATE dealer_leads SET won_at = ${performedAt.toISOString()}::timestamptz
           WHERE id = ${input.dealerLeadId}
        `);
      }
    } else {
      // 3. No status change — still bump last_touchpoint_at ("last activity");
      //    the idle clock (last_worked_at) moves only for real work.
      await tx
        .update(dealerLeads)
        .set({
          last_touchpoint_at: performedAt,
          ...workedStamp,
          updated_at: performedAt,
        })
        .where(eq(dealerLeads.id, input.dealerLeadId));
    }

    // 4. Temperature (ID 114) — same transaction, audited like a manual
    //    change (interest_level_overrides + the E-304 history trigger).
    if (interestTo && input.performedBy) {
      await setInterestLevel(
        {
          leadId: input.dealerLeadId,
          actorId: input.performedBy,
          level: interestTo,
          reason: input.interestReason ?? "Auto: from the logged outcome",
        },
        { tx },
      );
    }

    return {
      touchpointId: touchpoint!.touchpoint_id,
      historyId,
    };
  };

  return opts?.tx ? run(opts.tx) : db.transaction(run);
}
