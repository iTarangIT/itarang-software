/**
 * 23 Nov 2026 (Battery Pool, task 6) — loan amount + NBFC scheme at the FIRST
 * customer-file upload on WhatsApp.
 *
 * Before the "Submit to iTarang" button is shown on a finance lead that has
 * no loan amount yet, the chat asks for it — it is mandatory (askLoanBeforeSubmit,
 * called from promptSubmitToITarang). The Submit tap keeps a safety-net check. It is written to leads.requested_loan_amount, so the later
 * "How much loan do you want?" step in the Step-4 cart is skipped (see
 * dispatch-flow askLoanAmount).
 *
 * When the person on the chat is an iTarang admin / sales head (their
 * whatsapp_operators row is linked to such a login), the chat then offers the
 * NBFC schemes the BRE allows for this lead; the pick is saved in
 * lead_scheme_picks and beats the routing rules when Step 4 opens. "Automatic"
 * leaves it to the rules.
 *
 * The orchestrator registers promptSubmitToITarang as the continuation, so
 * after the amount (and scheme) the Submit button appears.
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { leads, users, whatsappOperators } from "@/lib/db/schema";
import {
  MAX_REQUESTED_LOAN,
  MIN_REQUESTED_LOAN,
  formatRupees,
  parseRupees,
  setRequestedLoanAmount,
} from "@/lib/leads/requested-loan-amount";
import { listSchemeOptions, mayPickScheme, setLeadSchemePick } from "@/lib/leads/scheme-pick";

import { registerLeadState } from "./lead-states";
import { loadSession, mergeContext, reply, replyList, setSession, type SessionRow } from "./session-store";
import type { InboundEvent, ListRow } from "./types";

export const DC_LEAD_LOAN_AMT = "DC_LEAD_LOAN_AMT";
export const DC_LEAD_SCHEME_PICK = "DC_LEAD_SCHEME_PICK";

type Continue = (session: SessionRow) => Promise<void>;
let finalize: Continue | null = null;
/** The orchestrator hands in promptSubmitToITarang (shows the Submit button). */
export function registerIntakeContinuation(fn: Continue): void {
  finalize = fn;
}

function leadIdOf(session: SessionRow): string | null {
  const ctx = (session.context ?? {}) as { lead?: { leadId?: string } };
  return ctx.lead?.leadId ?? null;
}

/** The iTarang login behind this WhatsApp number, if it is an operator. */
async function operatorLogin(waPhone: string): Promise<{ userId: string; name: string; role: string | null } | null> {
  const [op] = await db
    .select({ userId: whatsappOperators.user_id, name: whatsappOperators.display_name })
    .from(whatsappOperators)
    .where(and(eq(whatsappOperators.wa_phone, waPhone), eq(whatsappOperators.is_active, true)))
    .limit(1);
  if (!op?.userId) return null;
  const [u] = await db.select({ role: users.role, name: users.name }).from(users).where(eq(users.id, op.userId)).limit(1);
  return { userId: op.userId, name: u?.name || op.name, role: u?.role ?? null };
}

async function leadFacts(leadId: string) {
  const [l] = await db
    .select({ payment_method: leads.payment_method, requested_loan_amount: leads.requested_loan_amount })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  return l ?? null;
}

/** Finance lead, uploaded by a salesperson / dealer (not a self-serve customer). */
async function needsIntake(session: SessionRow): Promise<{ leadId: string; hasAmount: boolean } | null> {
  const leadId = leadIdOf(session);
  if (!leadId) return null;
  const ctx = (session.context ?? {}) as { flow?: string; op?: unknown };
  // A self-serve customer chat is not the salesperson's upload.
  if (ctx.flow === "customer" && !ctx.op) return null;
  const lead = await leadFacts(leadId);
  if (!lead || String(lead.payment_method ?? "").toLowerCase() !== "finance") return null;
  return { leadId, hasAmount: lead.requested_loan_amount != null };
}

/**
 * Called just BEFORE the "Submit to iTarang" button is shown. Asks the loan
 * amount when it is missing, then (admin / sales head only, once per lead) the
 * NBFC scheme. Returns true when it took over the chat; the continuation shows
 * the Submit button afterwards.
 */
export async function askLoanBeforeSubmit(session: SessionRow): Promise<boolean> {
  const need = await needsIntake(session);
  if (!need) return false;
  if (!need.hasAmount) {
    await askAmount(session);
    return true;
  }
  const ctx = (session.context ?? {}) as { lead?: { schemeAskedFor?: string } };
  if (ctx.lead?.schemeAskedFor === need.leadId) return false;
  return await maybeAskScheme(session, need.leadId);
}

/**
 * Safety net on the "Submit to iTarang" tap: a finance file never goes in
 * without the loan amount. True when it asked (the caller must stop).
 */
export async function interceptSubmitForLoanAmount(session: SessionRow): Promise<boolean> {
  const need = await needsIntake(session);
  if (!need || need.hasAmount) return false;
  await askAmount(session);
  return true;
}

async function askAmount(session: SessionRow, prefix = ""): Promise<void> {
  await setSession(session.id, { current_state: DC_LEAD_LOAN_AMT });
  await reply(
    session,
    `${prefix}💰 *Loan amount (required)*\n\n` +
      "How much loan does the customer need? Reply with an amount — e.g. *60000* or *1.5 lakh*.\n\n" +
      "_It goes with the file to the lender, so the dealer is not asked again later._",
  );
}

async function onLoanAmount(session: SessionRow, event: InboundEvent): Promise<void> {
  const leadId = leadIdOf(session);
  if (!leadId) return await setSession(session.id, { current_state: "DC_MENU" });
  const amount = parseRupees((event.text ?? "").trim());
  if (amount == null || amount < MIN_REQUESTED_LOAN || amount > MAX_REQUESTED_LOAN) {
    return await askAmount(
      session,
      `⚠️ Please send an amount between ${formatRupees(MIN_REQUESTED_LOAN)} and ${formatRupees(MAX_REQUESTED_LOAN)}.\n\n`,
    );
  }
  await setRequestedLoanAmount(leadId, amount);
  await reply(session, `✅ Loan amount noted: *${formatRupees(amount)}*.`);
  const fresh = await loadSession(session.id);
  if (await maybeAskScheme(fresh, leadId)) return;
  await submit(fresh);
}

/** Admin / sales head on the chat → offer the schemes. True when asked. */
async function maybeAskScheme(session: SessionRow, leadId: string): Promise<boolean> {
  const who = await operatorLogin(session.wa_phone);
  if (!who || !mayPickScheme(who.role)) return false;
  const options = await listSchemeOptions(leadId).catch(() => []);
  if (!options.length) return false;
  // Asked once per lead — the continuation re-enters askLoanBeforeSubmit.
  await mergeContext(session, (c) => {
    const ctx = c as { lead?: Record<string, unknown> };
    ctx.lead = { ...(ctx.lead ?? {}), schemeAskedFor: leadId };
  });
  const rows: ListRow[] = [
    { id: "sch:auto", title: "Automatic", description: "Let the NBFC routing rules decide" },
    ...options.slice(0, 9).map((o) => ({
      id: `sch:${o.nbfcId}:${o.loanProductId}`,
      title: o.label.slice(0, 24),
      description: `${o.label.length > 24 ? o.label.slice(24, 40) + " · " : ""}${o.detail}`.slice(0, 72),
    })),
  ];
  await setSession(session.id, { current_state: DC_LEAD_SCHEME_PICK });
  await replyList(
    session,
    "🏦 *Choose the NBFC scheme* (sales head)\n\nPick the lender + scheme this file should go to, or *Automatic* for the routing rules.",
    "Choose scheme",
    rows,
  );
  return true;
}

async function onSchemePick(session: SessionRow, event: InboundEvent): Promise<void> {
  const leadId = leadIdOf(session);
  if (!leadId) return await setSession(session.id, { current_state: "DC_MENU" });
  const id = (event.text ?? "").trim();
  if (id === "sch:auto" || /^auto/i.test(id)) {
    await setLeadSchemePick({ leadId, pick: null, byUserId: null, byName: null, channel: "whatsapp" });
    await reply(session, "✅ The NBFC routing rules will choose the lender.");
    return await submit(await loadSession(session.id));
  }
  const m = /^sch:(\d+):(\d+)$/.exec(id);
  if (!m) {
    await reply(session, "Please tap *Choose scheme* and pick one of the options.");
    return void (await maybeAskScheme(session, leadId));
  }
  const who = await operatorLogin(session.wa_phone);
  if (!who || !mayPickScheme(who.role)) return await submit(session);
  try {
    const r = await setLeadSchemePick({
      leadId,
      pick: { nbfcId: Number(m[1]), loanProductId: Number(m[2]) },
      byUserId: who.userId,
      byName: who.name,
      channel: "whatsapp",
    });
    await reply(session, `✅ Scheme set: *${r.label}*. The file goes to this lender when it reaches Step 4.`);
  } catch (err) {
    await reply(session, `⚠️ ${err instanceof Error ? err.message : "That scheme could not be saved"}.`);
    return void (await maybeAskScheme(session, leadId));
  }
  await submit(await loadSession(session.id));
}

async function submit(session: SessionRow): Promise<void> {
  if (!finalize) {
    console.error("[intake-loan] no submit continuation registered");
    return;
  }
  await finalize(session);
}

registerLeadState(DC_LEAD_LOAN_AMT, (s, e) => onLoanAmount(s, e), { rerenderOnGreeting: true });
registerLeadState(DC_LEAD_SCHEME_PICK, (s, e) => onSchemePick(s, e));
