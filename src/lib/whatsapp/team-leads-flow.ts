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
 * HOW TAKEOVER WORKS — deliberately WITHOUT reading the salesperson's session.
 * Their exact mid-phase position lives in their own session's context jsonb
 * (ctx.parked), which the dealer's turn cannot see. Instead:
 *   - a pre-submit draft goes through the orchestrator's resumeDraft ladder,
 *     which rebuilds everything from the DB and re-opens at the first
 *     unanswered step;
 *   - a post-submit journey is re-entered at its PHASE via the existing
 *     LEAD_ACTIONS buttons (cb_start / s4_start / of_view / dp_start /
 *     xd_start) — cold-hydrating by design and already dealer-authorized in
 *     authorizeLeadAction. The phase to offer comes from the lead's newest
 *     lead_flow_events journey state (latestFlowState).
 * Mid-phase sub-context (a half-typed co-borrower name) is unrecoverable
 * cross-session; phases are re-enterable by design, so re-entry at the phase
 * head is the correct cost.
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { loanSanctions } from "@/lib/db/schema";

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
  recordLeadFlowEvent,
} from "./lead-events";
import { registerLeadState } from "./lead-states";
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

/** Where the lead stands, for a list-row description / the card's Stage line.
 *  The events stream is the best signal; the draft columns are the fallback. */
async function stageOf(d: TeamLeadListItem): Promise<string> {
  const st = await latestFlowState(d.leadId);
  if (st) return flowPhaseLabel(st);
  if (!d.kycStatus || ["pending", "draft"].includes(d.kycStatus)) return "Draft";
  return "In progress";
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
  const spName =
    (await listTeamLeads(dealer.dealerCode, { limit: 30 })).find(
      (d) => d.leadId === leadId,
    )?.salespersonName ?? null;

  const takeoverEvent = () =>
    recordLeadFlowEvent({
      leadId,
      dealerCode: dealer.dealerCode,
      action: "takeover",
      note: spName,
      ...actorOf(dealer),
    });

  // 1) Still a pre-submit draft → the DB-driven resume ladder re-opens it at
  //    the first unanswered step, exactly like Save Drafts would.
  const draft = await getDealerDraft(dealer.dealerCode, leadId);
  if (draft) {
    await takeoverEvent();
    const { resumeDraft } = await import("./orchestrator");
    return await resumeDraft(session, dealer, draft);
  }

  // 2) Submitted — offer the phase-entry button for its last-known position.
  const state = await latestFlowState(leadId);
  let action = takeoverAction(state);

  // 3) No usable events (pre-E-278 lead, or table unapplied): a sanctioned
  //    lead can still be taken to dispatch; anything else is with iTarang.
  if (!action && (await hasSanction(leadId))) action = "dp_start";

  if (action) {
    await takeoverEvent();
    await reply(
      session,
      `▶️ *${summary.customerName}* is at *${flowPhaseLabel(state)}*` +
        (spName ? ` (with ${spName})` : "") +
        `.\n\nTap below to continue this lead yourself 👇`,
      [{ id: leadActionId(action, leadId), title: "▶️ Continue" }],
    );
    // Stay on DC_TL_VIEW; the tap routes through the lead-action gate, which
    // re-hydrates from the DB and records the action on the history stream.
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
