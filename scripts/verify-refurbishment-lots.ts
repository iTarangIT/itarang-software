/**
 * E-292 — end-to-end verifier for the refurbishment LOT loop, v3.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-refurbishment-lots.ts
 *
 * Drives the REAL service functions through the whole NBFC ⇄ iTarang ⇄
 * refurbisher conversation on seeded batteries, asserting lot status, job
 * status, battery / pipeline state, custody, the two redaction walls, money
 * maths and the cost roll-up at each step, then cleans up by serial + note.
 *
 * Lot A (the long path): triage → create → decline one → reviewed →
 * estimate (30% advance, iTarang pickup) → counter → re-estimate → accept →
 * PI (refused without PDF) → PI → accept PI → advance recorded → confirmed →
 * pickup → receipt (one damaged) → assign refurbisher → start work → cost →
 * costed → final bill (15% margin) → ready → return dispatch by the
 * refurbisher → arrived → receipt → balance due → recorded → confirmed →
 * settled → close (auction) → closed.
 * Lot B (the lean path): no advance, NBFC ships, receipt without "arrived",
 * margin 0, admin confirms from `pending`, close (redeploy).
 * Lot C: cancel path + tenant / refurbisher scoping.
 *
 * Needs: E-233 … E-271 + E-292 applied, one nbfc_tenants row, one users row.
 * Notifications are NOT sent (the routes send them). No Razorpay anywhere.
 */
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { createRecoveryBattery, setBatteryState } from "@/lib/nbfc/recovery/battery";
import { recordTriage } from "@/lib/nbfc/recovery/triage";
import {
  acceptPi,
  assignRefurbisher,
  attachLotPhotos,
  cancelLot,
  closeLot,
  confirmReceipt,
  costItem,
  createLot,
  estimateLot,
  getLot,
  listEligibleBatteries,
  markArrived,
  markItemReady,
  recordDispatch,
  recordPickup,
  respondToEstimate,
  reviewLotItems,
  sendPi,
  setFinalCost,
  startWork,
} from "@/lib/nbfc/recovery/refurbishment-lots";
import { confirmRefurbOfflinePayment, recordRefurbOfflinePayment } from "@/lib/nbfc/recovery/refurb-payments";
import { refurbishmentCostForBatteries } from "@/lib/nbfc/recovery/refurbishment";

const SERIALS = ["E292-VERIFY-A", "E292-VERIFY-B", "E292-VERIFY-C", "E292-VERIFY-LOW", "E292-VERIFY-D", "E292-VERIFY-T"];
const REF_EMAIL = "e292-verify-refurbisher@example.invalid";
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
    ok(re.test(m), `${label}: ${m.slice(0, 110)}`);
  }
}
const arr = (xs: string[]) => sql`ARRAY[${sql.join(xs.map((x) => sql`${x}`), sql`, `)}]`;
const near = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) < 0.011;

async function cleanup() {
  await db.execute(sql`DELETE FROM refurbishment_lot_events WHERE lot_id IN (SELECT id FROM refurbishment_lots WHERE note LIKE 'E292-VERIFY%')`);
  await db.execute(sql`DELETE FROM refurbishment_jobs WHERE battery_id IN (SELECT id FROM recovery_batteries WHERE serial = ANY(${arr(SERIALS)}::text[]))`);
  await db.execute(sql`DELETE FROM refurbishment_lots WHERE note LIKE 'E292-VERIFY%'`);
  await db.execute(sql`DELETE FROM nbfc_battery_evaluations WHERE recovery_pipeline_id IN (SELECT id FROM nbfc_recovery_pipeline WHERE battery_serial = ANY(${arr(SERIALS)}::text[]))`);
  await db.execute(sql`DELETE FROM recovery_batteries WHERE serial = ANY(${arr(SERIALS)}::text[])`);
  await db.execute(sql`DELETE FROM nbfc_recovery_pipeline WHERE battery_serial = ANY(${arr(SERIALS)}::text[])`);
  await db.execute(sql`DELETE FROM refurbishers WHERE lower(email) = ${REF_EMAIL}`);
  await db.execute(sql`DELETE FROM nbfc_audit_log WHERE action_type LIKE 'refurb_%' AND created_at > now() - interval '10 minutes'`);
}

async function seedBattery(tenant: string, serial: string, soh: number | null): Promise<string> {
  const { battery } = await createRecoveryBattery({ tenant_id: tenant, serial, model: "TEST-51V-30Ah", capacity: "51V/30Ah" });
  const p = (await db.execute(sql`
    INSERT INTO nbfc_recovery_pipeline (tenant_id, battery_serial, stage, battery_id)
    VALUES (${tenant}::uuid, ${serial}, 'needs_inspection', ${battery.id}::uuid) RETURNING id`)) as unknown as Array<{ id: string }>;
  const pid = String(p[0].id);
  await db.execute(sql`UPDATE recovery_batteries SET recovery_pipeline_id = ${pid}::uuid WHERE id = ${battery.id}::uuid`);
  if (soh != null) {
    await db.execute(sql`
      INSERT INTO nbfc_battery_evaluations (tenant_id, recovery_pipeline_id, step1, step2, step3)
      VALUES (${tenant}::uuid, ${pid}::uuid,
        ${JSON.stringify({ soh_percent: soh, physical_condition: "fair", manufacturing_date: "2024-01-01", iot_status: "offline", bms_health: "healthy", charger_type: "std" })}::jsonb,
        ${JSON.stringify({ decision: "minor_repair", estimated_cost: 2000, checklist: {} })}::jsonb,
        ${JSON.stringify({ original_value: 60000 })}::jsonb)`);
    await setBatteryState(tenant, battery.id, "inspected", soh >= 70 ? "refurbished" : "partial_working");
  }
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
  const refRow = (await db.execute(sql`INSERT INTO refurbishers (name, contact_name, email, city, notes) VALUES ('E292 Verify Workshop', 'Verifier', ${REF_EMAIL}, 'Pune', 'E292-VERIFY') RETURNING id`)) as unknown as Array<{ id: string }>;
  const REF = String(refRow[0].id);
  const OTHER_REF = "00000000-0000-0000-0000-000000000000";
  console.log(`tenant=${tenant} refurbisher=${REF}\n`);

  console.log("1. seed: 3 evaluated (SOH 80/75/72), 1 below floor (60), 1 for lot B (78), 1 TRIAGED ONLY (no wizard)");
  const A = await seedBattery(tenant, SERIALS[0], 80);
  const B = await seedBattery(tenant, SERIALS[1], 75);
  const C = await seedBattery(tenant, SERIALS[2], 72);
  const LOW = await seedBattery(tenant, SERIALS[3], 60);
  const D = await seedBattery(tenant, SERIALS[4], 78);
  const T = await seedBattery(tenant, SERIALS[5], null);
  let tri = await recordTriage({ tenant_id: tenant, actor_user_id: user, battery_id: T, rated_voltage_v: 51, measured_voltage_v: 39, condition: "fair" });
  ok(near(tri.health_pct, 76.5) && tri.suggestion === "refurbish" && tri.battery.state_code === "inspected", `triage: 39/51 V → ${tri.health_pct}% → refurbish, battery inspected`);
  ok(tri.allowed_choices.includes("refurbish"), "refurbish allowed at 76.5%");
  tri = await recordTriage({ tenant_id: tenant, actor_user_id: user, battery_id: T, rated_voltage_v: 51, measured_voltage_v: 34 });
  ok(near(tri.health_pct, 66.7) && tri.suggestion === "scrap" && !tri.allowed_choices.includes("refurbish"), `triage: 34/51 V → ${tri.health_pct}% → scrap, refurbish NOT allowed`);
  tri = await recordTriage({ tenant_id: tenant, actor_user_id: user, battery_id: T, rated_voltage_v: 51, measured_voltage_v: 42 });
  ok(near(tri.health_pct, 82.4) && tri.suggestion === "fit_as_is", `triage: 42/51 V → ${tri.health_pct}% → fit as-is`);
  const elig = await listEligibleBatteries(tenant);
  ok(elig.some((b) => b.id === A && !b.blocked_reason), "A is eligible (evaluation)");
  ok(elig.some((b) => b.id === T && !b.blocked_reason && near(b.soh_pct, 82.4)), "T is eligible on its triage health alone (no wizard)");
  ok(elig.some((b) => b.id === LOW && /below/.test(b.blocked_reason ?? "")), "LOW is listed but blocked (SOH 60)");

  console.log("\n2. create lot A — 70% floor enforced; triage carried over");
  await expectThrow(() => createLot({ tenant_id: tenant, actor_user_id: user, battery_ids: [A, LOW], note: "E292-VERIFY low" }), /below the 70%/, "lot with a 60% battery refused");
  let lot = await createLot({ tenant_id: tenant, actor_user_id: user, battery_ids: [A, B, C], note: "E292-VERIFY main" });
  ok(lot.status === "requested" && lot.battery_count === 3 && lot.awaiting === "admin", `lot ${lot.ref_code} requested with 3 batteries, awaiting admin`);
  ok(lot.items.every((i) => i.custody === "with_nbfc"), "custody: all with_nbfc");
  ok((await batteryState(A)).state_code === "refurbishing" && (await batteryState(A)).stage === "refurbishable", "A → refurbishing / refurbishable");
  const live = () => lot.items.filter((i) => i.status !== "declined" && i.status !== "cancelled");
  await expectThrow(() => estimateLot({ lot_id: lot.id, actor_user_id: user, expected_receipt_date: "2026-09-12", expected_return_date: "2026-09-26", items: live().map((i) => ({ job_id: i.id, estimated_cost: 4000 })) }), /^CONFLICT/, "estimate before review refused");

  console.log("\n3. admin review — decline C, mark reviewed; resubmit shows the reason");
  const jobC = lot.items.find((i) => i.battery_id === C)!.id;
  lot = await reviewLotItems({ lot_id: lot.id, actor_user_id: user, decisions: [{ job_id: jobC, decision: "decline", reason: "casing cracked" }] });
  ok(lot.status === "reviewed" && lot.battery_count === 2 && lot.items.find((i) => i.id === jobC)!.status === "declined", "reviewed: C declined, count 2");
  ok((await batteryState(C)).state_code === "inspected", "C back to inspected");
  lot = await reviewLotItems({ lot_id: lot.id, actor_user_id: user, decisions: [] });
  ok(lot.status === "reviewed", "re-review with no decisions is fine (re-entrant)");
  ok((await listEligibleBatteries(tenant)).find((b) => b.id === C)?.last_decline_reason === "casing cracked", "C eligible again with last_decline_reason shown");

  console.log("\n4. estimate (30% advance, iTarang pickup) → counter → re-estimate → accept");
  lot = await estimateLot({ lot_id: lot.id, actor_user_id: user, expected_receipt_date: "2026-09-12", expected_return_date: "2026-09-26", pickup_mode: "itarang_pickup", pickup_address: "NBFC godown, Pune", advance_pct: 30, items: live().map((i) => ({ job_id: i.id, estimated_cost: 4000 })), note: "round 1" });
  ok(lot.status === "estimated" && lot.estimated_total === 23000 && lot.awaiting === "nbfc", `estimated 23000 (no pickup date needed), awaiting nbfc`);
  lot = await respondToEstimate({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, kind: "counter", counter_total: 22000, counter_advance_pct: 20, message: "too much up front" });
  ok(lot.status === "countered" && lot.counter.total === 22000 && lot.counter.advance_pct === 20, "countered: 22000 · 20% stored");
  lot = await estimateLot({ lot_id: lot.id, actor_user_id: user, expected_receipt_date: "2026-09-12", expected_return_date: "2026-09-24", pickup_mode: "itarang_pickup", pickup_address: "NBFC godown, Pune", advance_pct: 30, items: live().map((i) => ({ job_id: i.id, estimated_cost: 4500 })), note: "round 2" });
  ok(lot.current_round === 2 && lot.estimated_total === 24000, "round 2, estimate 24000");
  lot = await respondToEstimate({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, kind: "accept" });
  ok(lot.status === "agreed" && lot.quote_approved_total === 24000 && lot.awaiting === "admin", "agreed 24000 → admin owes the PI");
  await expectThrow(() => recordDispatch({ lot_id: lot.id, scope: { tenant_id: tenant }, actor_user_id: user, leg: "out", party: "nbfc", dispatched_on: "2026-09-12" }), /^CONFLICT/, "dispatch before the PI refused");

  console.log("\n5 / 6. proforma invoice → accept → advance due");
  await expectThrow(() => sendPi({ lot_id: lot.id, actor_user_id: user, pi_amount: 24000, pi_advance_pct: 30, bank_details: { account_number: "1234", ifsc: "HDFC0000001" } }), /upload the proforma/, "PI without a PDF refused");
  lot = await sendPi({ lot_id: lot.id, actor_user_id: user, pi_url: "/api/files/documents/refurb/lots/x/pi.pdf", pi_amount: 24000, pi_advance_pct: 30, bank_details: { account_name: "iTarang EV", account_number: "1234567890", ifsc: "HDFC0000001", bank_name: "HDFC" }, note: "PI-1" });
  ok(lot.status === "pi_sent" && lot.pi.amount === 24000 && lot.pi.advance_amount === 7200 && lot.pi.number?.startsWith("PI-") && lot.awaiting === "nbfc", `PI ${lot.pi.number}: 24000, advance 7200, awaiting nbfc`);
  lot = await sendPi({ lot_id: lot.id, actor_user_id: user, pi_amount: 24000, pi_advance_pct: 30, bank_details: { account_number: "1234567890", ifsc: "HDFC0000001" } });
  ok(lot.status === "pi_sent" && lot.pi.url === "/api/files/documents/refurb/lots/x/pi.pdf", "PI re-sent keeps the uploaded PDF");
  lot = await acceptPi({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user });
  ok(lot.status === "pi_accepted" && lot.advance.status === "pending" && lot.advance.amount === 7200 && lot.quote_approved_total === 24000 && lot.awaiting === "nbfc", "PI accepted → advance 7200 pending, awaiting nbfc");
  await expectThrow(() => recordPickup({ lot_id: lot.id, scope: null, actor_user_id: user, dispatched_on: "2026-09-12" }), /advance is still due/, "pickup before the advance refused");

  console.log("\n7. advance: NBFC records UTR → admin marks received → advance_recorded");
  await expectThrow(() => confirmRefurbOfflinePayment({ lot_id: lot.id, actor_user_id: user, leg: "advance" }), /not recorded the advance yet/, "admin confirm from pending without a reference refused");
  lot = await recordRefurbOfflinePayment({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, leg: "advance", reference: "UTR-ADV-0001" });
  ok(lot.advance.status === "recorded" && lot.awaiting === "admin", "advance recorded → awaiting admin");
  lot = await confirmRefurbOfflinePayment({ lot_id: lot.id, actor_user_id: user, leg: "advance" });
  ok(lot.status === "advance_recorded" && lot.advance.status === "confirmed" && lot.awaiting === "admin", "advance received → advance_recorded, awaiting admin (pickup)");
  ok(live().every((i) => i.custody === "awaiting_pickup"), "custody: awaiting_pickup");
  await expectThrow(() => recordDispatch({ lot_id: lot.id, scope: { tenant_id: tenant }, actor_user_id: user, leg: "out", party: "nbfc", dispatched_on: "2026-09-12" }), /iTarang is collecting/, "NBFC cannot dispatch an iTarang-pickup lot");

  console.log("\n8b / 9. pickup (no e-way bill) → arrived → receipt (A ok, B damaged)");
  lot = await recordPickup({ lot_id: lot.id, scope: null, actor_user_id: user, carrier: "iTarang van", vehicle_no: "MH12AB1234", dispatched_on: "2026-09-12" });
  ok(lot.status === "in_transit_out" && lot.out.eway_bill_no === null && !!lot.out.picked_up_at, "picked up → in_transit_out, e-way bill optional");
  ok(live().every((i) => i.custody === "in_transit_to_itarang"), "custody: in_transit_to_itarang");
  await expectThrow(() => cancelLot({ lot_id: lot.id, tenant_id: null, actor_user_id: user, party: "admin" }), /cannot be cancelled/, "cancel after pickup refused");
  const jobA = lot.items.find((i) => i.battery_id === A)!.id;
  const jobB = lot.items.find((i) => i.battery_id === B)!.id;
  lot = await markArrived({ lot_id: lot.id, scope: null, actor_user_id: user, leg: "out" });
  ok(lot.status === "in_transit_out" && !!lot.out.delivered_at, "arrived: timestamp only, status unchanged");
  await expectThrow(() => markArrived({ lot_id: lot.id, scope: null, actor_user_id: user, leg: "out" }), /already marked arrived/, "arrived twice refused");
  lot = await confirmReceipt({ lot_id: lot.id, scope: null, actor_user_id: user, leg: "out", items: [{ job_id: jobA, condition: "received" }, { job_id: jobB, condition: "damaged", note: "terminal bent" }] });
  ok(lot.status === "received" && lot.out.has_mismatch && lot.awaiting === "admin", "received, mismatch flagged, awaiting admin (assign)");
  ok(live().every((i) => i.custody === "at_itarang"), "custody: at_itarang");

  console.log("\n10 / 11 / 12. assign refurbisher → start work → cost per battery → costed; the two walls");
  await expectThrow(() => startWork({ lot_id: lot.id, scope: null, actor_user_id: user, party: "admin" }), /^CONFLICT/, "start work before assignment refused");
  await expectThrow(() => assignRefurbisher({ lot_id: lot.id, actor_user_id: user, refurbisher_id: OTHER_REF }), /NOT_FOUND/, "unknown refurbisher refused");
  lot = await assignRefurbisher({ lot_id: lot.id, actor_user_id: user, refurbisher_id: REF, note: "handle with care" });
  ok(lot.status === "at_refurbisher" && lot.refurbisher?.id === REF && live().every((i) => i.status === "at_refurbisher") && lot.awaiting === "refurbisher", "assigned → at_refurbisher, jobs at_refurbisher, awaiting refurbisher");
  ok(live().every((i) => i.custody === "at_refurbisher"), "custody: at_refurbisher");
  const nbfcView = await getLot(lot.id, { tenant_id: tenant }, "nbfc");
  ok(nbfcView?.refurbisher === null && nbfcView?.events.every((e) => e.kind !== "refurbisher_assigned" && e.party !== "refurbisher"), "WALL 1: the NBFC sees no refurbisher and no assignment event");
  ok((await getLot(lot.id, { refurbisher_id: OTHER_REF }, "refurbisher")) === null, "refurbisher scoping: another partner cannot read the lot");
  lot = await startWork({ lot_id: lot.id, scope: { refurbisher_id: REF }, actor_user_id: user, party: "refurbisher" });
  ok(lot.status === "in_progress", "refurbisher started work → in_progress");
  await expectThrow(() => assignRefurbisher({ lot_id: lot.id, actor_user_id: user, refurbisher_id: REF }), /^CONFLICT/, "re-assign after work started refused");
  const refView = await getLot(lot.id, { refurbisher_id: REF }, "refurbisher");
  ok(refView?.pi.amount === null && refView?.advance.amount === null && refView?.quote_approved_total === null && refView?.estimated_total === null && refView?.items.every((i) => i.estimated_cost === null), "WALL 2: the refurbisher sees no PI, no advance, no estimate");
  ok(refView?.events.every((e) => !["pi_sent", "pi_accepted", "advance_recorded", "advance_confirmed", "estimated", "accepted"].includes(e.kind)), "WALL 2: … and none of the money / commercial events");
  lot = await costItem({ lot_id: lot.id, job_id: jobA, scope: { refurbisher_id: REF }, actor_user_id: user, party: "refurbisher", refurbisher_cost: 4200, refurbisher_parts: [{ label: "BMS", qty: 1, unit_cost: 800 }] });
  ok(lot.status === "in_progress" && lot.items.find((i) => i.id === jobA)!.costed_at != null, "A costed (4200 + 800 parts + 7500 accessories), lot still in_progress");
  await expectThrow(() => markItemReady({ lot_id: lot.id, job_id: jobA, actor_user_id: user }), /^CONFLICT/, "mark ready before costed refused");
  lot = await costItem({ lot_id: lot.id, job_id: jobB, scope: { refurbisher_id: REF }, actor_user_id: user, party: "refurbisher", refurbisher_cost: 7800 });
  ok(lot.status === "costed" && near(lot.refurbisher_total, 4200 + 800 + 7500 + 7800 + 7500) && lot.awaiting === "admin", `costed: refurbisher total ${lot.refurbisher_total} (27800), awaiting admin`);
  await expectThrow(() => markItemReady({ lot_id: lot.id, job_id: jobA, actor_user_id: user }), /final bill/, "mark ready before the final bill refused");

  console.log("\n13. final bill = the ACCEPTED PI (refurbisher cost stays internal; margin = PI − cost) → NBFC (no approval) → mark ready");
  // E-292 (2026-09-09): the NBFC is billed what it accepted on the PI (24000); the
  // typed margin is ignored once a PI is accepted. Refurbisher total is 27800, so
  // iTarang's margin on this lot is −3800 — internal, never shown to the NBFC.
  lot = await setFinalCost({ lot_id: lot.id, actor_user_id: user, margin_pct: 15 });
  const expectedFinal = 24000;
  ok(near(lot.final_total, expectedFinal) && near(lot.margin.amount, -3800) && near(lot.refurbisher_total, 27800) && !!lot.final_sent_at, `final bill ${lot.final_total} = accepted PI; internal margin ${lot.margin.amount} = 24000 − 27800`);
  const finals = live().map((i) => i.final_cost ?? 0);
  ok(near(finals.reduce((s, x) => s + x, 0), expectedFinal), `per-battery final costs sum exactly to the final total (${finals.join(" + ")})`);
  // E-293: the balance leg opens NOW — final − confirmed advance, pending, awaited from the NBFC
  ok(lot.balance.status === "pending" && near(lot.balance.amount, expectedFinal - 7200), `balance ${lot.balance.amount} = 24000 − 7200 PENDING as soon as the bill goes out`);
  await expectThrow(() => costItem({ lot_id: lot.id, job_id: jobA, scope: { refurbisher_id: REF }, actor_user_id: user, party: "refurbisher", refurbisher_cost: 1 }), /frozen/, "re-costing after the final bill refused (frozen)");
  const nbfcView2 = await getLot(lot.id, { tenant_id: tenant }, "nbfc");
  ok(nbfcView2?.final_total != null && near(nbfcView2.final_total, expectedFinal) && nbfcView2.margin.amount === null && nbfcView2.refurbisher_total === null && nbfcView2.items.every((i) => i.refurbisher_cost === null), "WALL 1: the NBFC sees the final bill but not the margin or refurbisher cost");
  const billEvt = nbfcView2?.events.find((e) => e.kind === "final_bill_sent");
  ok(!!billEvt && !("refurbisher_total" in (billEvt.payload ?? {})) && !("margin_amount" in (billEvt.payload ?? {})) && (billEvt.payload as Record<string, unknown>).balance_expected != null, "WALL 1: the NBFC's final_bill_sent event carries the total + balance only");
  lot = await markItemReady({ lot_id: lot.id, job_id: jobA, actor_user_id: user });
  ok(lot.status === "costed", "first battery ready, lot still costed");
  lot = await markItemReady({ lot_id: lot.id, job_id: jobB, actor_user_id: user });
  ok(lot.status === "ready" && lot.awaiting === "nbfc", "both ready → lot ready, awaiting the NBFC's balance (E-293)");
  ok((await refurbishmentCostForBatteries([A, B])).size === 0, "cost roll-up EMPTY before the NBFC signs");

  console.log("\n14 / 15 / 16. E-293: balance (slip + UTR) BEFORE the return truck → dispatch by the refurbisher → arrived → receipt → confirm → settled");
  await expectThrow(() => recordDispatch({ lot_id: lot.id, scope: { tenant_id: tenant }, actor_user_id: user, leg: "return", party: "nbfc", dispatched_on: "2026-09-25" }), /FORBIDDEN/, "NBFC cannot record the return truck");
  await expectThrow(() => recordDispatch({ lot_id: lot.id, scope: { refurbisher_id: REF }, actor_user_id: user, leg: "return", party: "refurbisher", dispatched_on: "2026-09-25" }), /balance .* still due/, "return dispatch before the balance is recorded refused");
  await expectThrow(() => recordDispatch({ lot_id: lot.id, scope: null, actor_user_id: user, leg: "return", party: "admin", dispatched_on: "2026-09-25" }), /balance .* still due/, "admin cannot dispatch either while the balance is pending");
  await expectThrow(() => recordRefurbOfflinePayment({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, leg: "balance", reference: "UTR-BAL-0001" }), /upload the payment slip/, "balance without a slip refused");
  const slips = await attachLotPhotos(lot.id, { tenant_id: tenant }, "balance_slip", ["/api/files/documents/refurb/lots/x/balance_slip-1.png"]);
  ok(slips.length === 1, "balance slip attached");
  lot = await recordRefurbOfflinePayment({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, leg: "balance", reference: "UTR-BAL-0001" });
  ok(lot.status === "ready" && lot.balance.status === "recorded" && lot.balance.proof_urls.length === 1 && lot.awaiting === "admin", "balance recorded with the slip → still ready, awaiting admin (confirm / dispatch)");
  lot = await recordDispatch({ lot_id: lot.id, scope: { refurbisher_id: REF }, actor_user_id: user, leg: "return", party: "refurbisher", carrier: "VRL", docket_no: "LR-2", dispatched_on: "2026-09-25" });
  ok(lot.status === "in_transit_return", "refurbisher dispatched back → in_transit_return");
  lot = await getLot(lot.id, null, "admin") as typeof lot;
  ok(live().every((i) => i.custody === "in_transit_to_nbfc"), "custody: in_transit_to_nbfc");
  lot = await markArrived({ lot_id: lot.id, scope: { tenant_id: tenant }, actor_user_id: user, leg: "return" });
  ok(lot.status === "delivered_back" && live().every((i) => i.custody === "at_nbfc_gate"), "delivered_back, custody at_nbfc_gate");
  lot = await confirmReceipt({ lot_id: lot.id, scope: { tenant_id: tenant }, actor_user_id: user, leg: "return", items: [{ job_id: jobA, condition: "received" }, { job_id: jobB, condition: "received" }] });
  ok(lot.status === "balance_due" && near(lot.final_total, expectedFinal) && near(lot.balance.amount, expectedFinal - 7200) && lot.balance.status === "recorded" && lot.balance.reference === "UTR-BAL-0001", `balance_due (recorded, not yet confirmed): ${lot.final_total} − 7200 = ${lot.balance.amount}; the receipt did NOT reopen the leg`);
  ok(lot.items.filter((i) => i.status === "returned").length === 2 && live().every((i) => i.custody === "back_with_nbfc"), "both returned, custody back_with_nbfc");
  const sa = await batteryState(A);
  ok(sa.state_code === "ready" && sa.condition_grade === "refurbished" && sa.stage === "ready_for_auction", "A → ready / refurbished / ready_for_auction");
  const cost = await refurbishmentCostForBatteries([A, B]);
  ok(near(cost.get(A), finals[0]) && near(cost.get(B), finals[1]), `cost roll-up = per-battery FINAL cost (share of the PI): A=${cost.get(A)} B=${cost.get(B)}`);
  await expectThrow(() => closeLot({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, outcome: "auction" }), /^CONFLICT/, "close before settled refused");
  ok(lot.awaiting === "admin", "balance recorded → awaiting admin");
  lot = await confirmRefurbOfflinePayment({ lot_id: lot.id, actor_user_id: user, leg: "balance" });
  ok(lot.status === "settled" && !!lot.settled_at && lot.balance.status === "confirmed" && lot.awaiting === "nbfc", "SETTLED → awaiting nbfc (choose)");

  console.log("\n17. close (auction)");
  lot = await closeLot({ lot_id: lot.id, tenant_id: tenant, actor_user_id: user, outcome: "auction", note: "list them" });
  ok(lot.status === "closed" && lot.close_outcome === "auction" && lot.awaiting === null, "closed → auction");
  ok((await batteryState(A)).stage === "ready_for_auction", "A stays ready_for_auction");
  // closeLot returns the NBFC's REDACTED view (no refurbisher events); the
  // full timeline is the admin's.
  const nbfcEvents = lot.events;
  ok(nbfcEvents.every((e) => !["refurbisher_assigned", "item_costed", "all_costed"].includes(e.kind)), "WALL 1: the NBFC's timeline hides the refurbisher steps");
  lot = (await getLot(lot.id, null, "admin"))!;
  const seqs = lot.events.map((e) => e.seq);
  ok(seqs.every((s, i) => s === i + 1), `events seq contiguous 1..${seqs.length}`);
  const kinds = new Set(lot.events.map((e) => e.kind));
  for (const k of ["requested", "item_declined", "reviewed", "estimated", "countered", "accepted", "pi_sent", "pi_accepted", "advance_recorded", "advance_confirmed", "picked_up", "arrived_out", "received_out", "refurbisher_assigned", "work_started", "item_costed", "all_costed", "final_bill_sent", "item_ready", "dispatched_return", "arrived_return", "received_return", "balance_recorded", "settled", "closed"]) {
    ok(kinds.has(k), `event kind '${k}' recorded`);
  }

  console.log("\n18. lot B — lean path: no advance, NBFC ships, receipt without 'arrived', margin 0, admin confirms from pending, close (redeploy)");
  let lotB = await createLot({ tenant_id: tenant, actor_user_id: user, battery_ids: [D], note: "E292-VERIFY lean" });
  const jobD = lotB.items[0].id;
  lotB = await reviewLotItems({ lot_id: lotB.id, actor_user_id: user, decisions: [] });
  lotB = await estimateLot({ lot_id: lotB.id, actor_user_id: user, expected_receipt_date: "2026-09-12", expected_return_date: "2026-09-20", items: [{ job_id: jobD, estimated_cost: 3000 }] });
  lotB = await respondToEstimate({ lot_id: lotB.id, tenant_id: tenant, actor_user_id: user, kind: "accept" });
  lotB = await sendPi({ lot_id: lotB.id, actor_user_id: user, pi_url: "/api/files/documents/refurb/lots/y/pi.pdf", pi_amount: 10500, pi_advance_pct: 0, bank_details: { upi: "itarang@upi" } });
  lotB = await acceptPi({ lot_id: lotB.id, tenant_id: tenant, actor_user_id: user });
  ok(lotB.status === "pi_accepted" && lotB.advance.status === "not_required" && lotB.awaiting === "nbfc", "no advance → pi_accepted, not_required, awaiting nbfc (ship)");
  lotB = await recordDispatch({ lot_id: lotB.id, scope: { tenant_id: tenant }, actor_user_id: user, leg: "out", party: "nbfc", carrier: "own van", dispatched_on: "2026-09-12" });
  ok(lotB.status === "in_transit_out", "NBFC dispatched straight from pi_accepted");
  lotB = await confirmReceipt({ lot_id: lotB.id, scope: null, actor_user_id: user, leg: "out", items: [{ job_id: jobD, condition: "received" }] });
  ok(lotB.status === "received" && !!lotB.out.delivered_at, "receipt without 'arrived' → received, arrival auto-stamped");
  lotB = await assignRefurbisher({ lot_id: lotB.id, actor_user_id: user, refurbisher_id: REF });
  lotB = await startWork({ lot_id: lotB.id, scope: null, actor_user_id: user, party: "admin" });
  ok(lotB.status === "in_progress", "admin override: started work on the refurbisher's behalf");
  lotB = await costItem({ lot_id: lotB.id, job_id: jobD, scope: null, actor_user_id: user, party: "admin", refurbisher_cost: 2500 });
  ok(lotB.status === "costed" && lotB.refurbisher_total === 10000, "admin override: costed, total 10000");
  lotB = await setFinalCost({ lot_id: lotB.id, actor_user_id: user, margin_amount: 0 });
  ok(lotB.final_total === 10500 && lotB.items[0].final_cost === 10500 && lotB.margin.amount === 500, "accepted PI 10500 is the final bill (typed margin ignored); internal margin 10500 − 10000 = 500");
  ok(lotB.balance.status === "pending" && lotB.balance.amount === 10500, `no advance → the full bill ${lotB.balance.amount} is the balance, pending at once`);
  lotB = await markItemReady({ lot_id: lotB.id, job_id: jobD, actor_user_id: user });
  await expectThrow(() => recordDispatch({ lot_id: lotB.id, scope: null, actor_user_id: user, leg: "return", party: "admin", dispatched_on: "2026-09-19" }), /balance .* still due/, "E-293: admin dispatch held while the balance is pending");
  // admin marks it received itself (trust path) while the battery is still with the refurbisher — unlocks the truck, does NOT settle
  lotB = await confirmRefurbOfflinePayment({ lot_id: lotB.id, actor_user_id: user, leg: "balance", reference: "CASH-AT-DESK-1" });
  ok(lotB.status === "ready" && lotB.balance.status === "confirmed" && lotB.balance.reference === "CASH-AT-DESK-1" && lotB.awaiting === "admin", "admin confirmed from pending with its own reference → balance confirmed, lot still ready (not settled yet)");
  ok(lotB.events.some((e) => e.kind === "balance_confirmed") && !lotB.events.some((e) => e.kind === "settled"), "event: balance_confirmed (no settled yet)");
  lotB = await recordDispatch({ lot_id: lotB.id, scope: null, actor_user_id: user, leg: "return", party: "admin", dispatched_on: "2026-09-19" });
  lotB = await markArrived({ lot_id: lotB.id, scope: { tenant_id: tenant }, actor_user_id: user, leg: "return" });
  lotB = await confirmReceipt({ lot_id: lotB.id, scope: { tenant_id: tenant }, actor_user_id: user, leg: "return", items: [{ job_id: jobD, condition: "received" }] });
  ok(lotB.status === "settled" && !!lotB.settled_at && lotB.balance.status === "confirmed" && lotB.balance.amount === 10500, "receipt with a confirmed balance → SETTLED straight away");
  lotB = await closeLot({ lot_id: lotB.id, tenant_id: tenant, actor_user_id: user, outcome: "redeploy" });
  ok(lotB.status === "closed" && lotB.close_outcome === "redeploy", "closed → redeploy");
  const sd = await batteryState(D);
  ok(sd.stage === "redeploy" && sd.state_code === "ready", "D pipeline → redeploy (stub), battery stays ready");

  console.log("\n19. lot C — cancel path + scoping");
  await setBatteryState(tenant, C, "inspected", null);
  let lotC = await createLot({ tenant_id: tenant, actor_user_id: user, battery_ids: [C], note: "E292-VERIFY cancel" });
  lotC = await cancelLot({ lot_id: lotC.id, tenant_id: tenant, actor_user_id: user, party: "nbfc", reason: "changed our mind" });
  ok(lotC.status === "cancelled" && lotC.cancelled_by_party === "nbfc" && (await batteryState(C)).state_code === "inspected", "cancelled by nbfc, C released");
  ok((await getLot(lotC.id, { tenant_id: "00000000-0000-0000-0000-000000000000" }, "nbfc")) === null, "tenant scoping: another tenant cannot read the lot");

  await cleanup();
  console.log(`\n${failures === 0 ? "ALL GREEN" : `${failures} FAILURE(S)`}`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch {}
  process.exit(1);
});
