/**
 * E-264 — window-aware outbound sending.
 *
 * Until now every out-of-band WhatsApp send in this repo was free-form and
 * simply hoped Meta's 24-hour customer-service window was open;
 * src/lib/whatsapp/notifications.ts says so in its header. That held while the
 * only out-of-band sends were consent push-backs moments after the dealer had
 * been typing. The journey breaks it: "your loan is sanctioned" goes out days
 * after the customer last replied, and a free-form send then fails with 131047
 * and looks, from our side, exactly like a customer who ignored us.
 *
 * THE SHAPE, AND THE ASYMMETRY THAT FORCES IT.
 *
 *   in-window  → send the real interactive prompt now
 *   out-window → PARK the real prompt, send a generic template nudge
 *   next inbound → the window is open again; replay the parked prompt
 *
 * The middle step is not an optimisation. Sending a template does NOT re-open
 * the window — only the customer's reply does — so there is no moment at which
 * we may "send the template and then follow up". The prompt has to survive in
 * the database until they come back, which is what pending_prompt is for.
 */

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { whatsappOnboardingSessions } from "@/lib/db/schema";

import { getAdapter } from "./index";
import { logOutbound } from "./notifications";
import {
  loadSession,
  reply,
  replyList,
  setSession,
  type SessionRow,
} from "./session-store";
import {
  assertParamCount,
  resolveTemplate,
  type WaTemplateKey,
} from "./templates";
import type { ListRow, ReplyButton } from "./types";
import { inServiceWindow, oneLine, WA_MAX_WINDOW_NUDGES } from "./window";

/**
 * A prompt we can either send now or store and replay later.
 *
 * Deliberately data, not a closure: it has to round-trip through jsonb. Anything
 * that cannot be serialised (a PDF attachment, a freshly-minted OTP) must NOT be
 * parked — send those only in-window, or re-derive them at replay time.
 */
export type ParkedPrompt =
  | { kind: "text"; body: string; buttons?: ReplyButton[] }
  | { kind: "list"; body: string; button: string; rows: ListRow[] };

export interface NudgeSpec {
  template: WaTemplateKey;
  /** In template-spec order. Each is flattened by oneLine() before sending. */
  params: string[];
}

export type SendOrParkResult =
  | "sent"
  | "nudged"
  | "parked_silent"
  | "nudge_failed";

/** Send `prompt` if the window allows it; otherwise park it and ring the bell. */
export async function sendOrPark(
  session: SessionRow,
  prompt: ParkedPrompt,
  nudge: NudgeSpec,
): Promise<SendOrParkResult> {
  if (inServiceWindow(session)) {
    await sendPrompt(session, prompt);
    return "sent";
  }

  // Park first, send second. If the template send throws or the process dies
  // between the two, a parked prompt with no nudge is recoverable — the next
  // inbound replays it. A nudge with no parked prompt is not: the customer
  // replies "ok?" to a doorbell that leads nowhere.
  await parkPrompt(session.id, prompt);

  const tpl = resolveTemplate(nudge.template);
  if (!tpl) {
    // No approved template for this stage yet. Staying silent is the honest
    // outcome: the prompt is parked and will be delivered the moment the
    // customer says anything. Firing a free-form send here would be rejected
    // and would leave the parked prompt looking delivered.
    console.warn(
      `[WhatsApp/outbound] no approved template for "${nudge.template}"; prompt parked silently for session ${session.id}`,
    );
    return "parked_silent";
  }

  if ((session.window_nudges_sent ?? 0) >= WA_MAX_WINDOW_NUDGES) {
    // Meta scores the business down for unanswered templates and throttles the
    // number. Past the cap we keep parking and stop ringing.
    return "parked_silent";
  }

  assertParamCount(nudge.template, nudge.params);
  const params = nudge.params.map((p) => oneLine(p));

  const res = await getAdapter().sendTemplate(
    session.wa_phone,
    tpl.name,
    tpl.lang,
    params,
  );
  await logOutbound(session.id, res, {
    messageType: "template",
    textBody: params.join(" | "),
    templateName: tpl.name,
  });

  if (!res.ok) {
    console.error(
      `[WhatsApp/outbound] template "${tpl.name}" failed for ${session.wa_phone}:`,
      res.error,
    );
    return "nudge_failed";
  }

  await db
    .update(whatsappOnboardingSessions)
    .set({
      last_outbound_at: new Date(),
      window_nudges_sent: sql`${whatsappOnboardingSessions.window_nudges_sent} + 1`,
    })
    .where(eq(whatsappOnboardingSessions.id, session.id));

  return "nudged";
}

/**
 * Deliver anything parked for this session, then clear it.
 *
 * Called at the top of a turn, once the inbound message has already refreshed
 * `last_inbound_at` — which is the event that re-opened the window. Returns true
 * when a prompt was replayed, so the caller can skip its own state handling for
 * this turn: the customer's "hi" was an answer to the doorbell, not to whatever
 * state the session happens to be parked in.
 */
export async function replayParkedPrompt(
  session: SessionRow,
): Promise<boolean> {
  const parked = session.pending_prompt as ParkedPrompt | null;
  if (!parked) return false;

  // Clear first. A replay that fails mid-send must not leave the prompt armed
  // to fire again on every subsequent message.
  await clearParkedPrompt(session.id);

  try {
    await sendPrompt(session, parked);
    return true;
  } catch (err) {
    console.error("[WhatsApp/outbound] replay failed:", err);
    return false;
  }
}

export async function parkPrompt(
  sessionId: string,
  prompt: ParkedPrompt,
): Promise<void> {
  await db
    .update(whatsappOnboardingSessions)
    .set({
      pending_prompt: prompt as never,
      pending_prompt_at: new Date(),
    })
    .where(eq(whatsappOnboardingSessions.id, sessionId));
}

export async function clearParkedPrompt(sessionId: string): Promise<void> {
  await db
    .update(whatsappOnboardingSessions)
    .set({ pending_prompt: null, pending_prompt_at: null })
    .where(eq(whatsappOnboardingSessions.id, sessionId));
}

/**
 * The customer came back, so the window is open and the nudge budget resets.
 * Called from the inbound path alongside the last_inbound_at write.
 */
export async function onInboundResetNudges(sessionId: string): Promise<void> {
  await db
    .update(whatsappOnboardingSessions)
    .set({ window_nudges_sent: 0 })
    .where(eq(whatsappOnboardingSessions.id, sessionId));
}

async function sendPrompt(
  session: SessionRow,
  prompt: ParkedPrompt,
): Promise<void> {
  // Re-read: sendOrPark's caller may be holding a row fetched before an earlier
  // await, and reply() needs the current wa_phone.
  const fresh = (await loadSession(session.id)) ?? session;
  if (prompt.kind === "list") {
    await replyList(fresh, prompt.body, prompt.button, prompt.rows);
  } else {
    await reply(fresh, prompt.body, prompt.buttons);
  }
  await setSession(fresh.id, { last_outbound_at: new Date() });
}
