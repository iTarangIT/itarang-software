// ID 183 — the database half of "iTarang acts for the dealer". The rules are
// pure (./actForDealer); this file gathers the facts and does the writes:
//
//   requireLeadWriter() the one write check for the KYC routes (wraps the gate).
//   gateLeadActor()     who is acting (dealer / house login on a file it
//                       pushed out / Admin-Sales Head),
//                       may they, is the file being worked by someone else,
//                       did the dealer change it since — and takes the
//                       30-minute note (iTarang) or stamps the dealer's action
//                       and clears the note (dealer wins).
//   recordActorStep()   after the step: "Done by <name> for <dealer>" on the
//                       file's history (audit_logs ACTED_FOR_DEALER) and the
//                       dealer's bell + WhatsApp (throttled to one per person
//                       per file per 30 minutes).
//   readActState()      what the CRM panel shows.
//
// lead_work_locks (E-344) and lead_assist_requests (E-345) are read and
// written with raw SQL inside try/catch: on a database without them every
// dealer step still works, the note is skipped (logged) and the 1-working-day
// rule falls back to leads.updated_at.

import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, leads, users } from "@/lib/db/schema";
import { dealerOwnsLead } from "@/lib/auth/leadAccessRules";
import { houseMayActOnLead, resolveDealerCode } from "@/lib/auth/requireLeadAccess";
import { loadHolidays } from "@/lib/calendar/holidays";
import { officeHoursResolver } from "@/lib/calendar/officeHoursStore";
import { houseDealerCode } from "@/lib/leads/dealerByMobile";
import { dealerDisplayNames, houseOriginatedLeadIds } from "@/lib/leads/pushGuards";

import {
  ACTED_FOR_DEALER,
  actForDealerPermission,
  beingWorkedMessage,
  DEALER_CHANGED_MESSAGE,
  dealerChangedSince,
  dealerFacingDoneByLine,
  doneByLine,
  isLockLive,
  leadActorVerdict,
  lockVerdict,
  parseSeenHeader,
  recordPlan,
  SEEN_DEALER_ACTION_HEADER,
  WORK_LOCK_MINUTES,
  workNoteText,
  type ActPermission,
  type LeadActorKind,
  type WorkLock,
} from "./actForDealer";

export interface ActorUser {
  id: string;
  role: string | null;
  dealer_id: string | null;
  name?: string | null;
}

export interface LeadActor {
  kind: LeadActorKind;
  userId: string;
  userName: string;
  role: string;
  leadId: string;
  /** The FILE's dealer — every step runs as this dealer. */
  leadDealerId: string | null;
  housePushed: boolean;
}

export type GateResult =
  | { ok: true; actor: LeadActor }
  | { ok: false; status: number; message: string };

export interface GateOptions {
  /** The step changes the file (takes the note / stamps the dealer). */
  write?: boolean;
  /** Step 5 / cash sale / delivered: the file's own dealer only. */
  dispatch?: boolean;
  /** What the panel saw as the dealer's last action (header); see dealerChangedSince. */
  seenDealerActionAt?: Date | null;
  /**
   * An Admin action from the KYC review itself (e.g. regenerate a rejected
   * consent on a file already with iTarang for review): skip the idle /
   * asked permission — the file is in iTarang's hands — but keep the note,
   * the record and the dealer notice.
   */
  adminReview?: boolean;
}

/** The panel's "x-seen-dealer-action-at" header from a request. */
export function seenFromRequest(req: Request): Date | null | undefined {
  return parseSeenHeader(req.headers.get(SEEN_DEALER_ACTION_HEADER));
}

async function userName(user: ActorUser): Promise<string> {
  if (user.name) return user.name;
  try {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, user.id)).limit(1);
    return u?.name || "iTarang";
  } catch {
    return "iTarang";
  }
}

/** True when the house pushed this file out at some point. */
export async function isHousePushedFile(leadId: string): Promise<boolean> {
  const house = await houseDealerCode();
  if (!house) return false;
  return (await houseOriginatedLeadIds(house, [leadId])).has(leadId);
}

interface WorkState {
  now: Date;
  lock: WorkLock | null;
  dealerLastActionAt: Date | null;
  dealerAsked: boolean;
}

const asDate = (v: unknown): Date | null => (v ? (v instanceof Date ? v : new Date(String(v))) : null);
const rowsOf = (r: unknown): Record<string, unknown>[] =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] })?.rows ?? [])) as Record<string, unknown>[];

/** The note, the dealer's last action and the open ask — all against Postgres now(). */
export async function readWorkState(leadId: string): Promise<WorkState> {
  let now = new Date();
  let lock: WorkLock | null = null;
  let dealerLastActionAt: Date | null = null;
  let dealerAsked = false;
  try {
    const [r] = rowsOf(
      await db.execute(sql`
        SELECT now() AS now, COALESCE(l.updated_at, l.created_at) AS lead_updated_at,
               w.lead_id AS has_row, w.holder_user_id, w.holder_name, w.expires_at, w.dealer_last_action_at
          FROM leads l LEFT JOIN lead_work_locks w ON w.lead_id = l.id
         WHERE l.id = ${leadId}
      `),
    );
    if (r) {
      now = asDate(r.now) ?? now;
      lock = { holderUserId: (r.holder_user_id as string) ?? null, holderName: (r.holder_name as string) ?? null, expiresAt: asDate(r.expires_at) };
      dealerLastActionAt = r.has_row ? asDate(r.dealer_last_action_at) : asDate(r.lead_updated_at);
    }
  } catch (err) {
    console.error("[actForDealer] work-lock read failed (is E-344 applied?):", err);
    try {
      const [r] = rowsOf(await db.execute(sql`SELECT now() AS now, COALESCE(updated_at, created_at) AS u FROM leads WHERE id = ${leadId}`));
      if (r) {
        now = asDate(r.now) ?? now;
        dealerLastActionAt = asDate(r.u);
      }
    } catch {
      /* keep the Node clock */
    }
  }
  try {
    const [a] = rowsOf(
      await db.execute(sql`SELECT 1 AS open FROM lead_assist_requests WHERE lead_id = ${leadId} AND withdrawn_at IS NULL LIMIT 1`),
    );
    dealerAsked = !!a;
  } catch (err) {
    console.error("[actForDealer] assist-request read failed (is E-345 applied?):", err);
  }
  return { now, lock, dealerLastActionAt, dealerAsked };
}

/**
 * The dealer acted: stamp it and clear any iTarang note (dealer wins).
 * Never throws — a dealer step must not fail over the note.
 */
export async function stampDealerAction(leadId: string, userId: string | null): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO lead_work_locks (lead_id, dealer_last_action_at, dealer_last_action_by, updated_at)
      VALUES (${leadId}, now(), ${userId}::uuid, now())
      ON CONFLICT (lead_id) DO UPDATE SET
        dealer_last_action_at = now(),
        dealer_last_action_by = EXCLUDED.dealer_last_action_by,
        holder_user_id = NULL, holder_name = NULL, holder_role = NULL,
        locked_at = NULL, expires_at = NULL,
        updated_at = now()
    `);
  } catch (err) {
    console.error("[actForDealer] dealer stamp failed (is E-344 applied?):", err);
  }
}

/**
 * Take (or refresh) the 30-minute note for an iTarang actor. Atomic: the
 * conditional upsert only lands when nobody else holds a live note. Returns
 * false when someone else got there first; true when taken — or when E-344 is
 * missing (no note to take; logged).
 */
async function takeLock(leadId: string, user: ActorUser, name: string): Promise<boolean> {
  try {
    const rows = rowsOf(
      await db.execute(sql`
        INSERT INTO lead_work_locks (lead_id, holder_user_id, holder_name, holder_role, locked_at, expires_at, dealer_last_action_at, updated_at)
        SELECT l.id, ${user.id}::uuid, ${name}, ${user.role}, now(),
               now() + make_interval(mins => ${WORK_LOCK_MINUTES}),
               COALESCE(l.updated_at, l.created_at), now()
          FROM leads l WHERE l.id = ${leadId}
        ON CONFLICT (lead_id) DO UPDATE SET
          holder_user_id = EXCLUDED.holder_user_id,
          holder_name = EXCLUDED.holder_name,
          holder_role = EXCLUDED.holder_role,
          locked_at = CASE WHEN lead_work_locks.holder_user_id = EXCLUDED.holder_user_id
                            AND lead_work_locks.expires_at > now()
                           THEN lead_work_locks.locked_at ELSE now() END,
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
        WHERE lead_work_locks.holder_user_id IS NULL
           OR lead_work_locks.expires_at IS NULL
           OR lead_work_locks.expires_at <= now()
           OR lead_work_locks.holder_user_id = EXCLUDED.holder_user_id
        RETURNING lead_id
      `),
    );
    return rows.length > 0;
  } catch (err) {
    console.error("[actForDealer] work-lock take failed (is E-344 applied?):", err);
    return true;
  }
}

/**
 * Who is acting on this file, and may they take this step now?
 * (leadActorVerdict holds the rule.)
 *  - the file's own dealer: always (writes stamp + clear the iTarang note);
 *  - an iTarang house login on a file the house pushed out: every step but
 *    dispatch (Step 5, cash sale, delivered — refused since 23 Oct) — its writes take / refresh its own
 *    note (never clear someone else's), are refused when the dealer acted
 *    after its page loaded (the dealer portal sends the header, LeadWorkNote),
 *    and are recorded "Done by" (21 Oct);
 *  - Admin / Sales Head: reads always; writes need the permission (house
 *    pushed, dealer asked, or 1 working day idle), no newer dealer action
 *    than the panel saw, and the note; never the dispatch steps;
 *  - anyone else (CEO, other back-office roles): refused.
 */
export async function gateLeadActor(
  user: ActorUser,
  lead: { id: string; dealer_id: string | null },
  opts: GateOptions = {},
): Promise<GateResult> {
  const role = (user.role ?? "").toLowerCase();
  const code = role === "dealer" ? await resolveDealerCode(user) : null;
  const ownsFile = role === "dealer" && dealerOwnsLead(lead.dealer_id, code);
  const houseOnPushedFile = role === "dealer" && !ownsFile && (await houseMayActOnLead(code, lead.id));
  const verdict = leadActorVerdict({ role, ownsFile, houseOnPushedFile, write: !!opts.write, dispatch: !!opts.dispatch });
  if (!verdict.ok) return { ok: false, status: verdict.status, message: verdict.message };
  const kind: LeadActorKind = verdict.kind;

  if (kind === "dealer") {
    if (opts.write) await stampDealerAction(lead.id, user.id);
    return {
      ok: true,
      actor: { kind: "dealer", userId: user.id, userName: user.name ?? "", role, leadId: lead.id, leadDealerId: lead.dealer_id, housePushed: false },
    };
  }
  const housePushed = kind === "house" ? true : await isHousePushedFile(lead.id);

  const name = await userName(user);
  const actor: LeadActor = { kind, userId: user.id, userName: name, role, leadId: lead.id, leadDealerId: lead.dealer_id, housePushed };
  if (!opts.write) return { ok: true, actor };

  const state = await readWorkState(lead.id);
  if (kind === "itarang" && !opts.adminReview) {
    const perm = actForDealerPermission({
      housePushed,
      dealerAsked: state.dealerAsked,
      lastDealerActionAt: state.dealerLastActionAt,
      now: state.now,
      holidays: await loadHolidays(),
      hours: await officeHoursResolver(),
    });
    if (!perm.ok) return { ok: false, status: 403, message: perm.message };
  }
  if (dealerChangedSince(state.dealerLastActionAt, opts.seenDealerActionAt)) {
    return { ok: false, status: 409, message: DEALER_CHANGED_MESSAGE };
  }
  const v = lockVerdict({ lock: state.lock, actorUserId: user.id, actorKind: kind, now: state.now });
  if (!v.ok) return { ok: false, status: 409, message: v.message };
  if (!(await takeLock(lead.id, user, name))) {
    const again = await readWorkState(lead.id);
    const msg = isLockLive(again.lock, again.now)
      ? beingWorkedMessage(again.lock!.holderName, again.lock!.expiresAt!)
      : DEALER_CHANGED_MESSAGE;
    return { ok: false, status: 409, message: msg };
  }
  return { ok: true, actor };
}

/** The file's dealer: display name, and the name of its dealer login (what the consent PDF prints). */
export async function fileDealerNames(dealerId: string | null): Promise<{ display: string | null; loginName: string | null }> {
  if (!dealerId) return { display: null, loginName: null };
  const [names, login] = await Promise.all([
    dealerDisplayNames([dealerId]),
    db
      .select({ name: users.name })
      .from(users)
      .where(and(eq(users.dealer_id, dealerId), eq(users.role, "dealer"), eq(users.is_active, true)))
      .orderBy(users.created_at)
      .limit(1),
  ]);
  return { display: names.get(dealerId) ?? dealerId, loginName: login[0]?.name ?? null };
}

export interface RecordOptions {
  /**
   * A save that fires over and over (the KYC / co-borrower draft autosave):
   * one "Done by" line per person per file per 30-minute hold, not one per
   * save (recordPlan).
   */
  coalesce?: boolean;
  /** ID 201: the caller (recordKycStep / recordKycMilestone) writes the KYC history line itself. */
  kycLine?: boolean;
}

/**
 * After an iTarang step succeeded (Admin / Sales Head from the CRM panel, or
 * the house login in the dealer portal on a file it pushed out): "Done by
 * <name> for <dealer>" on the file's history and the dealer told (bell +
 * WhatsApp, at most once per person per file per 30 minutes). The dealer's
 * own step is no "Done by" line and no notice — since ID 201 (27 Oct) it is a
 * plain line in the file's KYC history instead. Never throws.
 */
export async function recordActorStep(
  actor: LeadActor,
  step: string,
  extra: Record<string, unknown> = {},
  opts: RecordOptions = {},
): Promise<void> {
  if (actor.kind === "dealer") {
    // ID 201 #4: the owning dealer's own steps (Step 1, Step 4 / 5, cash sale,
    // lender choice …) as plain history lines. Draft autosaves are not steps.
    if (opts.kycLine || opts.coalesce) return;
    try {
      const { recordKycEvent, sentence } = await import("@/lib/kyc/kycEventLog");
      await recordKycEvent({
        leadId: actor.leadId,
        action: sentence(step),
        actor: { id: actor.userId, name: actor.userName, role: actor.role, type: "dealer", channel: "web" },
        detail: { step, ...extra },
        notify: false,
      });
    } catch (err) {
      console.error(`[actForDealer] dealer step for ${actor.leadId} not logged:`, err);
    }
    return;
  }
  try {
    let anyRecent = false;
    let sameStepRecent = false;
    try {
      const [r] = rowsOf(
        await db.execute(sql`
          SELECT COUNT(*)::int AS n,
                 COALESCE(bool_or(changes->>'step' = ${step}), false) AS same
            FROM audit_logs
           WHERE entity_type = 'lead' AND entity_id = ${actor.leadId}
             AND action = ${ACTED_FOR_DEALER} AND performed_by = ${actor.userId}::uuid
             AND timestamp > now() - make_interval(mins => ${WORK_LOCK_MINUTES})
        `),
      );
      anyRecent = Number(r?.n ?? 0) > 0;
      sameStepRecent = r?.same === true || r?.same === "t";
    } catch {
      /* write the line and tell the dealer */
    }
    const plan = recordPlan({ coalesce: !!opts.coalesce, sameStepRecent, anyRecent });
    if (!plan.write) return;
    const notify = plan.notify;
    const { display } = await fileDealerNames(actor.leadDealerId);
    const line = doneByLine(actor.userName, display);
    await db.insert(auditLogs).values({
      id: `AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-afd`,
      entity_type: "lead",
      entity_id: actor.leadId,
      action: ACTED_FOR_DEALER,
      changes: {
        step,
        line,
        by_name: actor.userName,
        by_role: actor.role,
        for_dealer_id: actor.leadDealerId,
        for_dealer_name: display,
        via: actor.kind === "house" ? "house_login" : "act_for_dealer",
        dealer_notified: notify,
        ...extra,
      },
      performed_by: actor.userId,
      timestamp: new Date(),
    });
    if (notify) {
      const { notifyDealerOfAssist } = await import("./pushNotices");
      // ID 201 #6: the dealer is told "iTarang team", not the person's name.
      await notifyDealerOfAssist(actor.leadId, dealerFacingDoneByLine(display), step);
    }
  } catch (err) {
    console.error(`[actForDealer] record for ${actor.leadId} failed:`, err);
  }
}

export interface ActHistoryRow {
  at: string;
  line: string;
  step: string | null;
  byName: string | null;
  via: string | null;
  /** ID 201: for the dealer-facing wording ("Done by iTarang team for <dealer>"). */
  forDealerName: string | null;
}

/** ID 201 #6 — the same rows as the file's dealer sees them: no iTarang names. */
export function dealerFacingHistory(rows: ActHistoryRow[]): ActHistoryRow[] {
  return rows.map((r) => ({ ...r, line: dealerFacingDoneByLine(r.forDealerName), byName: "iTarang team" }));
}

/** Every "Done by <name> for <dealer>" line on a file, newest first. */
export async function actHistory(leadId: string, limit = 50): Promise<ActHistoryRow[]> {
  const rows = await db
    .select({ at: auditLogs.timestamp, changes: auditLogs.changes, byName: users.name })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.performed_by))
    .where(and(eq(auditLogs.entity_type, "lead"), eq(auditLogs.entity_id, leadId), eq(auditLogs.action, ACTED_FOR_DEALER)))
    .orderBy(desc(auditLogs.timestamp))
    .limit(limit);
  return rows.map((r) => {
    const c = (r.changes ?? {}) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" && v ? v : null);
    return {
      at: (r.at instanceof Date ? r.at : new Date(r.at)).toISOString(),
      line: s(c.line) ?? doneByLine(r.byName ?? s(c.by_name), s(c.for_dealer_name)),
      step: s(c.step),
      byName: r.byName ?? s(c.by_name),
      via: s(c.via),
      forDealerName: s(c.for_dealer_name),
    };
  });
}

export interface ActState {
  /** May this caller act for the dealer now (writes)? */
  permission: ActPermission;
  housePushed: boolean;
  dealerAsked: boolean;
  dealerLastActionAt: string | null;
  lock: { holderName: string | null; expiresAt: string; mine: boolean } | null;
  now: string;
}

/** What the "Act for dealer" panel shows for this caller. */
export async function readActState(leadId: string, user: ActorUser): Promise<ActState> {
  const [state, housePushed] = await Promise.all([readWorkState(leadId), isHousePushedFile(leadId)]);
  const permission = actForDealerPermission({
    housePushed,
    dealerAsked: state.dealerAsked,
    lastDealerActionAt: state.dealerLastActionAt,
    now: state.now,
    holidays: await loadHolidays(),
    hours: await officeHoursResolver(),
  });
  const live = isLockLive(state.lock, state.now);
  return {
    permission,
    housePushed,
    dealerAsked: state.dealerAsked,
    dealerLastActionAt: state.dealerLastActionAt?.toISOString() ?? null,
    lock: live
      ? { holderName: state.lock!.holderName, expiresAt: state.lock!.expiresAt!.toISOString(), mine: state.lock!.holderUserId === user.id }
      : null,
    now: state.now.toISOString(),
  };
}

export interface WorkNote {
  /** Who is looking: the file's dealer, or the house login on a file it pushed out. */
  kind: LeadActorKind;
  /** "Being worked by <name> (iTarang) until …", or null. */
  text: string | null;
  mine: boolean;
  /** The dealer's last action as of this read — the house login's pages send it back (dealer wins). */
  dealerLastActionAt: string | null;
  seenHeader: string;
}

/**
 * 21 Oct (ID 183, items 5 + 6) — what the dealer portal's lead / KYC screens
 * show: the "being worked by" note (before, only the CRM panel showed it),
 * and, for the house login, the dealer's last action its saves send back.
 */
export async function readWorkNote(
  user: ActorUser,
  lead: { id: string; dealer_id: string | null },
): Promise<{ ok: true; note: WorkNote } | { ok: false; status: number; message: string }> {
  const gate = await gateLeadActor(user, lead);
  if (!gate.ok) return gate;
  const state = await readWorkState(lead.id);
  const live = isLockLive(state.lock, state.now);
  return {
    ok: true,
    note: {
      kind: gate.actor.kind,
      text: workNoteText(state.lock, { userId: user.id, kind: gate.actor.kind }, state.now),
      mine: live && state.lock!.holderUserId === user.id,
      dealerLastActionAt: state.dealerLastActionAt?.toISOString() ?? null,
      seenHeader: SEEN_DEALER_ACTION_HEADER,
    },
  };
}

/** The lead row the gate needs. */
export async function leadForGate(leadId: string): Promise<{ id: string; dealer_id: string | null } | null> {
  const [l] = await db.select({ id: leads.id, dealer_id: leads.dealer_id }).from(leads).where(eq(leads.id, leadId)).limit(1);
  return l ?? null;
}

export type LeadWriterResult =
  | { ok: true; actor: LeadActor; lead: { id: string; dealer_id: string | null } }
  | { ok: false; status: number; message: string; response: NextResponse };

/**
 * ID 183 (16 Oct) — THE check for every step that changes a customer file
 * (the KYC / co-borrower write routes; the lender journey calls
 * gateLeadActor(user, lead, { write: true }) directly, which this wraps).
 * Call it after requireLeadAccess(leadId), with that user:
 *  - the file's own dealer → allowed; stamps the dealer's action and clears
 *    any iTarang "being worked by" note (dealer wins; the 1-working-day idle
 *    rule reads this stamp);
 *  - Admin / Sales Head → the act-for-dealer checks (permission, the
 *    30-minute note, dealer-changed-since) — the route then calls
 *    recordActorStep() for the "Done by" record and the dealer notice;
 *  - the house login on a file it pushed out → the same note / dealer-
 *    changed checks; the route records "Done by" (recordActorStep);
 *  - everyone else (CEO, other back-office roles) → refused. Reads are not
 *    affected.
 * `response` is the standard { success: false, error: { message } } shape.
 */
export async function requireLeadWriter(
  leadId: string,
  req: Request | null,
  user: ActorUser,
  opts: { dispatch?: boolean; adminReview?: boolean; lead?: { id: string; dealer_id: string | null } } = {},
): Promise<LeadWriterResult> {
  const refuse = (status: number, message: string): LeadWriterResult => ({
    ok: false,
    status,
    message,
    response: NextResponse.json({ success: false, error: { message } }, { status }),
  });
  const lead = opts.lead ?? (await leadForGate(leadId));
  if (!lead) return refuse(403, "Forbidden");
  const gate = await gateLeadActor(user, lead, {
    write: true,
    dispatch: opts.dispatch,
    adminReview: opts.adminReview,
    seenDealerActionAt: req ? seenFromRequest(req) : undefined,
  });
  if (!gate.ok) return refuse(gate.status, gate.message);
  return { ok: true, actor: gate.actor, lead };
}
