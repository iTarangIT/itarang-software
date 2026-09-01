/**
 * E-278 — the per-lead action/step audit trail behind "Team Leads" and
 * "History" on the dealer console.
 *
 * WHY A TABLE, AND WHY THIS ONE. Nothing before this recorded WHO took a lead
 * to WHICH step: audit_logs.performed_by is a users.id (salespersons have no
 * login row), whatsapp_messages has no lead_id, and a salesperson's mid-journey
 * position (ctx.parked) lives in THEIR session's context jsonb — unreadable
 * from the dealer's session. One append-only stream answers both features:
 * History renders it as a timeline, and the newest journey `to_state` is the
 * lead's last-known position, which is what lets the dealer take over a team
 * lead without ever reading the salesperson's session.
 *
 * RESILIENCE RULE. Every read and write here swallows its errors (the
 * resolveSalesperson pattern): the E-278 DDL may not be applied on an
 * environment yet, and losing a console turn to a failed history insert would
 * be strictly worse than losing the history row. Writes are awaited-then-
 * swallowed rather than fire-and-forget — a detached promise can be killed
 * when a serverless response ends.
 */

import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { dealerSalespersons, leadFlowEvents, leads } from "@/lib/db/schema";

import type { ActiveDealer } from "./customer-lead";
import { loadSession, type Ctx, type SessionRow } from "./session-store";

export type LeadFlowActorKind = "dealer" | "salesperson" | "customer" | "system";

export interface LeadFlowEventInput {
  leadId: string;
  dealerCode: string;
  actorKind: LeadFlowActorKind;
  salespersonId?: string | null;
  actorLabel?: string | null;
  fromState?: string | null;
  toState?: string | null;
  /** 'created' | 'submitted' | 'state' | 'takeover' | 'action:<key>'. */
  action: string;
  note?: string | null;
}

export interface LeadFlowEvent {
  actorKind: string;
  salespersonId: string | null;
  actorLabel: string | null;
  fromState: string | null;
  toState: string | null;
  action: string;
  note: string | null;
  createdAt: Date | null;
}

/** WHO is driving this console turn, as event columns. Absent actor = the
 *  dealer themselves (the E-277 convention everywhere ActiveDealer is built). */
export function actorOf(dealer: ActiveDealer): {
  actorKind: LeadFlowActorKind;
  salespersonId: string | null;
  actorLabel: string | null;
} {
  if (dealer.actor?.role === "salesperson") {
    return {
      actorKind: "salesperson",
      salespersonId: dealer.actor.salespersonId ?? null,
      actorLabel: dealer.actor.displayName ?? null,
    };
  }
  return { actorKind: "dealer", salespersonId: null, actorLabel: dealer.dealerName };
}

/** Append one event. Never throws. */
export async function recordLeadFlowEvent(evt: LeadFlowEventInput): Promise<void> {
  try {
    await db.insert(leadFlowEvents).values({
      lead_id: evt.leadId,
      dealer_code: evt.dealerCode,
      actor_kind: evt.actorKind,
      salesperson_id: evt.salespersonId ?? null,
      actor_label: evt.actorLabel ?? null,
      from_state: evt.fromState ?? null,
      to_state: evt.toState ?? null,
      action: evt.action.slice(0, 32),
      note: evt.note ?? null,
    });
  } catch (err) {
    // E-278 not applied, or a transient DB error — history is best-effort.
    console.error("[WhatsApp/lead-events] record failed:", err);
  }
}

// Console states that are browsing, not a customer journey. A transition INTO
// one of these must not become a lead's "last-known position" (a takeover
// pointed at DC_MENU would be meaningless), so the choke point skips them.
const NON_JOURNEY_STATES = new Set(["DC_MENU", "DC_DRAFTS", "DC_ACTIVE_BATT"]);
const NON_JOURNEY_PREFIXES = ["DC_TEAM_", "DC_TL_", "DC_HIST_"];

/** Is this DC_* state a step of a customer journey (vs menu/browsing)? */
export function isJourneyState(state: string | null | undefined): boolean {
  if (!state || !state.startsWith("DC_")) return false;
  if (NON_JOURNEY_STATES.has(state)) return false;
  return !NON_JOURNEY_PREFIXES.some((p) => state.startsWith(p));
}

/**
 * The choke point's second half: called by runConsoleTurn after dispatch with
 * the (state, leadId) snapshot taken before it. One event per journey-state
 * transition, whoever is driving — this single site covers the hard-coded
 * DC_LEAD_* cases and every registerLeadState phase alike. Never throws.
 */
export async function recordConsoleTransition(
  sessionId: string,
  beforeState: string,
  beforeLeadId: string | undefined,
  dealer: ActiveDealer,
): Promise<void> {
  try {
    const fresh = await loadSession(sessionId);
    if (!fresh) return;
    const afterState = fresh.current_state;
    const afterLeadId = ((fresh.context ?? {}) as Ctx).lead?.leadId;
    if (afterState === beforeState && afterLeadId === beforeLeadId) return;
    // Only journey positions are worth remembering; the walk back to the menu
    // (parking) is implied by the last journey event already on record.
    if (!isJourneyState(afterState)) return;
    const leadId = afterLeadId ?? beforeLeadId;
    if (!leadId) return;
    await recordLeadFlowEvent({
      leadId,
      dealerCode: dealer.dealerCode,
      fromState: beforeState,
      toState: afterState,
      action: "state",
      ...actorOf(dealer),
    });
  } catch (err) {
    console.error("[WhatsApp/lead-events] transition record failed:", err);
  }
}

/**
 * The 'submitted' marker — written by finalizeLead, which only has the
 * session. The choke point cannot tell submit from parking (both end at
 * DC_MENU with ctx.lead cleared), so this is explicit. Actor is derived from
 * the session row: salesperson_id ⇒ the team member, ctx.flow='customer' ⇒ the
 * customer self-serving, else the dealer. Never throws.
 */
export async function recordLeadSubmitted(
  leadId: string,
  session: SessionRow,
): Promise<void> {
  try {
    const [lead] = await db
      .select({ dealerCode: leads.dealer_id })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead?.dealerCode) return;

    let actorKind: LeadFlowActorKind = "dealer";
    let actorLabel: string | null = null;
    const salespersonId = session.salesperson_id ?? null;
    if (((session.context ?? {}) as Ctx).flow === "customer") {
      actorKind = "customer";
    } else if (salespersonId) {
      actorKind = "salesperson";
      const [sp] = await db
        .select({ name: dealerSalespersons.display_name })
        .from(dealerSalespersons)
        .where(eq(dealerSalespersons.id, salespersonId))
        .limit(1);
      actorLabel = sp?.name ?? null;
    }

    await recordLeadFlowEvent({
      leadId,
      dealerCode: lead.dealerCode,
      actorKind,
      salespersonId: actorKind === "salesperson" ? salespersonId : null,
      actorLabel,
      action: "submitted",
    });
  } catch (err) {
    console.error("[WhatsApp/lead-events] submitted record failed:", err);
  }
}

/**
 * The lead's last-known journey position — the newest event with a journey
 * to_state. This is what Team Leads takeover maps to a phase entry button.
 * Null on any error (E-278 unapplied) or when nothing is on record.
 */
export async function latestFlowState(leadId: string): Promise<string | null> {
  try {
    const rows = await db
      .select({ toState: leadFlowEvents.to_state })
      .from(leadFlowEvents)
      .where(eq(leadFlowEvents.lead_id, leadId))
      .orderBy(desc(leadFlowEvents.created_at))
      .limit(25);
    for (const r of rows) {
      if (isJourneyState(r.toState)) return r.toState;
    }
    return null;
  } catch {
    return null;
  }
}

/** The timeline, oldest first, capped. Empty on any error. */
export async function listFlowEvents(
  leadId: string,
  limit = 30,
): Promise<LeadFlowEvent[]> {
  try {
    const rows = await db
      .select({
        actorKind: leadFlowEvents.actor_kind,
        salespersonId: leadFlowEvents.salesperson_id,
        actorLabel: leadFlowEvents.actor_label,
        fromState: leadFlowEvents.from_state,
        toState: leadFlowEvents.to_state,
        action: leadFlowEvents.action,
        note: leadFlowEvents.note,
        createdAt: leadFlowEvents.created_at,
      })
      .from(leadFlowEvents)
      .where(eq(leadFlowEvents.lead_id, leadId))
      .orderBy(desc(leadFlowEvents.created_at))
      .limit(limit);
    return rows.reverse();
  } catch {
    return [];
  }
}

/**
 * Human label for the journey phase a DC_* state belongs to. Superset of the
 * orchestrator's parked-lead phaseLabel: History needs the pre-submit ladder
 * named too.
 */
export function flowPhaseLabel(state: string | null | undefined): string {
  const s = state ?? "";
  if (s === "DC_LEAD_MOBILE") return "Customer mobile";
  if (s === "DC_LEAD_INTEREST") return "Classification";
  if (s === "DC_LEAD_PAYMENT") return "Payment method";
  if (s === "DC_LEAD_PRODUCT") return "Product";
  if (s === "DC_LEAD_FINANCE_Q") return "Finance questions";
  if (s.startsWith("DC_LEAD_DOCS")) return "Documents";
  if (s.startsWith("DC_LEAD_CONSENT")) return "Consent";
  if (s.startsWith("DC_CASH_")) return "Cash sale";
  if (s.startsWith("DC_CB_")) return "Co-borrower";
  if (s.startsWith("DC_S4_")) return "Lender selection";
  if (s.startsWith("DC_OF_")) return "Offers";
  if (s.startsWith("DC_DP_")) return "Dispatch";
  if (s.startsWith("DC_DOCREQ_")) return "Documents requested";
  if (s.startsWith("DC_XD_")) return "Extra documents";
  return "In progress";
}
