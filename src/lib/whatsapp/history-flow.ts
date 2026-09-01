/**
 * E-278 — the dealer's "🕘 History" menu: pick a dealership WhatsApp lead and
 * see its who-did-what timeline — which salesperson took it to which step, and
 * what the dealer did after taking over.
 *
 * Dealer-only (onMenuChoice guards the entry; the handler re-guards, the
 * team-flow convention). One state:
 *
 *   DC_HIST_LIST  paged picker over the dealership's WhatsApp leads
 *                 (rows `hl:<leadId>`, `hl_more` pages) — a tap sends the
 *                 timeline as text and re-shows the list (the active-batteries
 *                 card-then-relist pattern), so no second state is needed.
 *
 * The timeline is the lead_flow_events stream plus one synthesized creation
 * line built from the leads row itself — so a lead older than E-278 still
 * shows who created it and where it stands, and an environment without the
 * table degrades to just that.
 */

import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { dealerSalespersons, leads } from "@/lib/db/schema";

import {
  listTeamLeads,
  type ActiveDealer,
  type TeamLeadListItem,
} from "./customer-lead";
import {
  flowPhaseLabel,
  listFlowEvents,
  type LeadFlowEvent,
} from "./lead-events";
import { registerLeadState } from "./lead-states";
import {
  mergeContext,
  reply,
  replyList,
  setSession,
  type Ctx,
  type SessionRow,
} from "./session-store";
import { PAGE_SIZE } from "./stock-rows";
import type { InboundEvent, ListRow } from "./types";

export const DC_HIST_LIST = "DC_HIST_LIST";

const ROW_PREFIX = "hl";

/** A salesperson must never reach this browser; onMenuChoice guards the entry,
 *  this catches a stale state after a role change. */
function deniedToSalesperson(dealer: ActiveDealer): boolean {
  return dealer.actor?.role === "salesperson";
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "01 Sep, 2:05 pm" in IST — WhatsApp users read local time. */
export function fmtWhen(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Escape back to the dealer console main menu (same pattern as team-flow):
 * replay a typed "menu" through runConsoleTurn, whose menu path owns the
 * cleanup. Lazy import — orchestrator imports this module via lead-phases.
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
  return await runConsoleTurn(
    { ...session, current_state: "DC_MENU" },
    menuEvent,
    dealer,
  );
}

function pickerRows(items: TeamLeadListItem[], page: number): ListRow[] {
  const start = page * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);
  const rows: ListRow[] = slice.map((d) => ({
    id: `${ROW_PREFIX}:${d.leadId}`,
    title: clip(d.customerName, 24),
    description: clip(
      `${d.salespersonName ?? "You"} · ${d.mobile}`,
      72,
    ),
  }));
  if (items.length > start + PAGE_SIZE) {
    rows.push({
      id: `${ROW_PREFIX}_more`,
      title: "➕ Show more",
      description: `Page ${page + 2}`,
    });
  }
  return rows;
}

/** Entry from onMenuChoice (menu_history). Dealer only. */
export async function showHistoryList(
  session: SessionRow,
  dealer: ActiveDealer,
  page = 0,
): Promise<void> {
  const items = await listTeamLeads(dealer.dealerCode, {
    includeOwn: true,
    limit: 30,
  });
  if (items.length === 0) {
    await setSession(session.id, { current_state: "DC_MENU" });
    await reply(
      session,
      "🕘 No WhatsApp leads yet.\n\nOnce you or your salespersons create leads, their history shows up here.\n\nSend *menu* to go back.",
    );
    return;
  }
  const lastPage = Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1);
  const p = Math.min(Math.max(0, page), lastPage);
  await mergeContext(session, (ctx) => {
    ctx.hist = { page: p };
  });
  await setSession(session.id, { current_state: DC_HIST_LIST });
  await replyList(
    session,
    `🕘 *Lead history* — ${items.length} WhatsApp lead(s)\n\n` +
      `Tap a lead to see who did what, step by step.\n\n_Send *menu* to go back._`,
    "Pick a lead",
    pickerRows(items, p),
  );
}

async function onHistoryPick(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  if (deniedToSalesperson(dealer)) return await backToMenu(session, dealer);
  const raw = (event.text ?? "").trim();
  const page = ((session.context ?? {}) as Ctx).hist?.page ?? 0;

  if (raw === `${ROW_PREFIX}_more`) {
    return await showHistoryList(session, dealer, page + 1);
  }
  const m = raw.match(new RegExp(`^${ROW_PREFIX}:(.+)$`));
  if (!m) {
    return await showHistoryList(session, dealer, page);
  }

  const card = await leadHistoryCard(m[1].trim(), dealer);
  if (!card) {
    await reply(session, "I couldn't find that lead any more. Here's the current list:");
    return await showHistoryList(session, dealer, 0);
  }
  await reply(session, card);
  // Keep browsing from the same page.
  await showHistoryList(session, dealer, page);
}

// ── Timeline rendering ───────────────────────────────────────────────────────

/** Keep the message comfortably under Meta's 4096-char text cap. */
const MAX_CARD_CHARS = 3600;

function actorName(e: Pick<LeadFlowEvent, "actorKind" | "actorLabel">): string {
  switch (e.actorKind) {
    case "dealer":
      return "You";
    case "salesperson":
      return e.actorLabel || "Salesperson";
    case "customer":
      return "Customer";
    default:
      return "iTarang";
  }
}

/** What one event line says the actor did. */
function eventLabel(e: LeadFlowEvent): string {
  if (e.action === "submitted") return "submitted the lead to iTarang";
  if (e.action === "takeover")
    return e.note ? `took over the lead (from ${e.note})` : "took over the lead";
  if (e.action.startsWith("action:")) {
    const key = e.action.slice("action:".length);
    switch (key) {
      case "cb_start":
        return "opened *Co-borrower*";
      case "cb_web":
      case "s4_web":
      case "dp_web":
        return "opened the web form";
      case "cb_later":
        return "deferred the co-borrower";
      case "s4_start":
        return "opened *Lender selection*";
      case "s4_again":
        return "chose another lender";
      case "of_view":
        return "viewed the offers";
      case "of_pick":
        return "picked a lender";
      case "sn_ack":
        return "acknowledged the sanction";
      case "dp_start":
        return "opened *Dispatch*";
      case "xd_start":
        return "opened *Extra documents*";
      case "dr_send":
        return "sent a requested document";
      default:
        return `tapped ${key}`;
    }
  }
  // 'state' — a step transition.
  return `reached *${flowPhaseLabel(e.toState)}*`;
}

/**
 * The full history card for one lead, or null when the lead isn't this
 * dealer's. Always leads with a synthesized creation + status line built from
 * the leads row (works for pre-E-278 leads and unapplied environments), then
 * the event stream — consecutive same-actor/same-label lines collapsed.
 */
export async function leadHistoryCard(
  leadId: string,
  dealer: ActiveDealer,
): Promise<string | null> {
  const [row] = await db
    .select({
      ownerName: leads.owner_name,
      fullName: leads.full_name,
      mobile: leads.mobile,
      ownerContact: leads.owner_contact,
      createdAt: leads.created_at,
      kycStatus: leads.kyc_status,
      paymentMethod: leads.payment_method,
      salespersonName: dealerSalespersons.display_name,
    })
    .from(leads)
    .leftJoin(dealerSalespersons, eq(dealerSalespersons.id, leads.salesperson_id))
    // Scoped to the asking dealer — the row id (`hl:<leadId>`) arrives as free
    // text, so a typed foreign lead id must not read another dealer's history.
    .where(and(eq(leads.id, leadId), eq(leads.dealer_id, dealer.dealerCode)))
    .limit(1);
  if (!row) return null;

  const name =
    (row.ownerName && row.ownerName !== "Customer" ? row.ownerName : null) ||
    row.fullName ||
    "Customer";
  const mobile = row.mobile || row.ownerContact || "—";

  const head = [
    `🕘 *History — ${name}* (${mobile})`,
    `Created by *${row.salespersonName ?? "you"}* — ${fmtWhen(row.createdAt)}`,
    `Status: ${row.kycStatus || "draft"}${row.paymentMethod ? ` · ${row.paymentMethod}` : ""}`,
  ].join("\n");

  const events = await listFlowEvents(leadId, 30);
  const lines: string[] = [];
  let prevKey = "";
  for (const e of events) {
    // The synthesized header already covers creation.
    if (e.action === "created") continue;
    const who = actorName(e);
    const what = eventLabel(e);
    // Collapse runs of the same actor doing the same thing (e.g. several taps
    // inside one phase) — the timeline reads as steps, not keystrokes.
    const key = `${who}|${what}`;
    if (key === prevKey) continue;
    prevKey = key;
    lines.push(`• ${fmtWhen(e.createdAt)} — ${who}: ${what}`);
  }

  let body: string;
  if (lines.length === 0) {
    body =
      "_No step history recorded yet — detailed steps are recorded from now on. Portal and admin actions don't appear here._";
  } else {
    // Trim OLDEST lines first if the card would run long.
    let joined = lines.join("\n");
    while (joined.length > MAX_CARD_CHARS && lines.length > 1) {
      lines.shift();
      joined = `_…earlier steps omitted._\n${lines.join("\n")}`;
    }
    body = joined;
  }

  return `${head}\n\n${body}`;
}

// Tap-driven picker; the menu triggers stay the escape hatch (a bare "hi" has
// no lead pointer here, so it falls to the dealer menu either way).
registerLeadState(DC_HIST_LIST, onHistoryPick);
