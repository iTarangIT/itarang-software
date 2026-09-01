/**
 * E-278 — the dealer's "🗂 Team Leads" menu: every lead the salespersons on
 * their E-277 team are working, who is handling which customer, and a
 * take-over path so the main dealer can open one and complete the remaining
 * flow themselves.
 *
 * Dealer-only (onMenuChoice guards the entry; every handler re-guards, the
 * team-flow convention). States:
 *
 *   DC_TL_LIST  paged picker (rows `tl:<leadId>`, `tl_more` pages)
 *   DC_TL_VIEW  one lead's card + ▶️ Take over / 🕘 History / ⬅ Back buttons
 *
 * HOW TAKEOVER WORKS — the contract is "the last system message comes again":
 * the dealer's chat re-renders the step the salesperson last saw, and the
 * dealer answers it from there. In order of fidelity:
 *   0. The salesperson's EXACT position, copied from their session row
 *      (ctx.lead mid-journey, or their ctx.parked snapshot) and replayed via
 *      resumeParkedJourney — full sub-context (picked battery, margin,
 *      question cursor). Only for states registered in ./lead-states.
 *   1. Lead not yet submitted (no admin_verification_queue row) → the
 *      orchestrator's resumeDraft ladder rebuilds from the DB and re-sends
 *      the first unanswered step's prompt.
 *   2. Submitted → the lead's newest lead_flow_events journey state maps to a
 *      LEAD_ACTIONS phase entry (cb_start / s4_start / of_view / dp_start /
 *      xd_start), driven DIRECTLY through handleLeadAction (cold-hydrating,
 *      dealer-authorized) so the prompt arrives without another tap; live-
 *      status fallbacks: sanction → dp_start, kyc_approved → s4_start.
 * Every successful path also releases the salesperson's hold: their pointers
 * to this lead are cleared and they get a "your dealer took over" notice, so
 * two chats never drive the same lead.
 */

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  adminVerificationQueue,
  leads,
  loanSanctions,
  whatsappOnboardingSessions,
} from "@/lib/db/schema";

import {
  getDealerDraft,
  getDealerLeadSummary,
  listTeamLeads,
  type ActiveDealer,
  type TeamLeadListItem,
} from "./customer-lead";
import { leadHistoryCard } from "./history-flow";
import {
  actorOf,
  flowPhaseLabel,
  latestFlowState,
  listFlowEvents,
  recordLeadFlowEvent,
} from "./lead-events";
import { leadStateHandler, registerLeadState } from "./lead-states";
import { leadActionId, type LeadActionKey } from "./leadActionButton";
import {
  mergeContext,
  reply,
  replyList,
  setSession,
  type Ctx,
  type SessionRow,
} from "./session-store";
import { PAGE_SIZE } from "./stock-rows";
import type { InboundEvent, ListRow, ReplyButton } from "./types";

export const DC_TL_LIST = "DC_TL_LIST";
export const DC_TL_VIEW = "DC_TL_VIEW";

const ROW_PREFIX = "tl";

/** A salesperson must never reach these states; onMenuChoice guards the entry,
 *  this catches a stale state after a role change. */
function deniedToSalesperson(dealer: ActiveDealer): boolean {
  return dealer.actor?.role === "salesperson";
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

/** Same escape-to-menu pattern as team-flow (lazy import — orchestrator pulls
 *  this module in via lead-phases, so a static import would cycle). */
async function backToMenu(
  session: SessionRow,
  dealer: ActiveDealer,
): Promise<void> {
  const { runConsoleTurn } = await import("./orchestrator");
  await setSession(session.id, { current_state: "DC_MENU" });
  const menuEvent: InboundEvent = {
    ...({} as InboundEvent),
    type: "text",
    text: "menu",
    waPhone: session.wa_phone,
  };
  return await runConsoleTurn(
    { ...session, current_state: "DC_MENU" },
    menuEvent,
    dealer,
  );
}

const DRAFTISH_KYC = ["pending", "draft"];

function isDraftishKyc(kycStatus: string | null): boolean {
  return !kycStatus || DRAFTISH_KYC.includes(kycStatus);
}

/** Where the lead stands, for a list-row description / the card's Stage line.
 *  A pre-submit last-known state is only trusted while the lead is still a
 *  draft — a SUBMITTED lead whose newest event says "Consent" (the salesperson
 *  finished the ladder and submitted) must show its live status instead, or
 *  the card promises a step the takeover can't offer. */
async function stageOf(d: TeamLeadListItem): Promise<string> {
  const st = await latestFlowState(d.leadId);
  const preSubmit = !st || st.startsWith("DC_LEAD_") || st.startsWith("DC_CASH_");
  if (!preSubmit) return flowPhaseLabel(st);
  if (isDraftishKyc(d.kycStatus)) return st ? flowPhaseLabel(st) : "Draft";
  if (d.kycStatus === "kyc_approved") return "Lender selection";
  return "In review";
}

const VIEW_BUTTONS: ReplyButton[] = [
  { id: "tl_go", title: "▶️ Take over" },
  { id: "tl_hist", title: "🕘 History" },
  { id: "tl_back", title: "⬅ Back" },
];

/** Entry from onMenuChoice (menu_team_leads). Dealer only. */
export async function showTeamLeads(
  session: SessionRow,
  dealer: ActiveDealer,
  page = 0,
): Promise<void> {
  const items = await listTeamLeads(dealer.dealerCode, { limit: 30 });
  if (items.length === 0) {
    await setSession(session.id, { current_state: "DC_MENU" });
    await reply(
      session,
      "🗂 Your salespersons haven't created any leads yet.\n\n" +
        "Add salespersons under *My Team* — every lead they create will show up here.\n\nSend *menu* to go back.",
    );
    return;
  }

  const lastPage = Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1);
  const p = Math.min(Math.max(0, page), lastPage);
  const slice = items.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
  const stages = await Promise.all(slice.map(stageOf));

  const rows: ListRow[] = slice.map((d, i) => ({
    id: `${ROW_PREFIX}:${d.leadId}`,
    title: clip(d.customerName, 24),
    description: clip(`${d.salespersonName ?? "—"} · ${stages[i]}`, 72),
  }));
  if (items.length > p * PAGE_SIZE + PAGE_SIZE) {
    rows.push({
      id: `${ROW_PREFIX}_more`,
      title: "➕ Show more",
      description: `Page ${p + 2}`,
    });
  }

  await mergeContext(session, (ctx) => {
    ctx.tl = { page: p };
  });
  await setSession(session.id, { current_state: DC_TL_LIST });
  await replyList(
    session,
    `🗂 *Team Leads* — ${items.length} lead(s) your salespersons are working\n\n` +
      `Tap one to see where it stands and take it over.\n\n_Send *menu* to go back._`,
    "Pick a lead",
    rows,
  );
}

/** DC_TL_LIST — a tapped row, "Show more", or stray text. */
async function onTeamLeadPick(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  if (deniedToSalesperson(dealer)) return await backToMenu(session, dealer);
  const raw = (event.text ?? "").trim();
  const page = ((session.context ?? {}) as Ctx).tl?.page ?? 0;

  if (raw === `${ROW_PREFIX}_more`) {
    return await showTeamLeads(session, dealer, page + 1);
  }
  const m = raw.match(new RegExp(`^${ROW_PREFIX}:(.+)$`));
  if (!m) {
    return await showTeamLeads(session, dealer, page);
  }
  return await showTeamLeadCard(session, dealer, m[1].trim());
}

/** The one-lead card (DC_TL_VIEW). */
async function showTeamLeadCard(
  session: SessionRow,
  dealer: ActiveDealer,
  leadId: string,
): Promise<void> {
  const items = await listTeamLeads(dealer.dealerCode, { limit: 30 });
  const hit = items.find((d) => d.leadId === leadId);
  if (!hit) {
    await reply(session, "I couldn't find that lead any more. Here's the current list:");
    return await showTeamLeads(session, dealer, 0);
  }
  const stage = await stageOf(hit);

  const lines = [
    `👤 *${hit.customerName}* (${hit.mobile})`,
    `Salesperson: *${hit.salespersonName ?? "—"}*`,
  ];
  const cls: string[] = [];
  if (hit.interest) cls.push(titleCase(hit.interest));
  if (hit.paymentMethod) cls.push(titleCase(hit.paymentMethod.replace("_", " ")));
  if (cls.length) lines.push(`Lead: ${cls.join(" · ")}`);
  lines.push(`Stage: *${stage}*`);
  lines.push(
    "",
    "▶️ *Take over* — continue this lead yourself from where it stands.",
  );

  await mergeContext(session, (ctx) => {
    ctx.tl = { ...(ctx.tl ?? {}), leadId };
  });
  await setSession(session.id, { current_state: DC_TL_VIEW });
  await reply(session, lines.join("\n"), VIEW_BUTTONS);
}

/** DC_TL_VIEW — Take over / History / Back. */
async function onTeamLeadView(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  if (deniedToSalesperson(dealer)) return await backToMenu(session, dealer);
  const raw = (event.text ?? "").trim();
  const ctx = (session.context ?? {}) as Ctx;
  const leadId = ctx.tl?.leadId;
  const page = ctx.tl?.page ?? 0;

  if (!leadId) return await showTeamLeads(session, dealer, page);

  switch (raw) {
    case "tl_go":
      return await takeOverLead(session, dealer, leadId);
    case "tl_hist": {
      const card = await leadHistoryCard(leadId, dealer);
      await reply(
        session,
        card ?? "I couldn't load that lead's history any more.",
      );
      // Stay on the card — its buttons remain tappable.
      return;
    }
    case "tl_back":
      return await showTeamLeads(session, dealer, page);
    default:
      // Stray text → re-render the card.
      return await showTeamLeadCard(session, dealer, leadId);
  }
}

// Post-submit journeys are re-entered at their phase head via the existing
// dealer-authorized LEAD_ACTIONS buttons. DC_LEAD_* has no entry here on
// purpose: pre-submit is the resumeDraft ladder's job.
function takeoverAction(state: string | null): LeadActionKey | null {
  const s = state ?? "";
  if (s.startsWith("DC_CB_")) return "cb_start";
  if (s.startsWith("DC_S4_")) return "s4_start";
  if (s.startsWith("DC_OF_")) return "of_view";
  if (s.startsWith("DC_DP_") || s.startsWith("DC_CASH_")) return "dp_start";
  if (s.startsWith("DC_XD_")) return "xd_start";
  return null;
}

async function hasSanction(leadId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: loanSanctions.id })
      .from(loanSanctions)
      .where(eq(loanSanctions.lead_id, leadId))
      .limit(1);
    return Boolean(row);
  } catch {
    return false;
  }
}

/** Has this lead been submitted to iTarang for KYC review? Same marker the
 *  drafts list keys on (ensureAdminKycQueueEntry writes it). */
async function isSubmitted(leadId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: adminVerificationQueue.id })
      .from(adminVerificationQueue)
      .where(eq(adminVerificationQueue.lead_id, leadId))
      .limit(1);
    return Boolean(row);
  } catch {
    return false;
  }
}

type LeadSnap = { state: string; lead: NonNullable<Ctx["lead"]>; at: string };

/**
 * The salesperson's hold on this lead, read from THEIR session row (same DB —
 * "unreadable" was never literal, just uncopied). `snap` is their exact
 * position — the live journey step they're sitting in, or their ctx.parked
 * snapshot — in the same shape as a ctx.parked entry, so resumeParkedJourney
 * replays the very step prompt they last saw, sub-context and all. `snap` is
 * only set for states registered in ./lead-states: the hard-coded DC_LEAD_*
 * ladder re-renders through resumeDraft instead. Null-safe throughout.
 */
async function salespersonHold(
  leadId: string,
  salespersonId: string | null,
): Promise<{ snap: LeadSnap | null; spSession: SessionRow | null }> {
  try {
    let spId = salespersonId;
    if (!spId) {
      const [row] = await db
        .select({ spId: leads.salesperson_id })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
      spId = row?.spId ?? null;
    }
    if (!spId) {
      // Attribution drift: the lead column can be null while the event stream
      // still knows who drove it — use the newest salesperson event.
      const evts = await listFlowEvents(leadId, 30);
      for (let i = evts.length - 1; i >= 0; i -= 1) {
        if (evts[i].actorKind === "salesperson" && evts[i].salespersonId) {
          spId = evts[i].salespersonId;
          break;
        }
      }
    }
    if (!spId) return { snap: null, spSession: null };
    const [sess] = await db
      .select()
      .from(whatsappOnboardingSessions)
      .where(
        and(
          eq(whatsappOnboardingSessions.salesperson_id, spId),
          eq(whatsappOnboardingSessions.session_kind, "salesperson"),
        ),
      )
      .orderBy(desc(whatsappOnboardingSessions.updated_at))
      .limit(1);
    if (!sess) return { snap: null, spSession: null };
    const ctx = (sess.context ?? {}) as Ctx;

    if (
      ctx.lead?.leadId === leadId &&
      leadStateHandler(sess.current_state)
    ) {
      return {
        snap: {
          state: sess.current_state,
          lead: ctx.lead as NonNullable<Ctx["lead"]>,
          at: new Date().toISOString(),
        },
        spSession: sess,
      };
    }
    const parked = ctx.parked?.[leadId];
    if (parked && leadStateHandler(parked.state)) {
      return { snap: parked, spSession: sess };
    }
    return { snap: null, spSession: sess };
  } catch (err) {
    console.error("[WhatsApp/team-leads] salesperson hold lookup failed:", err);
    return { snap: null, spSession: null };
  }
}

/**
 * After a takeover: drop the salesperson's pointers to this lead (their parked
 * snapshot, and their live journey if they're mid-THIS-lead) so the two chats
 * don't drive the same lead, and tell them what happened. Best-effort — a
 * failure here must not fail the dealer's takeover.
 */
async function releaseSalespersonHold(
  spSession: SessionRow | null,
  leadId: string,
  dealer: ActiveDealer,
  customerName: string,
): Promise<void> {
  if (!spSession) return;
  try {
    const ctx = (spSession.context ?? {}) as Ctx;
    const midThisLead = ctx.lead?.leadId === leadId;
    await mergeContext(spSession, (c) => {
      if (c.parked) delete c.parked[leadId];
      if (c.lead?.leadId === leadId) c.lead = undefined;
    });
    if (midThisLead) {
      await setSession(spSession.id, { current_state: "DC_MENU" });
    }
    await reply(
      spSession,
      `ℹ️ *${dealer.dealerName}* has taken over the lead *${customerName}* — it continues from their WhatsApp now.\n\nSend *menu* to see your other leads.`,
    );
  } catch (err) {
    console.error("[WhatsApp/team-leads] release salesperson hold failed:", err);
  }
}

/** Human label for the phase a takeover button re-enters. */
function actionPhaseLabel(action: LeadActionKey): string {
  switch (action) {
    case "cb_start":
      return "Co-borrower";
    case "s4_start":
      return "Lender selection";
    case "of_view":
      return "Offers";
    case "dp_start":
      return "Dispatch";
    case "xd_start":
      return "Extra documents";
    default:
      return "In progress";
  }
}

async function takeOverLead(
  session: SessionRow,
  dealer: ActiveDealer,
  leadId: string,
): Promise<void> {
  const summary = await getDealerLeadSummary(dealer.dealerCode, leadId);
  if (!summary) {
    await reply(session, "I couldn't find that lead any more. Here's the current list:");
    return await showTeamLeads(session, dealer, 0);
  }
  const teamItem = (
    await listTeamLeads(dealer.dealerCode, { limit: 30 })
  ).find((d) => d.leadId === leadId);
  const spName = teamItem?.salespersonName ?? null;

  const takeoverEvent = () =>
    recordLeadFlowEvent({
      leadId,
      dealerCode: dealer.dealerCode,
      action: "takeover",
      note: spName,
      ...actorOf(dealer),
    });

  const hold = await salespersonHold(leadId, teamItem?.salespersonId ?? null);
  const release = () =>
    releaseSalespersonHold(hold.spSession, leadId, dealer, summary.customerName);

  // 0) The salesperson's EXACT position, copied from their session row: the
  //    dealer's chat re-renders the very step prompt the salesperson last saw
  //    (sub-context included — picked battery, margin, question cursor), and
  //    the dealer answers it from here on. This is the "last system message
  //    comes again" contract.
  if (hold.snap) {
    await takeoverEvent();
    await release();
    const { resumeParkedJourney } = await import("./orchestrator");
    return await resumeParkedJourney(session, dealer, leadId, hold.snap);
  }

  // 1) Not yet submitted to iTarang → the DB-driven resume ladder re-opens the
  //    lead at the next unanswered step and re-sends that step's prompt.
  //    Deliberately NOT keyed on getDealerDraft alone: kyc_status can leave the
  //    draft window mid-ladder, and the old check dead-ended those takeovers.
  const submitted = await isSubmitted(leadId);
  if (!submitted) {
    const draft =
      (await getDealerDraft(dealer.dealerCode, leadId)) ?? summary;
    await takeoverEvent();
    await release();
    const { resumeDraft } = await import("./orchestrator");
    return await resumeDraft(session, dealer, draft);
  }

  // 2) Submitted, no live session position — re-enter the phase for its
  //    last-known recorded position. A pre-submit DC_LEAD_* last event on a
  //    submitted lead means the salesperson finished the ladder (takeoverAction
  //    maps it to null), so fall through to the live-status ladder below.
  const state = await latestFlowState(leadId);
  let action = takeoverAction(state);
  let phase = action ? flowPhaseLabel(state) : "";

  // 3) Live-status fallback: sanctioned → dispatch; KYC approved → lender
  //    selection (the next actionable step after admin approval — the same
  //    push the salesperson would receive).
  if (!action && (await hasSanction(leadId))) action = "dp_start";
  if (!action && teamItem?.kycStatus === "kyc_approved") action = "s4_start";

  if (action) {
    if (!phase) phase = actionPhaseLabel(action);
    await takeoverEvent();
    await release();
    await reply(
      session,
      `▶️ Taking over *${summary.customerName}*` +
        (spName ? ` from ${spName}` : "") +
        ` — *${phase}*.`,
    );
    // Drive the phase entry directly — the same cold-hydrating, authorized
    // path a tapped button takes — so the step's prompt arrives immediately
    // instead of asking the dealer for one more tap.
    const { handleLeadAction } = await import("./leadActionReply");
    await handleLeadAction(session, {
      providerMessageId: `takeover:${leadId}:${Date.now()}`,
      waPhone: session.wa_phone,
      type: "interactive",
      text: leadActionId(action, leadId),
      raw: { synthetic: true },
    } as InboundEvent);
    return;
  }

  await reply(
    session,
    `📄 *${summary.customerName}* is with iTarang right now (KYC review / portal step) — there's nothing to continue in chat yet.\n\n` +
      "You'll get the next step here the moment it's ready.",
  );
  return await showTeamLeads(session, dealer, ((session.context ?? {}) as Ctx).tl?.page ?? 0);
}

// Tap-driven steps; a bare greeting has no lead pointer in these states, so it
// falls to the dealer menu (the escape hatch), matching team-flow.
registerLeadState(DC_TL_LIST, onTeamLeadPick);
registerLeadState(DC_TL_VIEW, onTeamLeadView);
