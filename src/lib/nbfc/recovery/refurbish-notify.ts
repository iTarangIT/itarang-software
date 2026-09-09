/**
 * E-292 — refurbishment-lot notifications, all three directions.
 *
 * Every move on a lot has to reach the OTHER side: the NBFC sends a batch and
 * goes back to collections, iTarang admin runs the desk, the refurbisher
 * works in its own portal. Each function fans one business event out with
 * per-recipient copy and a deep link into that party's own screen — the same
 * shape as src/lib/nbfc/scrap/notify.ts.
 *
 * TWO WALLS, SAME AS THE DATA. The NBFC is never told who the refurbisher is
 * (steps 10–12 are "internal"); the refurbisher is never told a rupee figure
 * that belongs to the NBFC (PI, advance, balance, margin).
 *
 * BEST-EFFORT BY CONTRACT. `emit()` never throws; nothing here adds anything
 * that can. A notification is never the reason a move fails.
 */
import { ADMIN_AUDIENCE_ROLES, emit, type Recipient } from "@/lib/notifications/emit";
import { ADMIN_PARTY, SYSTEM_PARTY, nbfcParty, refurbisherParty } from "@/lib/notifications/provenance";
import type { Lot } from "@/lib/nbfc/recovery/refurbishment-lots";

const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${Math.round(n).toLocaleString("en-IN")}`);
const dmy = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";

const STAGE = "Refurbishment";
const adminHref = (l: Lot) => `/admin/nbfc/refurbishment?open=${l.id}`;
const nbfcHref = (l: Lot) => `/nbfc/recovery/refurbishment?open=${l.id}`;
const refHref = (l: Lot) => `/refurbisher-portal/lots/${l.id}`;
const plural = (n: number) => (n === 1 ? "battery" : "batteries");
const lotLine = (l: Lot) => `${l.battery_count} ${plural(l.battery_count)} · ${l.ref_code}`;
const nbfcName = (l: Lot) => l.tenant_name ?? "The NBFC";
const refName = (l: Lot) => l.refurbisher?.name ?? "the refurbisher";

function adminRecipient(l: Lot, copy: Partial<Recipient> = {}): Recipient {
  return { audience: { kind: "roles", roles: ADMIN_AUDIENCE_ROLES }, as: ADMIN_PARTY, href: adminHref(l), ...copy };
}
function nbfcRecipient(l: Lot, copy: Partial<Recipient> = {}): Recipient {
  return { audience: { kind: "nbfc", tenantId: l.tenant_id }, as: nbfcParty(l.tenant_name ?? "NBFC"), href: nbfcHref(l), ...copy };
}
function refurbisherRecipient(l: Lot, copy: Partial<Recipient> = {}): Recipient | null {
  if (!l.refurbisher) return null;
  return { audience: { kind: "refurbisher", refurbisherId: l.refurbisher.id }, as: refurbisherParty(l.refurbisher.name), href: refHref(l), ...copy };
}
const baseData = (l: Lot) => ({ lot_id: l.id, ref_code: l.ref_code, battery_count: l.battery_count, status: l.status });
const compact = (xs: Array<Recipient | null>) => xs.filter((x): x is Recipient => !!x);

const pickupLine = (l: Lot) =>
  l.pickup_mode === "itarang_pickup"
    ? `iTarang will collect${l.scheduled_pickup_date ? ` on ${dmy(l.scheduled_pickup_date)}` : ""}`
    : `you ship to iTarang by ${dmy(l.expected_receipt_date)}`;

/** 1. NBFC sent a batch. Admin's move. */
export async function notifyRefurbRequested(l: Lot): Promise<void> {
  await emit({
    type: "refurb.lot_requested",
    title: `Refurbishment request: ${lotLine(l)}`,
    message: `${nbfcName(l)} wants ${l.battery_count} recovered ${plural(l.battery_count)} refurbished. Review each one, then send an estimate.`,
    stage: STAGE,
    from: nbfcParty(l.tenant_name ?? "NBFC"),
    data: baseData(l),
    to: [
      adminRecipient(l),
      nbfcRecipient(l, { title: `Refurbishment ${l.ref_code} sent to iTarang`, message: `${lotLine(l)} is with iTarang. You will be told when they review it and send an estimate.` }),
    ],
  });
}

/** 2. Admin reviewed — some batteries declined. FYI to the NBFC. */
export async function notifyRefurbReviewed(l: Lot, declinedCount: number, reasons: string[]): Promise<void> {
  if (declinedCount === 0) return;
  await emit({
    type: "refurb.lot_reviewed",
    title: `${declinedCount} ${plural(declinedCount)} declined on ${l.ref_code}`,
    message: `iTarang reviewed ${l.ref_code} and declined ${declinedCount} ${plural(declinedCount)}${reasons.length ? ` — ${reasons.slice(0, 3).join("; ")}` : ""}. ${l.battery_count ? `The other ${l.battery_count} go ahead; an estimate follows.` : "Nothing is left in the lot."} Declined batteries are back at inspected — fix the issue and resubmit.`,
    stage: STAGE,
    from: ADMIN_PARTY,
    data: { ...baseData(l), declined: declinedCount },
    to: [nbfcRecipient(l), adminRecipient(l, { email: false })],
  });
}

/** 3. Admin sent the estimate (timeline, pickup plan, costing, advance %). NBFC's move. */
export async function notifyRefurbEstimated(l: Lot): Promise<void> {
  const adv = l.advance_pct > 0 ? `, advance ${l.advance_pct}% (${inr(l.advance.amount)})` : "";
  const line = `${pickupLine(l)}, return by ${dmy(l.expected_return_date)}, estimate ${inr(l.estimated_total)}${adv}`;
  await emit({
    type: "refurb.lot_proposed",
    title: `Estimate for ${l.ref_code}${l.current_round > 1 ? ` (round ${l.current_round})` : ""} — accept or negotiate`,
    message: `iTarang estimates: ${line} for ${lotLine(l)}. Accept, or counter on cost, timeline or advance.`,
    stage: STAGE,
    from: ADMIN_PARTY,
    data: { ...baseData(l), round: l.current_round, estimated_total: l.estimated_total, advance_amount: l.advance.amount },
    to: [nbfcRecipient(l), adminRecipient(l, { email: false, title: `Your estimate on ${l.ref_code} was sent`, message: `${line} — is with ${nbfcName(l)}.` })],
  });
}

/** 4b. NBFC countered. Admin's move. */
export async function notifyRefurbCountered(l: Lot, message: string | null): Promise<void> {
  const asks = [
    l.counter.total != null ? `cost ${inr(l.counter.total)}` : null,
    l.counter.advance_pct != null ? `advance ${l.counter.advance_pct}%` : null,
    l.counter.receipt_date ? `receive ${dmy(l.counter.receipt_date)}` : null,
    l.counter.return_date ? `return ${dmy(l.counter.return_date)}` : null,
  ].filter(Boolean).join(" · ");
  const why = message?.trim() ? ` "${message.trim()}"` : "";
  await emit({
    type: "refurb.lot_countered",
    title: `${nbfcName(l)} counters on ${l.ref_code}`,
    message: `${nbfcName(l)} did not accept the estimate for ${lotLine(l)}.${asks ? ` Asks: ${asks}.` : ""}${why} Send a revised estimate.`,
    stage: STAGE,
    from: nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), round: l.current_round, counter_total: l.counter.total, counter_advance_pct: l.counter.advance_pct },
    to: [adminRecipient(l), nbfcRecipient(l, { email: false, title: `Your counter on ${l.ref_code} was sent`, message: `iTarang will send a revised estimate.` })],
  });
}

/** 4a. NBFC accepted the estimate. Admin owes the PI. */
export async function notifyRefurbAgreed(l: Lot): Promise<void> {
  await emit({
    type: "refurb.lot_agreed",
    title: `Estimate accepted — ${l.ref_code}`,
    message: `${lotLine(l)}: ${inr(l.quote_approved_total)} agreed, return by ${dmy(l.expected_return_date)}. Upload the proforma invoice next.`,
    stage: STAGE,
    from: nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), agreed_total: l.quote_approved_total },
    to: [adminRecipient(l), nbfcRecipient(l, { email: false, message: `You accepted ${inr(l.quote_approved_total)}. iTarang will send the proforma invoice.` })],
  });
}

/** 5. Admin sent the PI. NBFC's move. */
export async function notifyRefurbPiSent(l: Lot, resent: boolean): Promise<void> {
  const adv = (l.pi.advance_pct ?? 0) > 0 ? ` Advance ${l.pi.advance_pct}% (${inr(l.pi.advance_amount)}) is payable before the batteries move.` : " No advance — the batteries can move once you accept.";
  await emit({
    type: "refurb.pi_sent",
    title: `${resent ? "Revised proforma" : "Proforma"} invoice ${l.pi.number ?? ""} for ${l.ref_code}: ${inr(l.pi.amount)}`,
    message: `iTarang sent a proforma invoice of ${inr(l.pi.amount)} for ${lotLine(l)}.${adv} Open it, check the terms and accept.`,
    stage: STAGE,
    from: ADMIN_PARTY,
    data: { ...baseData(l), pi_number: l.pi.number, pi_amount: l.pi.amount, advance_amount: l.pi.advance_amount },
    to: [nbfcRecipient(l), adminRecipient(l, { email: false, title: `PI ${l.pi.number ?? ""} sent on ${l.ref_code}`, message: `${inr(l.pi.amount)} is with ${nbfcName(l)}.` })],
  });
}

/** 6. NBFC accepted the PI. Money or the truck is next. */
export async function notifyRefurbPiAccepted(l: Lot): Promise<void> {
  const next =
    l.advance.status === "pending"
      ? `Advance of ${inr(l.advance.amount)} is now due into iTarang's account; record the UTR once paid.`
      : l.pickup_mode === "itarang_pickup"
        ? "No advance — iTarang will collect the batteries."
        : "No advance — dispatch the batteries when ready.";
  await emit({
    type: "refurb.pi_accepted",
    title: `PI accepted — ${l.ref_code}`,
    message: `${nbfcName(l)} accepted proforma invoice ${l.pi.number ?? ""} for ${inr(l.pi.amount)}. ${next}`,
    stage: STAGE,
    from: nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), pi_amount: l.pi.amount, advance_amount: l.advance.amount },
    to: [adminRecipient(l), nbfcRecipient(l)],
  });
  if (l.advance.status === "pending") await notifyRefurbAdvanceDue(l);
}

/** Money: the NBFC owes an advance / balance. */
export async function notifyRefurbAdvanceDue(l: Lot): Promise<void> {
  const bank = l.pi.bank_details;
  const into = bank?.account_number ? ` A/c ${bank.account_number}${bank.ifsc ? ` · IFSC ${bank.ifsc}` : ""}${bank.bank_name ? ` (${bank.bank_name})` : ""}.` : bank?.upi ? ` UPI ${bank.upi}.` : "";
  await emit({
    type: "refurb.advance_due",
    title: `Advance due on ${l.ref_code}: ${inr(l.advance.amount)}`,
    message: `Pay the ${l.advance_pct}% advance (${inr(l.advance.amount)}) by bank transfer and record the UTR.${into} The batteries move once iTarang marks it received.`,
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
    message: `Final bill ${inr(l.final_total)} less advance ${inr(l.advance.status === "confirmed" ? l.advance.amount : 0)} = ${inr(l.balance.amount)}. Pay by bank transfer and record the UTR; iTarang marks it received.`,
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
    message: `${inr(m.amount)} by bank transfer, reference ${m.reference ?? "—"}. Mark it received once the money shows in the account.`,
    stage: STAGE,
    from: nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), leg, amount: m.amount, reference: m.reference },
    to: [adminRecipient(l), nbfcRecipient(l, { email: false, title: `${leg} recorded on ${l.ref_code}`, message: `iTarang will confirm ${inr(m.amount)} (ref ${m.reference ?? "—"}).` })],
  });
}

/** Money: admin marked "amount received". Says what unlocked. */
export async function notifyRefurbPaymentConfirmed(l: Lot, leg: "advance" | "balance"): Promise<void> {
  const m = leg === "advance" ? l.advance : l.balance;
  // E-293: the balance is usually confirmed BEFORE the return truck; the lot
  // settles only once the NBFC signs for the batteries back.
  const settled = leg === "balance" && l.status === "settled";
  const next =
    leg === "balance"
      ? settled
        ? "The lot is settled — choose redeploy or auction to close it."
        : "The batteries can now ship back to you."
      : l.pickup_mode === "itarang_pickup"
        ? `iTarang will collect${l.scheduled_pickup_date ? ` on ${dmy(l.scheduled_pickup_date)}` : ""}.`
        : `${nbfcName(l)} can dispatch the batteries.`;
  await emit({
    type: leg === "balance" ? "refurb.settled" : "refurb.advance_confirmed",
    title: leg === "balance" ? (settled ? `Refurbishment ${l.ref_code} settled` : `Balance received on ${l.ref_code}`) : `Advance received on ${l.ref_code}`,
    message: `${inr(m.amount)} ${leg} received${m.reference ? ` (ref ${m.reference})` : ""}. ${next}`,
    stage: STAGE,
    from: ADMIN_PARTY,
    data: { ...baseData(l), leg, amount: m.amount },
    to: [nbfcRecipient(l), adminRecipient(l, { email: false })],
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

/** 8a / 8b / 14. A truck left — NBFC dispatched, iTarang picked up, or the batteries are on the way back. */
export async function notifyRefurbDispatched(l: Lot, leg: "out" | "return", how: "dispatched" | "picked_up" = "dispatched", by: "nbfc" | "admin" | "refurbisher" = leg === "out" ? (how === "picked_up" ? "admin" : "nbfc") : "admin"): Promise<void> {
  const g = leg === "out" ? l.out : l.ret;
  const transport = [g.carrier, g.vehicle_no, g.docket_no ? `docket ${g.docket_no}` : null, g.eway_bill_no ? `e-way bill ${g.eway_bill_no}` : null].filter(Boolean).join(" · ");
  const line = `${lotLine(l)} on ${dmy(g.dispatched_on)}${transport ? ` — ${transport}` : ""}`;
  const from = by === "nbfc" ? nbfcParty(l.tenant_name ?? "NBFC") : by === "refurbisher" ? refurbisherParty(refName(l)) : ADMIN_PARTY;
  await emit({
    type: "refurb.lot_dispatched",
    title: leg === "out" ? (how === "picked_up" ? `Picked up by iTarang: ${l.ref_code}` : `Batteries on the way: ${l.ref_code}`) : `Refurbished batteries on the way back: ${l.ref_code}`,
    message:
      leg === "out"
        ? how === "picked_up"
          ? `iTarang collected ${line}. Now in transit to iTarang.`
          : `${nbfcName(l)} dispatched ${line}. Mark it arrived when the truck reaches you, then check each battery.`
        : `iTarang dispatched ${line}. Mark it arrived when the truck reaches you, then check each battery.`,
    stage: STAGE,
    from,
    data: { ...baseData(l), leg, how, by, docket_no: g.docket_no, eway_bill_no: g.eway_bill_no },
    to:
      leg === "out"
        ? by === "nbfc"
          ? [adminRecipient(l), nbfcRecipient(l, { email: false, title: `Dispatch recorded for ${l.ref_code}`, message: `${line}. iTarang will confirm receipt.` })]
          : [nbfcRecipient(l), adminRecipient(l, { email: false, title: `Pickup recorded for ${l.ref_code}`, message: line })]
        : compact([nbfcRecipient(l), adminRecipient(l, { email: by !== "admin", title: `Return dispatch recorded for ${l.ref_code}`, message: `${line}. ${nbfcName(l)} will confirm arrival and receipt.` }), by !== "refurbisher" ? refurbisherRecipient(l, { email: false, title: `${l.ref_code} dispatched back to the NBFC`, message: line }) : null]),
  });
}

/** The truck reached the gate. FYI to the sender. */
export async function notifyRefurbArrived(l: Lot, leg: "out" | "return"): Promise<void> {
  await emit({
    type: "refurb.lot_arrived",
    title: leg === "out" ? `${l.ref_code} arrived at iTarang` : `${l.ref_code} arrived at ${nbfcName(l)}`,
    message: leg === "out" ? `iTarang marked ${lotLine(l)} arrived. Battery-by-battery receipt follows.` : `${nbfcName(l)} marked ${lotLine(l)} arrived. Battery-by-battery receipt follows.`,
    stage: STAGE,
    from: leg === "out" ? ADMIN_PARTY : nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), leg },
    to: leg === "out" ? [nbfcRecipient(l), adminRecipient(l, { email: false })] : [adminRecipient(l), nbfcRecipient(l, { email: false })],
  });
}

/** 9 / 15. A receipt was signed. Mismatch copy is deliberately loud. */
export async function notifyRefurbReceived(l: Lot, leg: "out" | "return", tally: { received: number; damaged: number; missing: number }): Promise<void> {
  const problems = [tally.damaged ? `${tally.damaged} damaged` : null, tally.missing ? `${tally.missing} missing` : null].filter(Boolean).join(", ");
  const summary = `${tally.received} received${problems ? `, ${problems}` : ""}`;
  const done = l.status === "settled" || l.status === "balance_due";
  await emit({
    type: leg === "return" && done ? "refurb.lot_completed" : "refurb.lot_received",
    title: leg === "out" ? `${problems ? "⚠ " : ""}iTarang received ${l.ref_code}: ${summary}` : `${problems ? "⚠ " : ""}${nbfcName(l)} received ${l.ref_code}: ${summary}`,
    message:
      leg === "out"
        ? `iTarang signed for ${lotLine(l)} — ${summary}.${problems ? " Please check the receipt notes and photographs." : " Refurbishment starts next."}`
        : `${nbfcName(l)} signed for ${lotLine(l)} — ${summary}.${problems ? " The flagged batteries need your attention." : " The refurbished batteries are graded refurbished."}${
            l.status === "balance_due" ? ` Balance of ${inr(l.balance.amount)} is now due.` : l.status === "settled" ? " Nothing further is owed — choose redeploy or auction to close the lot." : ""
          }`,
    stage: STAGE,
    from: leg === "out" ? ADMIN_PARTY : nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), leg, ...tally },
    to: compact([adminRecipient(l), nbfcRecipient(l), leg === "return" ? refurbisherRecipient(l, { email: false, title: `${l.ref_code} received by the NBFC`, message: summary }) : null]),
  });
  if (l.status === "balance_due") await notifyRefurbBalanceDue(l);
}

/** 10. Admin assigned the lot to a refurbisher — the refurbisher's move. The NBFC is NOT told. */
export async function notifyRefurbAssigned(l: Lot, reassigned: boolean): Promise<void> {
  await emit({
    type: "refurb.lot_assigned",
    title: `${reassigned ? "Re-assigned" : "New lot"}: ${lotLine(l)}`,
    message: `iTarang has assigned ${lotLine(l)} from ${nbfcName(l)} to you${l.expected_return_date ? `, to be returned by ${dmy(l.expected_return_date)}` : ""}.${l.refurbisher_note ? ` "${l.refurbisher_note}"` : ""} Open the lot, start work and cost each battery.`,
    stage: STAGE,
    from: ADMIN_PARTY,
    data: { ...baseData(l), refurbisher_id: l.refurbisher?.id ?? null },
    to: compact([refurbisherRecipient(l), adminRecipient(l, { email: false, title: `${l.ref_code} assigned to ${refName(l)}`, message: lotLine(l) })]),
  });
}

/** 11. Work started. FYI to the NBFC (as iTarang) and admin. */
export async function notifyRefurbWorkStarted(l: Lot): Promise<void> {
  await emit({
    type: "refurb.work_started",
    title: `Work started on ${l.ref_code}`,
    message: `Refurbishment has started on ${lotLine(l)}. Expected return by ${dmy(l.expected_return_date)}.`,
    stage: STAGE,
    from: SYSTEM_PARTY,
    data: baseData(l),
    to: [nbfcRecipient(l, { email: false }), adminRecipient(l, { email: false, message: `${refName(l)} started on ${lotLine(l)}.` })],
  });
}

/** 12. Every battery costed by the refurbisher — admin's move (margin + final bill). */
export async function notifyRefurbCosted(l: Lot): Promise<void> {
  await emit({
    type: "refurb.lot_costed",
    title: `${l.ref_code} costed by ${refName(l)}: ${inr(l.refurbisher_total)}`,
    message: `${refName(l)} has costed every battery in ${lotLine(l)} — ${inr(l.refurbisher_total)} in all. Set iTarang's margin and send the final bill to ${nbfcName(l)}.`,
    stage: STAGE,
    from: refurbisherParty(refName(l)),
    data: { ...baseData(l), refurbisher_total: l.refurbisher_total },
    to: compact([adminRecipient(l), refurbisherRecipient(l, { email: false, title: `${l.ref_code} costs submitted`, message: `iTarang will review and mark the batteries ready.` })]),
  });
}

/** 13. Final bill → NBFC. No approval needed. */
export async function notifyRefurbFinalBill(l: Lot): Promise<void> {
  const adv = l.advance.status === "confirmed" ? ` Advance of ${inr(l.advance.amount)} already received; ${inr((l.final_total ?? 0) - (l.advance.amount ?? 0))} will be due once the batteries are back.` : "";
  await emit({
    type: "refurb.final_bill",
    title: `Final bill for ${l.ref_code}: ${inr(l.final_total)}`,
    message: `The refurbishment of ${lotLine(l)} comes to ${inr(l.final_total)}${l.pi.amount != null ? ` (PI was ${inr(l.pi.amount)})` : ""}.${adv} The batteries will be dispatched back to you.`,
    stage: STAGE,
    from: ADMIN_PARTY,
    data: { ...baseData(l), final_total: l.final_total },
    to: [nbfcRecipient(l), adminRecipient(l, { email: false, title: `Final bill sent on ${l.ref_code}`, message: `${inr(l.final_total)} to ${nbfcName(l)}.` })],
  });
}

/** 17. NBFC chose redeploy or auction — the lot is closed. */
export async function notifyRefurbClosed(l: Lot): Promise<void> {
  const redeploy = l.close_outcome === "redeploy";
  await emit({
    type: redeploy ? "refurb.redeploy_requested" : "refurb.lot_closed",
    title: redeploy ? `${nbfcName(l)} wants help redeploying ${lotLine(l)}` : `${l.ref_code} closed — going to auction`,
    message: redeploy
      ? `${nbfcName(l)} chose to REDEPLOY the ${l.battery_count} refurbished ${plural(l.battery_count)} in ${l.ref_code} rather than auction them, and asks iTarang to help.${l.close_note ? ` "${l.close_note}"` : ""}`
      : `${nbfcName(l)} chose to auction the ${l.battery_count} refurbished ${plural(l.battery_count)} in ${l.ref_code}. They are ready for a lot.`,
    stage: STAGE,
    from: nbfcParty(l.tenant_name ?? "NBFC"),
    data: { ...baseData(l), outcome: l.close_outcome },
    to: [adminRecipient(l), nbfcRecipient(l, { email: false, href: redeploy ? nbfcHref(l) : "/nbfc/auction/compose" })],
  });
}

/** Free-form message in the thread. Tells only the side it is addressed to. */
export async function notifyRefurbMessage(l: Lot, by: "nbfc" | "admin" | "refurbisher", message: string, to: "nbfc" | "refurbisher" = "nbfc"): Promise<void> {
  const from = by === "admin" ? ADMIN_PARTY : by === "nbfc" ? nbfcParty(l.tenant_name ?? "NBFC") : refurbisherParty(refName(l));
  const recipients =
    by === "admin"
      ? compact([to === "nbfc" ? nbfcRecipient(l) : refurbisherRecipient(l)])
      : [adminRecipient(l)];
  if (recipients.length === 0) return;
  await emit({
    type: "refurb.lot_message",
    title: `Message on refurbishment ${l.ref_code}`,
    message: `${by === "admin" ? "iTarang" : by === "nbfc" ? nbfcName(l) : refName(l)}: ${message.trim().slice(0, 300)}`,
    stage: STAGE,
    from,
    data: { ...baseData(l), by, to },
    to: recipients,
  });
}
