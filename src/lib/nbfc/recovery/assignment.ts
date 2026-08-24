/**
 * E-262 — the recovery assignment state machine.
 *
 * One row per attempt to collect one flagged battery:
 *
 *   assigned ──dispatch ok──> in_progress ──agent submits──> collected
 *      │                           │                             │
 *      └──────────── cancel ───────┴────────── cancel ───────────┤
 *                                                                ├─ approve ─> completed
 *                                                                └─ reject ──> rejected
 *
 * `assigned` and `in_progress` are not two names for the same thing. A row is
 * written BEFORE the link is dispatched, so a bounced email cannot lose an
 * assignment that already exists — it leaves it at `assigned` with the failure
 * recorded, and Resend is the way out. `in_progress` means a wire confirmed
 * delivery. Without the split, a queue cannot tell an agent who never heard
 * from us apart from one who simply has not set off.
 *
 * CANCELLING IS NOT UNFLAGGING. `unflagLoanForRecovery` withdraws the NBFC's
 * decision to recover; this withdraws one attempt at the physical job. They are
 * different facts, they have different guards, and the EMI hook calls this one:
 * an unflag would throw the moment anything physical existed, which is exactly
 * when standing an agent down matters most.
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  dealers,
  leads,
  loanSanctions,
  nbfcAuditLog,
  nbfcRecoveryPipeline,
  nbfcTenants,
  recoveryAssignmentPhotos,
  recoveryAssignments,
  recoveryBatteries,
  recoveryVisitAttempts,
} from "@/lib/db/schema";
import { getRecoveryAgent, type RecoveryChannel } from "@/lib/nbfc/recovery/agents";
import {
  dispatchRecoveryCancellation,
  dispatchRecoveryLink,
} from "@/lib/nbfc/recovery/dispatch";
import { geocodeAddress, haversineMeters } from "@/lib/nbfc/fi";
import { notifyRecoveryEvent } from "@/lib/notifications/events";
import {
  attachBatteryPhotos,
  createRecoveryBattery,
} from "@/lib/nbfc/recovery/battery";

export type RecoveryAssignment = typeof recoveryAssignments.$inferSelect;
export type RecoveryAssignmentPhoto = typeof recoveryAssignmentPhotos.$inferSelect;

/** Statuses in which an assignment is still somebody's problem. */
export const OPEN_ASSIGNMENT_STATUSES = [
  "assigned",
  "in_progress",
  "collected",
] as const;

/** Statuses in which the collection link still opens. */
export const LIVE_LINK_STATUSES = ["assigned", "in_progress"] as const;

/**
 * How long a collection link stays good.
 *
 * FI ties its expiry to a 48-hour SLA. Recovery has no such clock — a
 * repossession is scheduled around the agent's route and the borrower being
 * home — so this is a deliberate choice rather than a derived one. Seven days
 * is long enough to be practical and short enough that a link found in an old
 * inbox is dead.
 */
export const LINK_TTL_DAYS = 7;

export function linkExpiryFrom(from: Date): Date {
  return new Date(from.getTime() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** Single-use link token. Same generator FI uses; 48 hex into varchar(80). */
export function generateRecoveryLinkToken(): string {
  return randomBytes(24).toString("hex");
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The live attempt for a loan, or null. Tenant-scoped. */
export async function getCurrentAssignment(
  tenantId: string,
  loanSanctionId: string,
): Promise<RecoveryAssignment | null> {
  const rows = await db
    .select()
    .from(recoveryAssignments)
    .where(
      and(
        eq(recoveryAssignments.tenant_id, tenantId),
        eq(recoveryAssignments.loan_sanction_id, loanSanctionId),
        eq(recoveryAssignments.is_current, true),
      ),
    )
    .orderBy(desc(recoveryAssignments.created_at))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAssignment(
  tenantId: string,
  id: string,
): Promise<RecoveryAssignment | null> {
  const rows = await db
    .select()
    .from(recoveryAssignments)
    .where(
      and(
        eq(recoveryAssignments.id, id),
        eq(recoveryAssignments.tenant_id, tenantId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listAssignmentPhotos(
  assignmentId: string,
): Promise<RecoveryAssignmentPhoto[]> {
  return db
    .select()
    .from(recoveryAssignmentPhotos)
    .where(eq(recoveryAssignmentPhotos.assignment_id, assignmentId))
    .orderBy(recoveryAssignmentPhotos.uploaded_at);
}

/**
 * Why a token did not open a job.
 *
 * FI collapses invalid / expired / used / cancelled into one `null` and shows
 * one message. For a recovery agent that is not good enough: somebody told
 * "your link is broken" phones the office or knocks anyway, while somebody told
 * "this was cancelled, the borrower paid" goes home. So the resolver reports
 * WHICH, and the public page renders a different screen for each.
 */
export type TokenResolution =
  | { state: "ok"; assignment: RecoveryAssignment }
  | { state: "cancelled"; assignment: RecoveryAssignment }
  | { state: "completed"; assignment: RecoveryAssignment }
  | { state: "expired"; assignment: RecoveryAssignment }
  | { state: "unknown" };

export async function resolveAssignmentByToken(
  token: string,
): Promise<TokenResolution> {
  if (!token) return { state: "unknown" };
  const rows = await db
    .select()
    .from(recoveryAssignments)
    .where(eq(recoveryAssignments.link_token, token))
    .limit(1);
  const row = rows[0];

  // A consumed token is nulled on the row, so a submitted job cannot be found
  // by it any more. Fall back to the loan's current attempt only for the
  // messages — never to authorise anything.
  if (!row) return { state: "unknown" };

  if (row.status === "cancelled") return { state: "cancelled", assignment: row };
  if (row.status === "completed" || row.status === "collected") {
    return { state: "completed", assignment: row };
  }
  if (!(LIVE_LINK_STATUSES as readonly string[]).includes(row.status)) {
    return { state: "unknown" };
  }
  if (
    row.link_expires_at &&
    new Date(row.link_expires_at).getTime() < Date.now()
  ) {
    return { state: "expired", assignment: row };
  }
  return { state: "ok", assignment: row };
}

// ---------------------------------------------------------------------------
// The borrower context an agent and a reviewer both need
// ---------------------------------------------------------------------------

export interface LoanContext {
  loan_sanction_id: string;
  tenant_id: string;
  borrower_name: string;
  borrower_phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  dealer_name: string | null;
  battery_serial: string | null;
  battery_id: string | null;
  recovery_pipeline_id: string | null;
  pipeline_stage: string | null;
  battery_state: string | null;
  recovery_flagged_at: Date | null;
  nbfc_name: string | null;
}

export async function loadLoanContext(
  tenantId: string,
  loanSanctionId: string,
): Promise<LoanContext | null> {
  const [row] = await db
    .select({
      id: loanSanctions.id,
      nbfc_id: loanSanctions.nbfc_id,
      recovery_flagged_at: loanSanctions.recovery_flagged_at,
      borrower_name: sql<
        string | null
      >`coalesce(${leads.full_name}, ${leads.owner_name})`,
      borrower_phone: sql<
        string | null
      >`coalesce(${leads.mobile}, ${leads.phone}, ${leads.owner_contact})`,
      address: sql<
        string | null
      >`coalesce(${leads.current_address}, ${leads.permanent_address}, ${leads.local_address})`,
      city: leads.city,
      state: leads.state,
      dealer_name: dealers.company_name,
    })
    .from(loanSanctions)
    .leftJoin(leads, eq(leads.id, loanSanctions.lead_id))
    .leftJoin(dealers, eq(dealers.dealer_id, leads.dealer_id))
    .where(eq(loanSanctions.id, loanSanctionId))
    .limit(1);

  if (!row) return null;
  if (row.nbfc_id && row.nbfc_id !== tenantId) return null;

  const [battery] = await db
    .select({
      id: recoveryBatteries.id,
      serial: recoveryBatteries.serial,
      state_code: recoveryBatteries.state_code,
      recovery_pipeline_id: recoveryBatteries.recovery_pipeline_id,
    })
    .from(recoveryBatteries)
    .where(
      and(
        eq(recoveryBatteries.tenant_id, tenantId),
        eq(recoveryBatteries.loan_sanction_id, loanSanctionId),
      ),
    )
    .limit(1);

  // The pipeline row is keyed on the serial — including the `LOAN-<id>`
  // placeholder the flag invents when no serial was known.
  const serialCandidates = [battery?.serial, `LOAN-${loanSanctionId}`].filter(
    (s): s is string => !!s,
  );
  const [pipeline] = await db
    .select({
      id: nbfcRecoveryPipeline.id,
      stage: nbfcRecoveryPipeline.stage,
    })
    .from(nbfcRecoveryPipeline)
    .where(
      and(
        eq(nbfcRecoveryPipeline.tenant_id, tenantId),
        inArray(nbfcRecoveryPipeline.battery_serial, serialCandidates),
      ),
    )
    .limit(1);

  const [tenant] = await db
    .select({ display_name: nbfcTenants.display_name })
    .from(nbfcTenants)
    .where(eq(nbfcTenants.id, tenantId))
    .limit(1);

  return {
    loan_sanction_id: row.id,
    tenant_id: tenantId,
    borrower_name: row.borrower_name ?? "the borrower",
    borrower_phone: row.borrower_phone ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    dealer_name: row.dealer_name ?? null,
    battery_serial: battery?.serial ?? null,
    battery_id: battery?.id ?? null,
    recovery_pipeline_id: pipeline?.id ?? battery?.recovery_pipeline_id ?? null,
    pipeline_stage: pipeline?.stage ?? null,
    battery_state: battery?.state_code ?? null,
    recovery_flagged_at: row.recovery_flagged_at ?? null,
    nbfc_name: tenant?.display_name ?? null,
  };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * The same "recovery has physically started" test `unflagLoanForRecovery` runs,
 * asked of an assignment instead of a flag. Once a battery has been inspected,
 * booked into a workshop or put on a lot, sending somebody to collect it is not
 * a dispatch, it is a mistake.
 */
const DISPATCHABLE_PIPELINE_STAGE = "needs_inspection";
const DISPATCHABLE_BATTERY_STATES = ["draft", "intaken"] as const;

function assertDispatchable(ctx: LoanContext): void {
  if (!ctx.recovery_flagged_at) {
    throw new Error(
      "CONFLICT: this loan is not flagged for recovery — flag it before dispatching an agent",
    );
  }
  if (ctx.pipeline_stage && ctx.pipeline_stage !== DISPATCHABLE_PIPELINE_STAGE) {
    throw new Error(
      `CONFLICT: recovery has already progressed to '${ctx.pipeline_stage}' — there is nothing left to collect`,
    );
  }
  if (
    ctx.battery_state &&
    !(DISPATCHABLE_BATTERY_STATES as readonly string[]).includes(ctx.battery_state)
  ) {
    throw new Error(
      `CONFLICT: battery ${ctx.battery_serial ?? ""} is already '${ctx.battery_state}' in the recovery register — it is not out with the borrower`,
    );
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * `nbfc_audit_log`, not the shared `audit_logs` — this is the tenant-scoped
 * immutable feed the NBFC's own Audit Log screen reads. `action_type` is
 * varchar(32), so every code here stays well under it.
 */
async function writeAudit(
  executor: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    tenant_id: string;
    user_id: string | null;
    action_type: string;
    action_id: string;
    before_state?: Record<string, unknown>;
    after_state?: Record<string, unknown>;
  },
): Promise<void> {
  await executor.insert(nbfcAuditLog).values({
    tenant_id: input.tenant_id,
    // The column is NOT NULL, and a system-initiated cancellation has no human
    // behind it. The all-zero uuid is the same sentinel applyEmiPayment uses.
    user_id: input.user_id ?? "00000000-0000-0000-0000-000000000000",
    action_type: input.action_type,
    action_id: input.action_id,
    before_state: input.before_state ?? {},
    after_state: input.after_state ?? {},
  });
}

// ---------------------------------------------------------------------------
// Assign
// ---------------------------------------------------------------------------

export interface AssignInput {
  tenant_id: string;
  actor_user_id: string | null;
  loan_sanction_id: string;
  agent_id: string;
  due_at?: Date | null;
  channel?: RecoveryChannel;
  /** Absolute base for the agent's link, e.g. https://app.itarang.com */
  origin: string;
}

export interface AssignResult {
  assignment: RecoveryAssignment;
  dispatch_ok: boolean;
  dispatch_channel: RecoveryChannel | null;
  dispatch_error?: string;
  link_url: string;
}

export function buildAgentLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/recovery-agent/${token}`;
}

export async function assignRecoveryAgent(
  input: AssignInput,
): Promise<AssignResult> {
  const ctx = await loadLoanContext(input.tenant_id, input.loan_sanction_id);
  if (!ctx) throw new Error("NOT_FOUND: loan not found for this NBFC");
  assertDispatchable(ctx);

  const open = await getCurrentAssignment(input.tenant_id, input.loan_sanction_id);
  if (open && (OPEN_ASSIGNMENT_STATUSES as readonly string[]).includes(open.status)) {
    throw new Error(
      `CONFLICT: ${open.agent_name ?? "an agent"} is already assigned to this battery (${open.status}) — cancel or reassign first`,
    );
  }

  const agent = await getRecoveryAgent(input.agent_id, input.tenant_id);
  if (!agent) throw new Error("NOT_FOUND: recovery agent not found");
  if (!agent.active) {
    throw new Error(`CONFLICT: ${agent.name} is deactivated in the agent directory`);
  }

  const now = new Date();
  const token = generateRecoveryLinkToken();
  const expiresAt = linkExpiryFrom(now);
  // Best-effort: returns null with no geocoding key and never throws. A null
  // anchor means the review panel says "address not geocoded" rather than
  // rendering a distance nobody can compute.
  const geo = await geocodeAddress(ctx.address);

  const attemptNo = open ? (open.attempt_no ?? 1) + 1 : 1;

  // Row first, dispatch second. A bounced email must not lose an assignment.
  const [created] = await db
    .insert(recoveryAssignments)
    .values({
      tenant_id: input.tenant_id,
      loan_sanction_id: input.loan_sanction_id,
      recovery_pipeline_id: ctx.recovery_pipeline_id,
      battery_id: ctx.battery_id,
      battery_serial: ctx.battery_serial,
      attempt_no: attemptNo,
      is_current: true,
      status: "assigned",
      agent_id: agent.id,
      agent_name: agent.name,
      agent_phone: agent.phone,
      assigned_by: input.actor_user_id,
      assigned_at: now,
      due_at: input.due_at ?? null,
      link_token: token,
      link_expires_at: expiresAt,
      stated_lat: geo ? String(geo.lat) : null,
      stated_lng: geo ? String(geo.lng) : null,
      created_at: now,
      updated_at: now,
    })
    .returning();

  await writeAudit(db, {
    tenant_id: input.tenant_id,
    user_id: input.actor_user_id,
    action_type: "recovery_assign",
    action_id: created.id,
    before_state: { loan_sanction_id: input.loan_sanction_id },
    after_state: {
      agent_id: agent.id,
      agent_name: agent.name,
      attempt_no: attemptNo,
      battery_serial: ctx.battery_serial,
      expires_at: expiresAt.toISOString(),
    },
  });

  const url = buildAgentLink(input.origin, token);
  const sent = await dispatchRecoveryLink({
    agent,
    url,
    borrowerName: ctx.borrower_name,
    borrowerPhone: ctx.borrower_phone,
    address: ctx.address,
    city: ctx.city,
    batterySerial: ctx.battery_serial,
    expiresAt,
    nbfcName: ctx.nbfc_name,
    channel: input.channel,
  });

  const [final] = await db
    .update(recoveryAssignments)
    .set(
      sent.ok
        ? {
            status: "in_progress",
            link_sent_at: new Date(),
            link_channel: sent.channel,
            dispatch_error: null,
            updated_at: new Date(),
          }
        : { dispatch_error: sent.error ?? "dispatch failed", updated_at: new Date() },
    )
    .where(eq(recoveryAssignments.id, created.id))
    .returning();

  return {
    assignment: final,
    dispatch_ok: sent.ok,
    dispatch_channel: sent.channel,
    dispatch_error: sent.error,
    link_url: url,
  };
}

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

export async function resendRecoveryLink(input: {
  tenant_id: string;
  actor_user_id: string | null;
  assignment_id: string;
  channel?: RecoveryChannel;
  origin: string;
}): Promise<AssignResult> {
  const row = await getAssignment(input.tenant_id, input.assignment_id);
  if (!row) throw new Error("NOT_FOUND: assignment not found");
  if (!(LIVE_LINK_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(
      `CONFLICT: this assignment is ${row.status} — there is no live link to resend`,
    );
  }
  if (!row.agent_id) throw new Error("CONFLICT: this assignment has no agent");

  const agent = await getRecoveryAgent(row.agent_id, input.tenant_id);
  if (!agent) throw new Error("NOT_FOUND: recovery agent not found");

  const ctx = await loadLoanContext(input.tenant_id, row.loan_sanction_id);
  if (!ctx) throw new Error("NOT_FOUND: loan not found for this NBFC");

  // A NEW token and a NEW window. FI reuses the original deadline here, which
  // means a link resent an hour before it lapses is dead on arrival — the agent
  // asked for a working link, not a copy of a dying one.
  const now = new Date();
  const token = generateRecoveryLinkToken();
  const expiresAt = linkExpiryFrom(now);

  await db
    .update(recoveryAssignments)
    .set({ link_token: token, link_expires_at: expiresAt, updated_at: now })
    .where(eq(recoveryAssignments.id, row.id));

  const url = buildAgentLink(input.origin, token);
  const sent = await dispatchRecoveryLink({
    agent,
    url,
    borrowerName: ctx.borrower_name,
    borrowerPhone: ctx.borrower_phone,
    address: ctx.address,
    city: ctx.city,
    batterySerial: row.battery_serial ?? ctx.battery_serial,
    expiresAt,
    nbfcName: ctx.nbfc_name,
    resend: true,
    channel: input.channel,
  });

  const [final] = await db
    .update(recoveryAssignments)
    .set(
      sent.ok
        ? {
            status: "in_progress",
            link_sent_at: new Date(),
            link_channel: sent.channel,
            dispatch_error: null,
            updated_at: new Date(),
          }
        : { dispatch_error: sent.error ?? "dispatch failed", updated_at: new Date() },
    )
    .where(eq(recoveryAssignments.id, row.id))
    .returning();

  await writeAudit(db, {
    tenant_id: input.tenant_id,
    user_id: input.actor_user_id,
    action_type: "recovery_resend",
    action_id: row.id,
    after_state: { channel: sent.channel, ok: sent.ok, expires_at: expiresAt.toISOString() },
  });

  return {
    assignment: final,
    dispatch_ok: sent.ok,
    dispatch_channel: sent.channel,
    dispatch_error: sent.error,
    link_url: url,
  };
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export type CancelSource = "manual" | "emi_payment" | "reassigned";

export interface CancelResult {
  cancelled: boolean;
  assignment: RecoveryAssignment | null;
  notified: boolean;
  notify_error?: string;
}

/**
 * Stands an agent down. Idempotent, and it does not throw: this is called from
 * the EMI payment path, where a failure here must never fail a payment.
 *
 * The token is nulled and the row is KEPT, so `/recovery-agent/<token>` can
 * tell the agent the job was cancelled rather than that their link is broken.
 * The message goes out AFTER the commit — an agent who is told not to collect
 * a battery that was never actually stood down is the one outcome worse than
 * silence.
 */
export async function cancelRecoveryAssignment(input: {
  tenant_id: string;
  actor_user_id: string | null;
  /** Either identifies the assignment; loan_sanction_id resolves the live one. */
  assignment_id?: string;
  loan_sanction_id?: string;
  reason: string;
  source: CancelSource;
}): Promise<CancelResult> {
  const row = input.assignment_id
    ? await getAssignment(input.tenant_id, input.assignment_id)
    : input.loan_sanction_id
      ? await getCurrentAssignment(input.tenant_id, input.loan_sanction_id)
      : null;

  if (!row) return { cancelled: false, assignment: null, notified: false };
  if (!(OPEN_ASSIGNMENT_STATUSES as readonly string[]).includes(row.status)) {
    // Already cancelled, completed or rejected. Saying "no" quietly is right:
    // a replayed webhook must not send a second "do not collect".
    return { cancelled: false, assignment: row, notified: false };
  }

  const now = new Date();
  // The status predicate is in the WHERE, not just the read above — a replayed
  // webhook and a coordinator clicking Cancel can race, and only one of them
  // should get a row back to notify on.
  const [updated] = await db
    .update(recoveryAssignments)
    .set({
      status: "cancelled",
      is_current: false,
      link_token: null,
      cancelled_at: now,
      cancelled_by: input.actor_user_id,
      cancel_reason: input.reason,
      cancel_source: input.source,
      updated_at: now,
    })
    .where(
      and(
        eq(recoveryAssignments.id, row.id),
        inArray(recoveryAssignments.status, [...OPEN_ASSIGNMENT_STATUSES]),
      ),
    )
    .returning();

  if (!updated) return { cancelled: false, assignment: row, notified: false };

  await writeAudit(db, {
    tenant_id: input.tenant_id,
    user_id: input.actor_user_id,
    action_type: "recovery_cancel",
    action_id: updated.id,
    before_state: { status: row.status, agent_name: row.agent_name },
    after_state: { status: "cancelled", source: input.source, reason: input.reason },
  });

  // Told after the commit. Never throws — see the header.
  let notified = false;
  let notifyError: string | undefined;
  try {
    const agent = updated.agent_id
      ? await getRecoveryAgent(updated.agent_id, input.tenant_id)
      : null;
    if (agent) {
      const ctx = await loadLoanContext(input.tenant_id, updated.loan_sanction_id);
      const res = await dispatchRecoveryCancellation({
        agent,
        borrowerName: ctx?.borrower_name ?? "the borrower",
        city: ctx?.city ?? null,
        batterySerial: updated.battery_serial,
        source: input.source,
        reason: input.reason,
        nbfcName: ctx?.nbfc_name ?? null,
        channel: (updated.link_channel as RecoveryChannel) || undefined,
      });
      notified = res.ok;
      notifyError = res.error;

      // The portal-side notice. Worth sending mainly when the SYSTEM stood the
      // agent down — an operator who clicked Cancel already knows, but nobody
      // is watching when an EMI payment does it at 2am.
      if (input.source !== "manual") {
        await notifyRecoveryEvent({
          tenantId: input.tenant_id,
          nbfcName: ctx?.nbfc_name ?? "Your NBFC",
          event: "cancelled",
          borrowerName: ctx?.borrower_name ?? "the borrower",
          agentName: updated.agent_name,
          batterySerial: updated.battery_serial,
          reason: input.reason,
          cause:
            input.source === "emi_payment"
              ? "the borrower cleared their arrears"
              : "the job was handed to another agent",
        });
      }
    }
  } catch (e) {
    notifyError = e instanceof Error ? e.message : String(e);
  }

  return { cancelled: true, assignment: updated, notified, notify_error: notifyError };
}

// ---------------------------------------------------------------------------
// Submit — what the agent recorded at the address
// ---------------------------------------------------------------------------

export interface SubmittedPhoto {
  photo_type: string;
  image_url: string;
  watermark_applied: boolean;
}

export interface SubmitCollectionInput {
  /** The row already resolved from the token by the public route. */
  assignment: RecoveryAssignment;
  gps_lat: number;
  gps_lng: number;
  gps_accuracy_m: number | null;
  battery_serial?: string | null;
  condition_notes?: string | null;
  photos: SubmittedPhoto[];
}

/**
 * Marks a collection done and consumes the token.
 *
 * The token is nulled in the SAME statement as the status flip. That is not
 * tidiness: the agent's phone auto-retries a failed submit, so a token consumed
 * before the write commits would lock them out with the photographs still on
 * the handset and no way back in.
 *
 * Photos upsert against the partial unique index on (assignment_id,
 * photo_type), so a retry after a partial success overwrites the slot rather
 * than adding a second row for the same shot. `extra` is exempt from that index
 * — extras are a bag, not a slot — so they are plain inserts.
 */
export async function submitRecoveryCollection(
  input: SubmitCollectionInput,
): Promise<RecoveryAssignment> {
  const row = input.assignment;
  const now = new Date();

  let distance: number | null = null;
  if (row.stated_lat != null && row.stated_lng != null) {
    distance = haversineMeters(
      input.gps_lat,
      input.gps_lng,
      Number(row.stated_lat),
      Number(row.stated_lng),
    );
  }

  const updated = await db.transaction(async (tx) => {
    for (const p of input.photos) {
      const values = {
        assignment_id: row.id,
        photo_type: p.photo_type,
        image_url: p.image_url,
        gps_lat: String(input.gps_lat),
        gps_lng: String(input.gps_lng),
        gps_server_timestamp: now,
        watermark_applied: p.watermark_applied,
        uploaded_at: now,
      };
      if (p.photo_type === "extra") {
        await tx.insert(recoveryAssignmentPhotos).values(values);
        continue;
      }
      await tx
        .insert(recoveryAssignmentPhotos)
        .values(values)
        .onConflictDoUpdate({
          target: [
            recoveryAssignmentPhotos.assignment_id,
            recoveryAssignmentPhotos.photo_type,
          ],
          targetWhere: sql`photo_type <> 'extra'`,
          set: {
            image_url: p.image_url,
            gps_lat: String(input.gps_lat),
            gps_lng: String(input.gps_lng),
            gps_server_timestamp: now,
            watermark_applied: p.watermark_applied,
            uploaded_at: now,
          },
        });
    }

    const [done] = await tx
      .update(recoveryAssignments)
      .set({
        status: "collected",
        collected_at: now,
        gps_lat: String(input.gps_lat),
        gps_lng: String(input.gps_lng),
        gps_accuracy_m:
          input.gps_accuracy_m != null ? String(input.gps_accuracy_m) : null,
        gps_server_timestamp: now,
        distance_from_address_m: distance != null ? String(distance) : null,
        condition_notes: input.condition_notes ?? null,
        agent_declaration_at: now,
        // The agent is the one holding the battery, so their serial wins when
        // the assignment was created without one.
        battery_serial: input.battery_serial?.trim() || row.battery_serial,
        // Consumed HERE, with the flip. See the note above.
        link_token: null,
        updated_at: now,
      })
      .where(
        and(
          eq(recoveryAssignments.id, row.id),
          inArray(recoveryAssignments.status, [...LIVE_LINK_STATUSES]),
        ),
      )
      .returning();

    if (!done) {
      throw new Error("CONFLICT: this collection was already submitted");
    }
    return done;
  });

  await writeAudit(db, {
    tenant_id: row.tenant_id,
    user_id: null,
    action_type: "recovery_collected",
    action_id: row.id,
    after_state: {
      agent_name: row.agent_name,
      battery_serial: updated.battery_serial,
      photos: input.photos.length,
      distance_from_address_m: distance,
      gps_accuracy_m: input.gps_accuracy_m,
    },
  });

  return updated;
}

/**
 * Review auto-flags — surfaced, NEVER auto-deciding. Ported from FI's
 * `computeFiAutoFlags`: the numbers differ (a battery is collected from a
 * street, not verified at a doorstep, so 500 m is the red line rather than 50)
 * but the question is the same — does this evidence look like somebody
 * actually stood there.
 */
export interface RecoveryAutoFlag {
  key: string;
  severity: "red" | "warn";
  label: string;
}

export function computeRecoveryAutoFlags(
  row: RecoveryAssignment,
  photos: RecoveryAssignmentPhoto[],
): RecoveryAutoFlag[] {
  const flags: RecoveryAutoFlag[] = [];

  const distance =
    row.distance_from_address_m != null ? Number(row.distance_from_address_m) : null;
  if (distance != null && distance > 500) {
    flags.push({
      key: "far_from_address",
      severity: "red",
      label: `Collected ${Math.round(distance)} m from the borrower's address`,
    });
  }

  const accuracy = row.gps_accuracy_m != null ? Number(row.gps_accuracy_m) : null;
  if (accuracy != null && accuracy > 100) {
    flags.push({
      key: "poor_gps",
      severity: "warn",
      label: `Location accurate only to ±${Math.round(accuracy)} m`,
    });
  }
  if (row.gps_lat == null || row.gps_lng == null) {
    flags.push({ key: "no_gps", severity: "red", label: "No location was recorded" });
  }
  if (row.stated_lat == null || row.stated_lng == null) {
    flags.push({
      key: "no_anchor",
      severity: "warn",
      label:
        "The borrower's address was never geocoded, so no distance could be computed",
    });
  }

  const unstamped = photos.filter((p) => !p.watermark_applied).length;
  if (unstamped > 0) {
    flags.push({
      key: "unwatermarked",
      severity: "warn",
      label: `${unstamped} photo${unstamped === 1 ? "" : "s"} could not be stamped with location and time`,
    });
  }
  if (photos.length === 0) {
    flags.push({
      key: "no_photos",
      severity: "red",
      label: "No photographs were uploaded",
    });
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Visit attempts — the journey that did not end in a battery  [E-263]
// ---------------------------------------------------------------------------

export type RecoveryVisitAttempt = typeof recoveryVisitAttempts.$inferSelect;

/**
 * Why a visit produced nothing.
 *
 * `collected` is deliberately absent: a successful collection is the
 * assignment's own terminal write, and a second record of the same fact is a
 * second thing to disagree with.
 */
export const VISIT_OUTCOMES = [
  "not_present",
  "refused",
  "address_not_found",
  "battery_missing",
  "other",
] as const;
export type VisitOutcome = (typeof VISIT_OUTCOMES)[number];

export const VISIT_OUTCOME_LABELS: Record<VisitOutcome, string> = {
  not_present: "Customer not present",
  refused: "Customer refused to hand it over",
  address_not_found: "Address could not be found",
  battery_missing: "Battery not at the address",
  other: "Other",
};

export async function listVisitAttempts(
  assignmentId: string,
): Promise<RecoveryVisitAttempt[]> {
  return db
    .select()
    .from(recoveryVisitAttempts)
    .where(eq(recoveryVisitAttempts.assignment_id, assignmentId))
    .orderBy(recoveryVisitAttempts.created_at);
}

export interface RecordVisitInput {
  /** Already resolved from the token by the public route. */
  assignment: RecoveryAssignment;
  outcome: VisitOutcome;
  gps_lat: number;
  gps_lng: number;
  gps_accuracy_m: number | null;
  notes?: string | null;
  /** When the agent will return. Null means they are not going back. */
  next_visit_at?: Date | null;
}

export interface RecordVisitResult {
  attempt: RecoveryVisitAttempt;
  assignment: RecoveryAssignment;
  /** True when the link's window had to be pushed out to cover the return. */
  link_extended: boolean;
}

/**
 * Logs a journey that did not produce a battery, and keeps the job open.
 *
 * THE TOKEN IS NOT CONSUMED. This is the whole difference between an attempt
 * and a collection: the agent is going back, on the same job, with the same
 * link. Only `submitRecoveryCollection` nulls the token.
 *
 * If the agreed return falls outside the link's window, the window moves to
 * cover it plus a day. A link that dies before the visit it was issued for is a
 * support call, not a security control.
 *
 * The assignment's own status stays `in_progress` — nothing about a locked door
 * changes who is responsible for this battery. What changes is that the NBFC
 * can now see the agent went, where they stood, and when they intend to return.
 */
export async function recordVisitAttempt(
  input: RecordVisitInput,
): Promise<RecordVisitResult> {
  const row = input.assignment;
  if (!(LIVE_LINK_STATUSES as readonly string[]).includes(row.status)) {
    throw new Error(
      `CONFLICT: this job is ${row.status} — there is nothing to report a visit against`,
    );
  }

  const now = new Date();

  let distance: number | null = null;
  if (row.stated_lat != null && row.stated_lng != null) {
    distance = haversineMeters(
      input.gps_lat,
      input.gps_lng,
      Number(row.stated_lat),
      Number(row.stated_lng),
    );
  }

  // The window has to outlive the appointment it was issued for.
  const nextVisit = input.next_visit_at ?? null;
  const currentExpiry = row.link_expires_at ? new Date(row.link_expires_at) : null;
  const needsExtension =
    nextVisit != null &&
    currentExpiry != null &&
    nextVisit.getTime() >= currentExpiry.getTime();
  const newExpiry = needsExtension
    ? new Date(nextVisit!.getTime() + 24 * 60 * 60 * 1000)
    : currentExpiry;

  const result = await db.transaction(async (tx) => {
    // attempt_no is derived inside the transaction and backed by a unique
    // index, so a retried submit collides rather than inventing a second
    // journey out of one.
    const [{ n }] = await tx
      .select({ n: sql<number>`coalesce(max(${recoveryVisitAttempts.attempt_no}), 0)::int` })
      .from(recoveryVisitAttempts)
      .where(eq(recoveryVisitAttempts.assignment_id, row.id));

    const [attempt] = await tx
      .insert(recoveryVisitAttempts)
      .values({
        assignment_id: row.id,
        tenant_id: row.tenant_id,
        attempt_no: n + 1,
        outcome: input.outcome,
        gps_lat: String(input.gps_lat),
        gps_lng: String(input.gps_lng),
        gps_accuracy_m:
          input.gps_accuracy_m != null ? String(input.gps_accuracy_m) : null,
        gps_server_timestamp: now,
        distance_from_address_m: distance != null ? String(distance) : null,
        notes: input.notes ?? null,
        next_visit_at: nextVisit,
        created_at: now,
      })
      .returning();

    const [updated] = await tx
      .update(recoveryAssignments)
      .set({
        next_visit_at: nextVisit,
        visit_attempt_count: n + 1,
        ...(newExpiry ? { link_expires_at: newExpiry } : {}),
        updated_at: now,
      })
      .where(eq(recoveryAssignments.id, row.id))
      .returning();

    await writeAudit(tx, {
      tenant_id: row.tenant_id,
      user_id: null,
      action_type: "recovery_visit",
      action_id: row.id,
      after_state: {
        attempt_no: n + 1,
        outcome: input.outcome,
        next_visit_at: nextVisit ? nextVisit.toISOString() : null,
        distance_from_address_m: distance,
        agent_name: row.agent_name,
      },
    });

    return { attempt, assignment: updated };
  });

  return { ...result, link_extended: needsExtension };
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface ReviewResult {
  assignment: RecoveryAssignment;
  battery_id: string | null;
  photos_attached: number;
}

/**
 * The NBFC's verdict on what came back.
 *
 * APPROVE does its work in ONE transaction, because a half-approved collection
 * is worse than an unreviewed one: photographs attached to a battery whose
 * assignment still reads `collected` get reviewed a second time, and
 * `recovery_date` moves on every pass.
 *
 *   1. assignment -> completed
 *   2. resolve or create the battery master from the agent's serial
 *   3. stamp recovery_date / lat / lng from what the agent recorded
 *   4. attach the photographs to the battery
 *   5. leave the pipeline at needs_inspection
 *
 * Step 5 is a deliberate no-op rather than an omission: `ALLOWED_TRANSITIONS`
 * has no edge back INTO `needs_inspection`, and the row has been sitting there
 * since the flag was raised. The battery is now exactly what the Battery
 * Evaluation wizard expects to find.
 *
 * REJECT sends it back without touching the battery at all. The photographs
 * stay on the assignment as the record of what was rejected.
 */
export async function reviewRecoveryAssignment(input: {
  tenant_id: string;
  actor_user_id: string | null;
  assignment_id: string;
  decision: "approve" | "reject";
  notes?: string | null;
  /** Promote these photo urls onto the battery. Defaults to all of them. */
  promote_photo_urls?: string[];
}): Promise<ReviewResult> {
  const row = await getAssignment(input.tenant_id, input.assignment_id);
  if (!row) throw new Error("NOT_FOUND: assignment not found");
  if (row.status !== "collected") {
    throw new Error(
      `CONFLICT: this assignment is ${row.status} — only a collected one can be reviewed`,
    );
  }

  const now = new Date();

  if (input.decision === "reject") {
    const [rejected] = await db
      .update(recoveryAssignments)
      .set({
        status: "rejected",
        is_current: false,
        reviewed_by: input.actor_user_id,
        reviewed_at: now,
        review_decision: "reject",
        review_notes: input.notes ?? null,
        updated_at: now,
      })
      .where(eq(recoveryAssignments.id, row.id))
      .returning();

    await writeAudit(db, {
      tenant_id: input.tenant_id,
      user_id: input.actor_user_id,
      action_type: "recovery_reviewed",
      action_id: row.id,
      before_state: { status: "collected" },
      after_state: { status: "rejected", notes: input.notes ?? null },
    });

    return { assignment: rejected, battery_id: null, photos_attached: 0 };
  }

  const serial = (row.battery_serial ?? "").trim();
  if (!serial) {
    throw new Error(
      "BAD_REQUEST: record the battery serial before approving — the asset register is keyed on it",
    );
  }

  const photos = await listAssignmentPhotos(row.id);
  const chosen = input.promote_photo_urls?.length
    ? photos.filter((p) => input.promote_photo_urls!.includes(p.image_url))
    : photos;

  return db.transaction(async (tx) => {
    // Handles both cases: reuses the row seeded at flag time, or creates one
    // when the flag had no serial to seed from. Refuses a serial already bound
    // to a different loan, or to another NBFC.
    const { battery } = await createRecoveryBattery({
      tenant_id: input.tenant_id,
      serial,
      loan_sanction_id: row.loan_sanction_id,
      recovery_pipeline_id: row.recovery_pipeline_id ?? undefined,
      recovery_date: (row.collected_at ?? now).toISOString(),
      lat: row.gps_lat != null ? Number(row.gps_lat) : undefined,
      lng: row.gps_lng != null ? Number(row.gps_lng) : undefined,
      executor: tx,
    });

    let attached = 0;
    if (chosen.length > 0) {
      // These MUST be /api/files/<bucket>/<key> paths. The submit route re-homes
      // the agent's bytes into the `documents` bucket for exactly this reason:
      // the auction's WhatsApp fan-out regex-parses this column, and anything
      // else silently ships a lot with no photograph.
      await attachBatteryPhotos(
        input.tenant_id,
        battery.id,
        chosen.map((p) => p.image_url),
        tx,
      );
      attached = chosen.length;
    }

    const [done] = await tx
      .update(recoveryAssignments)
      .set({
        status: "completed",
        is_current: false,
        battery_id: battery.id,
        reviewed_by: input.actor_user_id,
        reviewed_at: now,
        review_decision: "approve",
        review_notes: input.notes ?? null,
        updated_at: now,
      })
      .where(
        and(
          eq(recoveryAssignments.id, row.id),
          eq(recoveryAssignments.status, "collected"),
        ),
      )
      .returning();

    if (!done) throw new Error("CONFLICT: this assignment was already reviewed");

    await writeAudit(tx, {
      tenant_id: input.tenant_id,
      user_id: input.actor_user_id,
      action_type: "recovery_reviewed",
      action_id: row.id,
      before_state: { status: "collected" },
      after_state: {
        status: "completed",
        battery_id: battery.id,
        battery_serial: serial,
        photos_attached: attached,
        notes: input.notes ?? null,
      },
    });

    return { assignment: done, battery_id: battery.id, photos_attached: attached };
  });
}

// ---------------------------------------------------------------------------
// Reassign
// ---------------------------------------------------------------------------

/**
 * Cancel the current attempt and open a new one for a different agent.
 *
 * The two writes are NOT wrapped in a single transaction, deliberately: the
 * cancel has to commit before its "do not collect" goes out, and the assign has
 * to commit before its link does. What protects the invariant instead is the
 * partial unique index — a second live row for the same loan is impossible at
 * the database level — plus the ordering here, which can only ever leave the
 * loan with nobody assigned, never with two.
 */
export async function reassignRecoveryAgent(input: {
  tenant_id: string;
  actor_user_id: string | null;
  loan_sanction_id: string;
  agent_id: string;
  reason: string;
  due_at?: Date | null;
  channel?: RecoveryChannel;
  origin: string;
}): Promise<AssignResult & { previous_agent_notified: boolean }> {
  const cancelled = await cancelRecoveryAssignment({
    tenant_id: input.tenant_id,
    actor_user_id: input.actor_user_id,
    loan_sanction_id: input.loan_sanction_id,
    reason: input.reason,
    source: "reassigned",
  });

  const assigned = await assignRecoveryAgent({
    tenant_id: input.tenant_id,
    actor_user_id: input.actor_user_id,
    loan_sanction_id: input.loan_sanction_id,
    agent_id: input.agent_id,
    due_at: input.due_at,
    channel: input.channel,
    origin: input.origin,
  });

  return { ...assigned, previous_agent_notified: cancelled.notified };
}
