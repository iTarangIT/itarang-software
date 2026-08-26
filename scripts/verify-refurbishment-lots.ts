/**
 * E-270 / E-271 — end-to-end verifier for the refurbishment LOT loop.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-refurbishment-lots.ts
 *
 * Drives the REAL service functions through the whole NBFC ⇄ workshop
 * conversation on seeded batteries, asserting lot status, job status, battery
 * / pipeline state, custody, money maths and the cost roll-up at each step,
 * then cleans up by serial + lot note.
 *
 * Lot A (the long path): 30% advance, iTarang pickup, one battery declined,
 * counter → re-quote → approve, offline advance + admin confirm, pickup,
 * arrived, receipt with one damaged, work, actuals OVER the approved quote →
 * ready refused → revise → reject → revise → approve → ready, return dispatch,
 * arrived, receipt, balance due → recorded → confirmed → settled.
 * Lot B (the lean path): no advance, NBFC ships, nothing owed → settled.
 * Lot C: cancel path + tenant scoping.
 *
 * Needs: E-270 + E-271 applied, one nbfc_tenants row, one users row.
 * Notifications are NOT sent (the routes send them). Razorpay is NOT called
 * (the offline path is exercised; the online path is signature-verified code).
 */
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { createRecoveryBattery, setBatteryState } from "@/lib/nbfc/recovery/battery";
import {
  cancelLot,
  confirmReceipt,
  createLot,
  getLot,
  listEligibleBatteries,
  markArrived,
  markItemReady,
  proposeLot,
  recordDispatch,
  recordPickup,
  respondToProposal,
  respondToRevision,
  reviewLotItems,
  reviseQuote,
  startWork,
  updateLotItem,
} from "@/lib/nbfc/recovery/refurbishment-lots";
import { confirmRefurbOfflinePayment, recordRefurbOfflinePayment } from "@/lib/nbfc/recovery/refurb-payments";
import { refurbishmentCostForBatteries } from "@/lib/nbfc/recovery/refurbishment";

const SERIALS = ["E270-VERIFY-A", "E270-VERIFY-B", "E270-VERIFY-C", "E270-VERIFY-LOW", "E270-VERIFY-D"];
let failures = 0;
function ok(cond: unknown, label: string) {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`);
  if (!cond) failures++;
}
async function expectThrow(fn: () => Promise<unknown>, re: RegExp, label: string) {
  try {
    await fn();
    ok(false, `${label} — did not throw`);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    ok(re.test(m), `${label}: ${m.slice(0, 100)}`);
  }
}
const arr = (xs: string[]) => sql`ARRAY[${sql.join(xs.map((x) => sql`${x}`), sql`, `)}]`;

async function cleanup() {
  await db.execute(sql`DELETE FROM refurbishment_lot_events WHERE lot_id IN (SELECT id FROM refurbishment_lots WHERE note LIKE 'E270-VERIFY%')`);
  await db.execute(sql`DELETE FROM refurbishment_jobs WHERE battery_id IN (SELECT id FROM recovery_batteries WHERE serial = ANY(${arr(SERIALS)}::text[]))`);
  await db.execute(sql`DELETE FROM refurbishment_lots WHERE note LIKE 'E270-VERIFY%'`);
  await db.execute(sql`DELETE FROM nbfc_battery_evaluations WHERE recovery_pipeline_id IN (SELECT id FROM nbfc_recovery_pipeline WHERE battery_serial = ANY(${arr(SERIALS)}::text[]))`);
  await db.execute(sql`DELETE FROM recovery_batteries WHERE serial = ANY(${arr(SERIALS)}::text[])`);
  await db.execute(sql`DELETE FROM nbfc_recovery_pipeline WHERE battery_serial = ANY(${arr(SERIALS)}::text[])`);
  await db.execute(sql`DELETE FROM nbfc_audit_log WHERE action_type LIKE 'refurb_%' AND created_at > now() - interval '10 minutes'`);
}

async function seedBattery(tenant: string, serial: string, soh: number): Promise<string> {
  const { battery } = await createRecoveryBattery({ tenant_id: tenant, serial, model: "TEST-48V-32Ah", capacity: "48V/32Ah" });
  const p = (await db.execute(sql`
    INSERT INTO nbfc_recovery_pipeline (tenant_id, battery_serial, stage, battery_id)
    VALUES (${tenant}::uuid, ${serial}, 'needs_inspection', ${battery.id}::uuid) RETURNING id`)) as unknown as Array<{ id: string }>;
  const pid = String(p[0].id);
  await db.execute(sql`UPDATE recovery_batteries SET recovery_pipeline_id = ${pid}::uuid WHERE id = ${battery.id}::uuid`);
  await db.execute(sql`
    INSERT INTO nbfc_battery_evaluations (tenant_id, recovery_pipeline_id, step1, step2, step3)
    VALUES (${tenant}::uuid, ${pid}::uuid,
      ${JSON.stringify({ soh_percent: soh, physical_condition: "fair", manufacturing_date: "2024-01-01", iot_status: "offline", bms_health: "healthy", charger_type: "std" })}::jsonb,
      ${JSON.stringify({ decision: "minor_repair", estimated_cost: 2000, checklist: {} })}::jsonb,
      ${JSON.stringify({ original_value: 60000 })}::jsonb)`);
  await setBatteryState(tenant, battery.id, "inspected", soh >= 70 ? "refurbished" : "partial_working");
  return battery.id;
}

async function batteryState(id: string) {
  const r = (await db.execute(sql`
    SELECT b.state_code, b.condition_grade, p.stage FROM recovery_batteries b
      LEFT JOIN nbfc_recovery_pipeline p ON p.id = b.recovery_pipeline_id WHERE b.id = ${id}::uuid`)) as unknown as Array<{ state_code: string; condition_grade: string | null; stage: string | null }>;
  return r[0];
}

async function main() {
  await cleanup();
  const t = (await db.execute(sql`SELECT id FROM nbfc_tenants LIMIT 1`)) as unknown as Array<{ id: string }>;
  const tenant = String(t[0].id);
  const user = String(((await db.execute(sql`SELECT id FROM users LIMIT 1`)) as unknown as Array<{ id: string }>)[0].id);
  console.log(`tenant=${tenant}\n`);

  console.log("1. seed 4 good batteries (SOH 80/75/72/78) + 1 below threshold (60)");
  const A = await seedBattery(tenant, SERIALS[0], 80);
  const B = await seedBattery(tenant, SERIALS[1], 75);
  const C = await seedBattery(tenant, SERIALS[2], 72);
  const LOW = await seedBattery(tenant, SERIALS[3], 60);
  const D = await seedBattery(tenant, SERIALS[4], 78);
  const elig = await listEligibleBatteries(tenant);
  ok(elig.some((b) => b.id === A && !b.blocked_reason), "A is eligible");
  ok(elig.some((b) => b.id === LOW && /below/.test(b.blocked_reason ?? "")), "LOW is listed but blocked (SOH 60)");

  console.log("2. create lot A — 70% floor enforced server-side");
  await expectThrow(() => createLot({ tenant_id: tenant, actor_user_id: user, battery_ids: [A, LOW], note: "E270-VERIFY low" }), /below the 70%/, "lot with a 60% battery refused");
  let lot = await createLot({ tenant_id: tenant, actor_user_id: user, battery_ids: [A, B, C], note: "E270-VERIFY main" });
  ok(lot.status === "requested" && lot.battery_count === 3, `lot ${lot.ref_code} requested with 3 batteries`);
  ok(lot.items.every((i) => i.custody === "at_nbfc"), "custody: all at_nbfc");
  ok((await batteryState(A)).state_code === "refurbishing" && (await batteryState(A)).stage === "refurbishable", "A → refurbishing / refurbishable");

  console.log("3. admin review — decline C; resubmit shows the reason (Q1)");
  const jobC = lot.items.find((i) => i.battery_id === C)!.id;
  lot = await reviewLotItems({ lot_id: lot.id, actor_user_id: user, decisions: [{ job_id: jobC, decision: "decline", reason: "casing cracked" }] });
  ok(lot.battery_count === 2 && lot.items.find((i) => i.id === jobC)!.status === "declined", "C declined, count 2");
  ok((await batteryState(C)).state_code === "inspected", "C back to inspected");
  const elig2 = await listEligibleBatteries(tenant);
  ok(elig2.find((b) => b.id === C)?.last_decline_reason === "casing cracked", "C eligible again with last_decline_reason shown");

  console.log("4. quote (30% advance, iTarang pickup) → counter → re-quote → approve (Q2/Q3/Q5/Q6)");
  const live = () => lot.items.filter((i) => i.status !== "declined" && i.status !== "cancelled");
  await expectThrow(
    () => proposeLot({ lot_id: lot.id, actor_user_id: user, expected_receipt_date: "2026-09-01", expected_return_date: "2026-09-15", pickup_mode: "itarang_pickup", items: live().map((i) => ({ job_id: i.id, estimated_cost: 4000 })) }),
    /scheduled pickup date/,
    "iTarang pickup without a date refused",
  );
  lot = await proposeLot({
    lot_id: lot.id, actor_user_id: user, expected_receipt_date: "2026-09-01", expected_return_date: "2026-09-15",
    pickup_mode: "itarang_pickup", scheduled_pickup_date: "2026-08-31", pickup_address: "NBFC godown, Pune", workshop_address: "iTarang workshop, Pune",
    advance_pct: 30, items: live().map((i) => ({ job_id: i.id, estimated_cost: 4000 })), note: "round 1",
  });
  ok(lot.status === "proposed" && lot.estimated_total === 23000 && lot.advance.amount === 6900, `quote 23000, advance 30% = ${lot.advance.amount}`);
  lot = await respondToProposal({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, kind: "counter", message: "return by the 10th", requested_return_date: "2026-09-10" });
  ok(lot.status === "countered", "countered");
  lot = await proposeLot({
    lot_id: lot.id, actor_user_id: user, expected_receipt_date: "2026-09-01", expected_return_date: "2026-09-10",
    pickup_mode: "itarang_pickup", scheduled_pickup_date: "2026-08-31", pickup_address: "NBFC godown, Pune", advance_pct: 30,
    items: live().map((i) => ({ job_id: i.id, estimated_cost: 4500 })), note: "round 2",
  });
  ok(lot.current_round === 2 && lot.estimated_total === 24000, "round 2, quote 24000");
  lot = await respondToProposal({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, kind: "accept" });
  ok(lot.status === "awaiting_advance" && lot.quote_approved_total === 24000 && lot.advance.amount === 7200 && lot.advance.status === "pending", "approved 24000 → awaiting_advance, advance 7200 pending");
  ok(lot.awaiting === "nbfc", "awaiting nbfc (pay)");
  await expectThrow(() => recordPickup({ lot_id: lot.id, tenant_id: null, actor_user_id: user, dispatched_on: "2026-08-31" }), /^CONFLICT/, "pickup before advance refused");

  console.log("5. advance: offline record → admin confirm → pickup_scheduled (Q3)");
  lot = await recordRefurbOfflinePayment({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, leg: "advance", reference: "UTR-ADV-0001" });
  ok(lot.advance.status === "recorded" && lot.awaiting === "admin", "advance recorded → awaiting admin confirm");
  lot = await confirmRefurbOfflinePayment({ lot_id: lot.id, actor_user_id: user, leg: "advance" });
  ok(lot.advance.status === "confirmed" && lot.status === "pickup_scheduled", "advance confirmed → pickup_scheduled");
  ok(lot.items.filter((i) => i.status !== "declined").every((i) => i.custody === "awaiting_pickup"), "custody: awaiting_pickup");
  await expectThrow(() => recordDispatch({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, leg: "out", dispatched_on: "2026-08-31" }), /iTarang is collecting|cannot dispatch out/, "NBFC cannot dispatch an iTarang-pickup lot");

  console.log("6. pickup with e-way bill → in transit → arrived → receipt (A ok, B damaged) (Q6/Q7/Q8)");
  lot = await recordPickup({ lot_id: lot.id, tenant_id: null, actor_user_id: user, carrier: "iTarang van", vehicle_no: "MH12AB1234", docket_no: "PU-1", eway_bill_no: "123456789012", dispatched_on: "2026-08-31" });
  ok(lot.status === "in_transit_out" && lot.out.eway_bill_no === "123456789012" && !!lot.out.picked_up_at, "picked up → in_transit_out with e-way bill");
  ok(live().every((i) => i.custody === "in_transit_to_workshop"), "custody: in_transit_to_workshop");
  await expectThrow(() => cancelLot({ lot_id: lot.id, tenant_id: null, actor_user_id: user, party: "admin" }), /cannot be cancelled/, "cancel after pickup refused");
  const jobA = lot.items.find((i) => i.battery_id === A)!.id;
  const jobB = lot.items.find((i) => i.battery_id === B)!.id;
  await expectThrow(() => confirmReceipt({ lot_id: lot.id, tenant_id: null, actor_user_id: user, leg: "out", items: [{ job_id: jobA, condition: "received" }, { job_id: jobB, condition: "received" }] }), /^CONFLICT/, "receipt before 'arrived' refused");
  lot = await markArrived({ lot_id: lot.id, tenant_id: null, actor_user_id: user, leg: "out" });
  ok(lot.status === "delivered" && !!lot.out.delivered_at && live().every((i) => i.custody === "at_workshop_gate"), "arrived → delivered, custody at_workshop_gate");
  lot = await confirmReceipt({ lot_id: lot.id, tenant_id: null, actor_user_id: user, leg: "out", items: [{ job_id: jobA, condition: "received" }, { job_id: jobB, condition: "damaged", note: "terminal bent" }] });
  ok(lot.status === "received" && lot.out.has_mismatch, "received, mismatch flagged");
  ok(live().every((i) => i.custody === "at_workshop"), "custody: at_workshop");

  console.log("7. work → actuals exceed approved → ready refused → revise → reject → revise → approve → ready (Q2/Q5)");
  lot = await startWork({ lot_id: lot.id, actor_user_id: user });
  ok(lot.status === "in_progress", "in_progress");
  lot = await updateLotItem({ lot_id: lot.id, job_id: jobA, actor_user_id: user, actual_cost: 4200 });
  lot = await updateLotItem({ lot_id: lot.id, job_id: jobB, actor_user_id: user, actual_cost: 9000 }); // 4200+9000+15000 = 28200 > 24000
  ok(lot.over_approved_quote === true && lot.actual_total === 28200, `actual 28200 over approved 24000 flagged`);
  lot = await markItemReady({ lot_id: lot.id, job_id: jobA, actor_user_id: user });
  ok(lot.status === "in_progress", "first battery ready, lot still in_progress");
  await expectThrow(() => markItemReady({ lot_id: lot.id, job_id: jobB, actor_user_id: user }), /revised quote/, "last battery ready REFUSED while over the approved quote");
  await expectThrow(() => reviseQuote({ lot_id: lot.id, actor_user_id: user, revised_total: 24000 }), /must exceed/, "revision not above approved refused");
  lot = await reviseQuote({ lot_id: lot.id, actor_user_id: user, revised_total: 28200, note: "cells replaced on B" });
  ok(lot.status === "revision_pending" && lot.revised_total === 28200 && lot.awaiting === "nbfc", "revision_pending, awaiting nbfc");
  lot = await respondToRevision({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, kind: "reject", message: "too much" });
  ok(lot.status === "in_progress" && lot.quote_approved_total === 24000 && lot.revised_total === null, "rejected → approved stays 24000");
  lot = await reviseQuote({ lot_id: lot.id, actor_user_id: user, revised_total: 27000, note: "discounted" });
  lot = await respondToRevision({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, kind: "approve" });
  ok(lot.quote_approved_total === 27000 && lot.status === "in_progress", "approved → new cap 27000");
  lot = await updateLotItem({ lot_id: lot.id, job_id: jobB, actor_user_id: user, actual_cost: 7800 }); // 4200+7800+15000 = 27000
  lot = await markItemReady({ lot_id: lot.id, job_id: jobB, actor_user_id: user });
  ok(lot.status === "ready" && lot.actual_total === 27000, "both ready within cap → lot ready");
  ok((await refurbishmentCostForBatteries([A, B])).size === 0, "cost roll-up EMPTY before the NBFC signs");

  console.log("8. return dispatch (e-way bill) → arrived → receipt → balance_due → record → confirm → settled (Q3)");
  lot = await recordDispatch({ lot_id: lot.id, tenant_id: null, actor_user_id: user, leg: "return", carrier: "VRL", docket_no: "LR-2", eway_bill_no: "210987654321", dispatched_on: "2026-09-09" });
  ok(lot.status === "in_transit_return" && lot.ret.eway_bill_no === "210987654321" && live().every((i) => i.custody === "in_transit_to_nbfc"), "in_transit_return, custody in_transit_to_nbfc");
  lot = await markArrived({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, leg: "return" });
  ok(lot.status === "delivered_back" && live().every((i) => i.custody === "at_nbfc_gate"), "delivered_back, custody at_nbfc_gate");
  lot = await confirmReceipt({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, leg: "return", items: [{ job_id: jobA, condition: "received" }, { job_id: jobB, condition: "received" }] });
  ok(lot.status === "balance_due" && lot.final_total === 27000 && lot.balance.amount === 19800 && lot.balance.status === "pending", `balance_due: final 27000 − advance 7200 = ${lot.balance.amount}`);
  ok(lot.items.filter((i) => i.status === "returned").length === 2 && live().every((i) => i.custody === "back_at_nbfc"), "both returned, custody back_at_nbfc");
  const sa = await batteryState(A);
  ok(sa.state_code === "ready" && sa.condition_grade === "refurbished" && sa.stage === "ready_for_auction", "A → ready / refurbished / ready_for_auction");
  const cost = await refurbishmentCostForBatteries([A, B]);
  ok(cost.get(A) === 4200 + 7500 && cost.get(B) === 7800 + 7500, `cost roll-up A=${cost.get(A)} B=${cost.get(B)}`);
  lot = await recordRefurbOfflinePayment({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, leg: "balance", reference: "UTR-BAL-0001" });
  ok(lot.balance.status === "recorded" && lot.awaiting === "admin", "balance recorded → awaiting admin");
  lot = await confirmRefurbOfflinePayment({ lot_id: lot.id, actor_user_id: user, leg: "balance" });
  ok(lot.status === "settled" && !!lot.settled_at && lot.balance.status === "confirmed" && lot.awaiting === null, "SETTLED");
  const seqs = lot.events.map((e) => e.seq);
  ok(seqs.every((s, i) => s === i + 1), `events seq contiguous 1..${seqs.length}`);
  const kinds = new Set(lot.events.map((e) => e.kind));
  for (const k of ["requested", "item_declined", "proposed", "countered", "accepted", "advance_recorded", "advance_confirmed", "pickup_scheduled", "picked_up", "arrived_out", "received_out", "work_started", "revision_proposed", "revision_rejected", "revision_approved", "item_ready", "dispatched_return", "arrived_return", "received_return", "balance_recorded", "settled"]) {
    ok(kinds.has(k), `event kind '${k}' recorded`);
  }

  console.log("9. lot B — lean path: no advance, NBFC ships, settled on receipt");
  let lotB = await createLot({ tenant_id: tenant, actor_user_id: user, battery_ids: [D], note: "E270-VERIFY lean" });
  const jobD = lotB.items[0].id;
  lotB = await proposeLot({ lot_id: lotB.id, actor_user_id: user, expected_receipt_date: "2026-09-01", expected_return_date: "2026-09-10", items: [{ job_id: jobD, estimated_cost: 3000 }] });
  lotB = await respondToProposal({ lot_id: lotB.id, tenant_id: tenant, actor_user_id: user, kind: "accept" });
  ok(lotB.status === "agreed" && lotB.advance.status === "not_required", "no advance → agreed directly");
  lotB = await recordDispatch({ lot_id: lotB.id, tenant_id: tenant, actor_user_id: user, leg: "out", carrier: "own van", dispatched_on: "2026-09-01", eway_bill_no: "111122223333" });
  lotB = await markArrived({ lot_id: lotB.id, tenant_id: null, actor_user_id: user, leg: "out" });
  lotB = await confirmReceipt({ lot_id: lotB.id, tenant_id: null, actor_user_id: user, leg: "out", items: [{ job_id: jobD, condition: "received" }] });
  lotB = await startWork({ lot_id: lotB.id, actor_user_id: user });
  lotB = await updateLotItem({ lot_id: lotB.id, job_id: jobD, actor_user_id: user, actual_cost: 2500 });
  lotB = await markItemReady({ lot_id: lotB.id, job_id: jobD, actor_user_id: user });
  ok(lotB.status === "ready", "under quote → ready without revision");
  lotB = await recordDispatch({ lot_id: lotB.id, tenant_id: null, actor_user_id: user, leg: "return", dispatched_on: "2026-09-08" });
  lotB = await markArrived({ lot_id: lotB.id, tenant_id: tenant, actor_user_id: user, leg: "return" });
  lotB = await confirmReceipt({ lot_id: lotB.id, tenant_id: tenant, actor_user_id: user, leg: "return", items: [{ job_id: jobD, condition: "received" }] });
  // Nothing owed at the end: the whole bill (2500 + 7500) is due as balance, so balance_due, not settled.
  ok(lotB.status === "balance_due" && lotB.balance.amount === 10000, `no advance → the full bill ${lotB.balance.amount} is the balance`);
  lotB = await recordRefurbOfflinePayment({ lot_id: lotB.id, tenant_id: tenant, actor_user_id: user, leg: "balance", reference: "UTR-B" });
  lotB = await confirmRefurbOfflinePayment({ lot_id: lotB.id, actor_user_id: user, leg: "balance" });
  ok(lotB.status === "settled", "lot B settled");

  console.log("10. lot C — cancel path + tenant scoping");
  await setBatteryState(tenant, C, "inspected", null);
  let lotC = await createLot({ tenant_id: tenant, actor_user_id: user, battery_ids: [C], note: "E270-VERIFY cancel" });
  lotC = await cancelLot({ lot_id: lotC.id, tenant_id: tenant, actor_user_id: user, party: "nbfc", reason: "changed our mind" });
  ok(lotC.status === "cancelled" && lotC.cancelled_by_party === "nbfc" && (await batteryState(C)).state_code === "inspected", "cancelled by nbfc, C released");
  ok((await getLot(lotC.id, "00000000-0000-0000-0000-000000000000")) === null, "tenant scoping: another tenant cannot read the lot");

  await cleanup();
  console.log(`\n${failures === 0 ? "ALL GREEN" : `${failures} FAILURE(S)`}`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch {}
  process.exit(1);
});
