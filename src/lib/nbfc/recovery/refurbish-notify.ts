/**
 * E-270 / E-271 — refurbishment-lot notifications, both directions.
 *
 * Every move on a lot has to reach the OTHER dashboard: the NBFC sends a
 * batch and goes back to collections, the workshop repairs and goes back to
 * the bench. Each function fans one business event out to both parties with
 * per-recipient copy and a deep link into that party's own screen — the same
 * shape as src/lib/nbfc/scrap/notify.ts.
 *
 * BEST-EFFORT BY CONTRACT. `emit()` never throws; nothing here adds anything
 * that can. A notification is never the reason a move fails.
 */
import { ADMIN_AUDIENCE_ROLES, emit, type Recipient } from "@/lib/notifications/emit";
import { ADMIN_PARTY, SYSTEM_PARTY, nbfcParty } from "@/lib/notifications/provenance";
import type { Lot } from "@/lib/nbfc/recovery/refurbishment-lots";

const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${Math.round(n).toLocaleString("en-IN")}`);
const dmy = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";

const STAGE = "Refurbishment";
const adminHref = (l: Lot) => `/admin/nbfc/refurbishment?open=${l.id}`;
const nbfcHref = (l: Lot) => `/nbfc/recovery/refurbishment?open=${l.id}`;
const plural = (n: number) => (n === 1 ? "battery" : "batteries");
const lotLine = (l: Lot) => `${l.battery_count} ${plural(l.battery_count)} · ${l.ref_code}`;
const nbfcName = (l: Lot) => l.tenant_name ?? "The NBFC";

function adminRecipient(l: Lot, copy: Partial<Recipient> = {}): Recipient {
  return { audience: { kind: "roles", roles: ADMIN_AUDIENCE_ROLES }, as: ADMIN_PARTY, href: adminHref(l), ...copy };
}
function nbfcRecipient(l: Lot, copy: Partial<Recipient> = {}): Recipient {
  return { audience: { kind: "nbfc", tenantId: l.tenant_id }, as: nbfcParty(l.tenant_name ?? "NBFC"), href: nbfcHref(l), ...copy };
}
const baseData = (l: Lot) => ({ lot_id: l.id, ref_code: l.ref_code, battery_count: l.battery_count, status: l.status });

const pickupLine = (l: Lot) =>
  l.pickup_mode === "itarang_pickup"
    ? `iTarang will collect on ${dmy(l.scheduled_pickup_date)}`
    : `you ship to the workshop by ${dmy(l.expected_receipt_date)}`;

/** 1. NBFC sent a batch. Admin's move. */
export async function notifyRefurbRequested(l: Lot): Promise<void> {
  await emit({
    type: "refurb.lot_requested",
    title: `Refurbishment request: ${lotLine(l)}`,
    message: `${nbfcName(l)} wants ${l.battery_count} recovered ${plural(l.battery_count)} refurbished. Review each one, then send a quote.`,
    stage: STAGE,
    from: nbfcParty(l.tenant_name ?? "NBFC"),
    data: baseData(l),
    to: [
      adminRecipient(l),
      nbfcRecipient(l, { title: `Refurbishment ${l.ref_code} sent to iTarang`, message: `${lotLine(l)} is with the iTarang workshop. You will be told when they send a quote.` }),
    ],
  });
}

/** 3. Admin sent the quote (timeline, pickup plan, estimate, advance). NBFC's move. */
export async function notifyRefurbProposed(l: Lot, declinedCount: number): Promise<void> {
  const declined = declinedCount > 0 ? ` ${declinedCount} ${plural(declinedCount)} declined.` : "";
  const adv = l.advance_pct > 0 ? `, advance ${l.advance_pct}% (${inr(l.advance.amount)})` : "";
  const line = `${pickupLine(l)}, return by ${dmy(l.expected_return_date)}, estimate ${inr(l.estimated_total)}${adv}`;
  await emit({
    type: "refurb.lot_proposed",
    title: `Quote for ${l.ref_code}${l.current_round > 1 ? ` (round ${l.current_round})` : ""} — approve it`,
    message: `iTarang quotes: ${line} for ${lotLine(l)}.${declined} Approve the quote or ask for changes.`,
    stage: STAGE,
    from: ADMIN_PARTY,
    data: { ...baseData(l), round: l.current_round, estimated_total: l.estimated_total, advance_amount: l.advance.amount },
    to: [nbfcRecipient(l), adminRecipient(l, { title: `Your quote on ${l.ref_code} was sent`, message: `${line} — is with ${nbfcName(l)}.` })],
  });
}

/** 4b. NBFC pushed back. Admin's move. */
export async function notifyRefurbCountered(l: Lot, message: string | null): Promise<void> {
  const why = message?.trim() ? ` "${message.trim()}"` : "";
  await emit({
    type: "refurb.lot_countered",
    title: `${nbfcName(l)} wants changes on ${l.ref_code}`,
    message: `${nbfcName(l)} did not approve the quote for ${lotLine(l)}.${why} Send a revised quote.`,
    stage: STAGE,
    from: nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), round: l.current_round },
    to: [adminRecipient(l), nbfcRecipient(l, { title: `Your reply on ${l.ref_code} was sent`, message: `iTarang will send a revised quote.` })],
  });
}

/** 4a. NBFC approved the quote. What happens next depends on advance + pickup mode. */
export async function notifyRefurbAgreed(l: Lot): Promise<void> {
  const next =
    l.status === "awaiting_advance"
      ? `Advance of ${inr(l.advance.amount)} is now due before the batteries move.`
      : l.status === "pickup_scheduled"
        ? `iTarang will collect on ${dmy(l.scheduled_pickup_date)}.`
        : `${nbfcName(l)} will dispatch the batteries.`;
  await emit({
    type: "refurb.lot_agreed",
    title: `Quote approved — ${l.ref_code}`,
    message: `${lotLine(l)}: ${inr(l.quote_approved_total)} approved, return by ${dmy(l.expected_return_date)}. ${next}`,
    stage: STAGE,
    from: nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), quote_approved_total: l.quote_approved_total, advance_amount: l.advance.amount },
    to: [adminRecipient(l), nbfcRecipient(l)],
  });
  if (l.status === "awaiting_advance") await notifyRefurbAdvanceDue(l);
}

/** Money: the NBFC owes an advance / balance. */
export async function notifyRefurbAdvanceDue(l: Lot): Promise<void> {
  await emit({
    type: "refurb.advance_due",
    title: `Advance due on ${l.ref_code}: ${inr(l.advance.amount)}`,
    message: `Pay the ${l.advance_pct}% advance (${inr(l.advance.amount)}) online or by bank transfer and record the reference. The batteries move once iTarang confirms it.`,
    stage: STAGE,
    from: ADMIN_PARTY,
    data: { ...baseData(l), amount: l.advance.amount },
    to: [nbfcRecipient(l), adminRecipient(l, { email: false, message: `${nbfcName(l)} owes an advance of ${inr(l.advance.amount)} on ${l.ref_code}.` })],
  });
}
export async function notifyRefurbBalanceDue(l: Lot): Promise<void> {
  await emit({
    type: "refurb.balance_due",
    title: `Balance due on ${l.ref_code}: ${inr(l.balance.amount)}`,
    message: `Final bill ${inr(l.final_total)} less advance ${inr(l.advance.amount)} = ${inr(l.balance.amount)}. Pay online or by bank transfer and record the reference.`,
    stage: STAGE,
    from: ADMIN_PARTY,
    data: { ...baseData(l), amount: l.balance.amount, final_total: l.final_total },
    to: [nbfcRecipient(l), adminRecipient(l, { email: false, message: `${nbfcName(l)} owes a balance of ${inr(l.balance.amount)} on ${l.ref_code}.` })],
  });
}

/** Money: the NBFC recorded a bank transfer — admin must confirm. */
export async function notifyRefurbPaymentRecorded(l: Lot, leg: "advance" | "balance"): Promise<void> {
  const m = leg === "advance" ? l.advance : l.balance;
  await emit({
    type: "refurb.payment_recorded",
    title: `${nbfcName(l)} recorded the ${leg} on ${l.ref_code}`,
    message: `${inr(m.amount)} by bank transfer, reference ${m.reference ?? "—"}. Confirm it once the money shows in the account.`,
    stage: STAGE,
    from: nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), leg, amount: m.amount, reference: m.reference },
    to: [adminRecipient(l), nbfcRecipient(l, { email: false, title: `${leg} recorded on ${l.ref_code}`, message: `iTarang will confirm ${inr(m.amount)} (ref ${m.reference ?? "—"}).` })],
  });
}

/** Money: confirmed (online or admin-confirmed). Says what unlocked. */
export async function notifyRefurbPaymentConfirmed(l: Lot, leg: "advance" | "balance"): Promise<void> {
  const m = leg === "advance" ? l.advance : l.balance;
  const next =
    leg === "balance"
      ? "The lot is settled."
      : l.status === "pickup_scheduled"
        ? `iTarang will collect on ${dmy(l.scheduled_pickup_date)}.`
        : `${nbfcName(l)} can dispatch the batteries.`;
  await emit({
    type: leg === "balance" ? "refurb.settled" : "refurb.advance_confirmed",
    title: leg === "balance" ? `Refurbishment ${l.ref_code} settled` : `Advance confirmed on ${l.ref_code}`,
    message: `${inr(m.amount)} ${leg} received${m.provider === "razorpay" ? " online" : ""}. ${next}`,
    stage: STAGE,
    from: SYSTEM_PARTY,
    data: { ...baseData(l), leg, amount: m.amount, provider: m.provider },
    to: [adminRecipient(l), nbfcRecipient(l)],
  });
}

/** Either side called it off before anything moved. */
export async function notifyRefurbCancelled(l: Lot, by: "nbfc" | "admin", reason: string | null): Promise<void> {
  const why = reason?.trim() ? ` Reason: ${reason.trim()}` : "";
  const refund = l.advance.status === "confirmed" ? ` An advance of ${inr(l.advance.amount)} was already paid and needs to be refunded.` : "";
  await emit({
    type: "refurb.lot_cancelled",
    title: `Refurbishment ${l.ref_code} cancelled`,
    message: `${by === "admin" ? "iTarang" : nbfcName(l)} cancelled ${lotLine(l)}.${why} The batteries are back at inspected.${refund}`,
    stage: STAGE,
    from: by === "admin" ? ADMIN_PARTY : nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), by },
    to: [adminRecipient(l), nbfcRecipient(l)],
  });
}

/** 5 / 8. A truck left — NBFC dispatched, iTarang picked up, or iTarang sent it back. */
export async function notifyRefurbDispatched(l: Lot, leg: "out" | "return", how: "dispatched" | "picked_up" = "dispatched"): Promise<void> {
  const g = leg === "out" ? l.out : l.ret;
  const transport = [g.carrier, g.vehicle_no, g.docket_no ? `docket ${g.docket_no}` : null, g.eway_bill_no ? `e-way bill ${g.eway_bill_no}` : null].filter(Boolean).join(" · ");
  const line = `${lotLine(l)} on ${dmy(g.dispatched_on)}${transport ? ` — ${transport}` : ""}`;
  const byNbfc = leg === "out" && how === "dispatched";
  await emit({
    type: "refurb.lot_dispatched",
    title: leg === "out" ? (how === "picked_up" ? `Picked up by iTarang: ${l.ref_code}` : `Batteries on the way: ${l.ref_code}`) : `Refurbished batteries on the way back: ${l.ref_code}`,
    message:
      leg === "out"
        ? how === "picked_up"
          ? `iTarang collected ${line}. Now in transit to the workshop.`
          : `${nbfcName(l)} dispatched ${line}. Mark it arrived when the truck reaches the workshop, then check each battery.`
        : `iTarang dispatched ${line}. Mark it arrived when the truck reaches you, then check each battery.`,
    stage: STAGE,
    from: byNbfc ? nbfcParty(l.tenant_name ?? "NBFC") : ADMIN_PARTY,
    data: { ...baseData(l), leg, how, docket_no: g.docket_no, eway_bill_no: g.eway_bill_no },
    to: byNbfc
      ? [adminRecipient(l), nbfcRecipient(l, { title: `Dispatch recorded for ${l.ref_code}`, message: `${line}. iTarang will confirm arrival and receipt.` })]
      : leg === "out"
        ? [nbfcRecipient(l), adminRecipient(l, { email: false, title: `Pickup recorded for ${l.ref_code}`, message: line })]
        : [nbfcRecipient(l), adminRecipient(l, { title: `Return dispatch recorded for ${l.ref_code}`, message: `${line}. ${nbfcName(l)} will confirm arrival and receipt.` })],
  });
}

/** The truck reached the gate (review point 8). FYI to the sender. */
export async function notifyRefurbArrived(l: Lot, leg: "out" | "return"): Promise<void> {
  await emit({
    type: "refurb.lot_arrived",
    title: leg === "out" ? `${l.ref_code} arrived at the workshop` : `${l.ref_code} arrived at ${nbfcName(l)}`,
    message: leg === "out" ? `iTarang marked ${lotLine(l)} arrived. Battery-by-battery receipt follows.` : `${nbfcName(l)} marked ${lotLine(l)} arrived. Battery-by-battery receipt follows.`,
    stage: STAGE,
    from: leg === "out" ? ADMIN_PARTY : nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), leg },
    to: leg === "out" ? [nbfcRecipient(l), adminRecipient(l, { email: false })] : [adminRecipient(l), nbfcRecipient(l, { email: false })],
  });
}

/** 6 / 9. A receipt was signed. Mismatch copy is deliberately loud. */
export async function notifyRefurbReceived(l: Lot, leg: "out" | "return", tally: { received: number; damaged: number; missing: number }): Promise<void> {
  const problems = [tally.damaged ? `${tally.damaged} damaged` : null, tally.missing ? `${tally.missing} missing` : null].filter(Boolean).join(", ");
  const summary = `${tally.received} received${problems ? `, ${problems}` : ""}`;
  const done = l.status === "settled" || l.status === "balance_due";
  await emit({
    type: leg === "return" && done ? "refurb.lot_completed" : "refurb.lot_received",
    title: leg === "out" ? `${problems ? "⚠ " : ""}Workshop received ${l.ref_code}: ${summary}` : `${problems ? "⚠ " : ""}${nbfcName(l)} received ${l.ref_code}: ${summary}`,
    message:
      leg === "out"
        ? `iTarang signed for ${lotLine(l)} — ${summary}.${problems ? " Please check the receipt notes and photographs." : " Work starts next."}`
        : `${nbfcName(l)} signed for ${lotLine(l)} — ${summary}.${problems ? " The flagged batteries need your attention." : " The refurbished batteries are ready for auction."}${
            l.status === "balance_due" ? ` Balance of ${inr(l.balance.amount)} is now due.` : l.status === "settled" ? " Nothing further is owed — the lot is settled." : ""
          }`,
    stage: STAGE,
    from: leg === "out" ? ADMIN_PARTY : nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), leg, ...tally },
    to: [adminRecipient(l), nbfcRecipient(l)],
  });
  if (l.status === "balance_due") await notifyRefurbBalanceDue(l);
}

/** 7. Workshop started. FYI to the NBFC. */
export async function notifyRefurbWorkStarted(l: Lot): Promise<void> {
  await emit({
    type: "refurb.work_started",
    title: `Work started on ${l.ref_code}`,
    message: `The iTarang workshop has started on ${lotLine(l)}. Expected return by ${dmy(l.expected_return_date)}.`,
    stage: STAGE,
    from: SYSTEM_PARTY,
    data: baseData(l),
    to: [nbfcRecipient(l), adminRecipient(l, { email: false })],
  });
}

/** Revision (review points 2/5): admin asks for more than the approved quote. */
export async function notifyRefurbQuoteRevised(l: Lot): Promise<void> {
  await emit({
    type: "refurb.quote_revised",
    title: `Revised quote on ${l.ref_code}: ${inr(l.revised_total)} (approved ${inr(l.quote_approved_total)})`,
    message: `iTarang asks to raise the approved quote from ${inr(l.quote_approved_total)} to ${inr(l.revised_total)}.${l.revision_note ? ` "${l.revision_note}"` : ""} Approve or reject — the batteries cannot ship back until this is answered.`,
    stage: STAGE,
    from: ADMIN_PARTY,
    data: { ...baseData(l), approved_total: l.quote_approved_total, revised_total: l.revised_total, round: l.revision_round },
    to: [nbfcRecipient(l), adminRecipient(l, { email: false, title: `Revised quote on ${l.ref_code} sent`, message: `${inr(l.revised_total)} is with ${nbfcName(l)}.` })],
  });
}
export async function notifyRefurbRevisionAnswered(l: Lot, kind: "approve" | "reject", message: string | null): Promise<void> {
  const why = message?.trim() ? ` "${message.trim()}"` : "";
  await emit({
    type: "refurb.revision_answered",
    title: kind === "approve" ? `Revised quote approved on ${l.ref_code}: ${inr(l.quote_approved_total)}` : `Revised quote rejected on ${l.ref_code}`,
    message:
      kind === "approve"
        ? `${nbfcName(l)} approved the revised total of ${inr(l.quote_approved_total)}.${why} Finish the work and mark the batteries ready.`
        : `${nbfcName(l)} rejected the revision.${why} The approved quote stays at ${inr(l.quote_approved_total)} — the bill must fit within it.`,
    stage: STAGE,
    from: nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), kind, approved_total: l.quote_approved_total },
    to: [adminRecipient(l), nbfcRecipient(l, { email: false })],
  });
}

/** Free-form message in the thread. Tells the other side only. */
export async function notifyRefurbMessage(l: Lot, by: "nbfc" | "admin", message: string): Promise<void> {
  await emit({
    type: "refurb.lot_message",
    title: `Message on refurbishment ${l.ref_code}`,
    message: `${by === "admin" ? "iTarang" : nbfcName(l)}: ${message.trim().slice(0, 300)}`,
    stage: STAGE,
    from: by === "admin" ? ADMIN_PARTY : nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), by },
    to: by === "admin" ? [nbfcRecipient(l)] : [adminRecipient(l)],
  });
}
