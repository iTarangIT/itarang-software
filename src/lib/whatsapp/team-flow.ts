/**
 * E-277 — the dealer's "My Team" menu: manage the salespersons who may create
 * leads from their own WhatsApp numbers.
 *
 * Dealer-only (onMenuChoice guards the entry; every handler here re-guards).
 * All CRUD and conflict semantics live in src/lib/team/salespersons.ts, shared
 * with the dealer-portal Team page so the two surfaces cannot drift.
 *
 * States (registered via registerLeadState, the established self-registration
 * path — they are console states, not lead-journey ones, but the registry is
 * the single dispatch table both turn functions consult):
 *
 *   DC_TEAM_MENU           list + Add / Remove / Back buttons
 *   DC_TEAM_ADD_PHONE      free text — the new member's WhatsApp number
 *   DC_TEAM_ADD_NAME       free text — their display name
 *   DC_TEAM_ADD_CONFIRM    Confirm / Cancel buttons
 *   DC_TEAM_REMOVE_PICK    tappable list of members
 *   DC_TEAM_REMOVE_CONFIRM Confirm / Cancel buttons
 *
 * The two free-text states deliberately do NOT set rerenderOnGreeting — "hi"
 * there must stay an escape hatch, exactly like DC_CB_FIELD (a greeting typed
 * as a phone number would otherwise be swallowed as data).
 *
 * WELCOME MESSAGE: none is sent to the new member. They have never messaged us,
 * so Meta's 24-hour service window is shut and a free-form send would fail;
 * instead the dealer is told to ask them to send "hi" — their first inbound
 * both opens the window and mints their salesperson session.
 */

import {
  addSalesperson,
  deactivateSalesperson,
  listTeam,
  type AddConflict,
  type TeamMember,
} from "@/lib/team/salespersons";

import type { ActiveDealer } from "./customer-lead";
import { registerLeadState } from "./lead-states";
import {
  loadSession,
  mergeContext,
  reply,
  replyList,
  setSession,
  type Ctx,
  type SessionRow,
} from "./session-store";
import type { InboundEvent, ListRow, ReplyButton } from "./types";

export const DC_TEAM_MENU = "DC_TEAM_MENU";
export const DC_TEAM_ADD_PHONE = "DC_TEAM_ADD_PHONE";
export const DC_TEAM_ADD_NAME = "DC_TEAM_ADD_NAME";
export const DC_TEAM_ADD_CONFIRM = "DC_TEAM_ADD_CONFIRM";
export const DC_TEAM_REMOVE_PICK = "DC_TEAM_REMOVE_PICK";
export const DC_TEAM_REMOVE_CONFIRM = "DC_TEAM_REMOVE_CONFIRM";

const MAX_NAME = 80;

/** A salesperson must never reach these states; onMenuChoice already guards
 *  the entry, this catches a stale state after a role change. */
function deniedToSalesperson(dealer: ActiveDealer): boolean {
  return dealer.actor?.role === "salesperson";
}

function maskPhone(waPhone: string): string {
  // "919876543210" → "+91 98•••••210" — enough to recognise, not to dial.
  const tail = waPhone.slice(-3);
  const head = waPhone.slice(0, 4);
  return `+${head.slice(0, 2)} ${head.slice(2)}•••••${tail}`;
}

const TEAM_MENU_BUTTONS: ReplyButton[] = [
  { id: "team_add", title: "➕ Add" },
  { id: "team_remove", title: "🗑 Remove" },
  { id: "team_back", title: "⬅ Menu" },
];

const CONFIRM_BUTTONS: ReplyButton[] = [
  { id: "team_yes", title: "✅ Confirm" },
  { id: "team_no", title: "✖ Cancel" },
];

/** Entry from onMenuChoice (menu_team). Dealer only. */
export async function showTeamMenu(
  session: SessionRow,
  dealer: ActiveDealer,
): Promise<void> {
  const team = await listTeam(dealer.dealerCode);
  const lines =
    team.length === 0
      ? "_No salespersons yet._"
      : team
          .map((m, i) => `${i + 1}. *${m.displayName}* — ${maskPhone(m.waPhone)}`)
          .join("\n");
  await mergeContext(session, (ctx) => {
    ctx.team = undefined;
  });
  await setSession(session.id, { current_state: DC_TEAM_MENU });
  await reply(
    session,
    "👥 *My Team*\n\n" +
      "Salespersons on your team can create and work leads from their own " +
      "WhatsApp — every lead they create shows up in your account too.\n\n" +
      lines,
    TEAM_MENU_BUTTONS,
  );
}

async function onTeamMenu(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  if (deniedToSalesperson(dealer)) return await backToMenu(session, dealer);
  const id = (event.text ?? "").trim();
  switch (id) {
    case "team_add":
      await setSession(session.id, { current_state: DC_TEAM_ADD_PHONE });
      await reply(
        session,
        "➕ *Add a salesperson*\n\nWhat's their *WhatsApp number*? " +
          "(10 digits, e.g. 9876543210)\n\n_Send *menu* to cancel._",
      );
      return;
    case "team_remove": {
      const team = await listTeam(dealer.dealerCode);
      if (team.length === 0) {
        await reply(session, "You have no salespersons to remove.");
        return await showTeamMenu(session, dealer);
      }
      const rows: ListRow[] = team.slice(0, 10).map((m) => ({
        id: `team_rm:${m.id}`,
        title: m.displayName.slice(0, 24),
        description: maskPhone(m.waPhone),
      }));
      await setSession(session.id, { current_state: DC_TEAM_REMOVE_PICK });
      await replyList(
        session,
        "🗑 *Remove a salesperson*\n\nWho should lose access? Their leads " +
          "stay with you.",
        "Pick member",
        rows,
      );
      return;
    }
    case "team_back":
      return await backToMenu(session, dealer);
    default:
      return await showTeamMenu(session, dealer);
  }
}

function conflictMessage(reason: AddConflict): string {
  switch (reason) {
    case "invalid_phone":
      return "That doesn't look like a valid mobile number. Please send *10 digits* (e.g. 9876543210).";
    case "already_salesperson_here":
      return "That number is *already on your team*.";
    case "already_salesperson_elsewhere":
      return "That number is already registered as a salesperson with *another dealer*. Ask them to be removed there first.";
    case "is_operator":
      return "That number belongs to an *iTarang team member* and can't be added as a salesperson.";
    case "is_dealer":
      return "That number belongs to a *registered dealer* and can't be added as a salesperson.";
    case "is_own_number":
      return "That's *your own number* — you already have full access. 😊";
  }
}

async function onTeamAddPhone(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  if (deniedToSalesperson(dealer)) return await backToMenu(session, dealer);
  const raw = (event.text ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) {
    await reply(
      session,
      "Please send the salesperson's *WhatsApp number* — 10 digits " +
        "(e.g. 9876543210). Send *menu* to cancel.",
    );
    return;
  }
  await mergeContext(session, (ctx) => {
    ctx.team = { ...(ctx.team ?? {}), addPhone: digits };
  });
  await setSession(session.id, { current_state: DC_TEAM_ADD_NAME });
  await reply(session, "What's their *name*?");
}

async function onTeamAddName(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  if (deniedToSalesperson(dealer)) return await backToMenu(session, dealer);
  const name = (event.text ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > MAX_NAME || /^[a-z]{2,}_/i.test(name)) {
    await reply(session, "Please type the salesperson's *name*.");
    return;
  }
  const fresh = await loadSession(session.id);
  const phone = ((fresh.context ?? {}) as Ctx).team?.addPhone;
  if (!phone) {
    await reply(session, "I've lost track — let's start again.");
    return await showTeamMenu(session, dealer);
  }
  await mergeContext(session, (ctx) => {
    ctx.team = { ...(ctx.team ?? {}), addName: name };
  });
  await setSession(session.id, { current_state: DC_TEAM_ADD_CONFIRM });
  await reply(
    session,
    `Add *${name}* (${phone}) to your team?\n\nThey'll be able to create ` +
      "and work customer leads from that WhatsApp number, on your behalf.",
    CONFIRM_BUTTONS,
  );
}

async function onTeamAddConfirm(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  if (deniedToSalesperson(dealer)) return await backToMenu(session, dealer);
  const id = (event.text ?? "").trim();
  if (id === "team_no") return await showTeamMenu(session, dealer);
  if (id !== "team_yes") {
    await reply(session, "Please tap *Confirm* or *Cancel*.");
    return;
  }

  const fresh = await loadSession(session.id);
  const { addPhone, addName } = ((fresh.context ?? {}) as Ctx).team ?? {};
  if (!addPhone || !addName) {
    await reply(session, "I've lost track — let's start again.");
    return await showTeamMenu(session, dealer);
  }

  const result = await addSalesperson({
    dealerCode: dealer.dealerCode,
    phone: addPhone,
    displayName: addName,
    addedBy: dealer.uploaderId,
    addedVia: "whatsapp",
    dealerOwnPhone: session.wa_phone,
  });

  if (!result.ok) {
    await reply(session, conflictMessage(result.reason));
    return await showTeamMenu(session, dealer);
  }

  await reply(
    session,
    `✅ Done — *${result.member.displayName}* is on your team.\n\n` +
      `Ask them to send *hi* to this number from ` +
      `${maskPhone(result.member.waPhone)} to get started.`,
  );
  return await showTeamMenu(session, dealer);
}

async function onTeamRemovePick(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  if (deniedToSalesperson(dealer)) return await backToMenu(session, dealer);
  const id = (event.text ?? "").trim();
  if (!id.startsWith("team_rm:")) return await showTeamMenu(session, dealer);
  const memberId = id.slice("team_rm:".length);

  const team = await listTeam(dealer.dealerCode);
  const member = team.find((m: TeamMember) => m.id === memberId);
  if (!member) {
    await reply(session, "That member is no longer on your team.");
    return await showTeamMenu(session, dealer);
  }

  await mergeContext(session, (ctx) => {
    ctx.team = { removeId: member.id, removeName: member.displayName };
  });
  await setSession(session.id, { current_state: DC_TEAM_REMOVE_CONFIRM });
  await reply(
    session,
    `Remove *${member.displayName}* (${maskPhone(member.waPhone)})?\n\n` +
      "They immediately lose access from that number. All leads they " +
      "created stay with you.",
    CONFIRM_BUTTONS,
  );
}

async function onTeamRemoveConfirm(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  if (deniedToSalesperson(dealer)) return await backToMenu(session, dealer);
  const id = (event.text ?? "").trim();
  if (id === "team_no") return await showTeamMenu(session, dealer);
  if (id !== "team_yes") {
    await reply(session, "Please tap *Confirm* or *Cancel*.");
    return;
  }

  const fresh = await loadSession(session.id);
  const { removeId, removeName } = ((fresh.context ?? {}) as Ctx).team ?? {};
  if (!removeId) {
    await reply(session, "I've lost track — let's start again.");
    return await showTeamMenu(session, dealer);
  }

  const removed = await deactivateSalesperson({
    dealerCode: dealer.dealerCode,
    salespersonId: removeId,
    deactivatedBy: dealer.uploaderId,
  });

  await reply(
    session,
    removed
      ? `🗑 *${removed.displayName}* has been removed. Their leads stay in ` +
          "your account."
      : `*${removeName ?? "That member"}* was already removed.`,
  );
  return await showTeamMenu(session, dealer);
}

/**
 * Escape back to the dealer console main menu by replaying a typed "menu"
 * through runConsoleTurn — its CONSOLE_MENU_TRIGGERS path owns menu rendering
 * (park-current-lead, ctx cleanup), and duplicating that here would drift.
 * Lazy import: orchestrator imports this module (via lead-phases), so a static
 * import would cycle.
 */
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
  return await runConsoleTurn({ ...session, current_state: "DC_MENU" }, menuEvent, dealer);
}

// Tap-driven steps re-render on a greeting; the two free-text steps keep the
// escape hatch (see module header).
registerLeadState(DC_TEAM_MENU, onTeamMenu, { rerenderOnGreeting: false });
registerLeadState(DC_TEAM_ADD_PHONE, onTeamAddPhone);
registerLeadState(DC_TEAM_ADD_NAME, onTeamAddName);
registerLeadState(DC_TEAM_ADD_CONFIRM, onTeamAddConfirm);
registerLeadState(DC_TEAM_REMOVE_PICK, onTeamRemovePick);
registerLeadState(DC_TEAM_REMOVE_CONFIRM, onTeamRemoveConfirm);
