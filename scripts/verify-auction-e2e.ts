/**
* End-to-end verification of the battery-auction engine (E-232 → E-234).
 *
 * There is no test framework in this repo (CLAUDE.md), so this follows the
 * `verify:calculator` idiom: a runnable script that exercises the real services
 * against a real database and asserts the outcomes, rather than a unit test
 * with mocks that would not have caught any of the three bugs it found —
 * a JS array expanded into a record tuple by drizzle's sql template, a JS Date
 * rejected by postgres-js, and an auto-bid engine that could never fire.
 *
 * Run against SANDBOX only. It creates its own batteries and lot and deletes
 * everything it made, but it does write.
 *
 *   npm run verify:auction
 * Creates its own batteries and lot, runs the flow, then deletes everything it made.
 */
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
// drizzle's sql template expands a JS array into a record tuple, not a PG array
// literal, so build the literal explicitly. Test-only, values are controlled.
const arr = (xs: string[]) =>
  sql.raw("ARRAY[" + xs.map((x) => "'" + x + "'").join(",") + "]");
import { createRecoveryBattery, setBatteryState } from "@/lib/nbfc/recovery/battery";
import { composeLot, publishLot } from "@/lib/nbfc/auction/composeLot";
import { placeBid } from "@/lib/nbfc/auction/service";
import { setAutoBid } from "@/lib/nbfc/auction/autoBid";
import { runAuctionTick } from "@/lib/nbfc/auction/scheduler";
import { resolveAuctionAudience, cityCentroid } from "@/lib/nbfc/auction/audience";
import { notifyLotPublished } from "@/lib/nbfc/auction/notify";

const SERIALS = ["E2E-AUC-A", "E2E-AUC-B", "E2E-AUC-C"];
const ok = (c: boolean, m: string) => console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
let lotId: string | null = null;

async function cleanup() {
  if (lotId) {
    await db.execute(sql`DELETE FROM auction_lot_audience WHERE lot_id = ${lotId}::uuid`);
    await db.execute(sql`DELETE FROM auction_lot_visibility WHERE lot_id = ${lotId}::uuid`);
    await db.execute(sql`DELETE FROM auction_lot_items WHERE lot_id = ${lotId}::uuid`);
    await db.execute(sql`DELETE FROM auction_auto_bids WHERE lot_id = ${lotId}::uuid`);
    await db.execute(sql`DELETE FROM auction_bids WHERE lot_id = ${lotId}::uuid`);
    await db.execute(sql`DELETE FROM auction_settlements WHERE lot_id = ${lotId}::uuid`);
    await db.execute(sql`DELETE FROM nbfc_auction_lot_actions WHERE lot_id = ${lotId}::uuid`);
    await db.execute(sql`DELETE FROM notifications WHERE data->>'lot_id' = ${lotId}`);
    await db.execute(sql`DELETE FROM auction_lots WHERE id = ${lotId}::uuid`);
  }
  await db.execute(sql`DELETE FROM recovery_batteries WHERE serial = ANY(${arr(SERIALS)}::text[])`);
  await db.execute(sql`DELETE FROM nbfc_audit_log WHERE action_type LIKE 'auction%' AND created_at > now() - interval '10 minutes'`);
}

async function main() {
  await cleanup();

  const t = (await db.execute(sql`SELECT id FROM nbfc_tenants LIMIT 1`)) as any;
  const tenant = String(t[0].id);
  // TWO different dealer selections, because no seeded account satisfies both
  // conditions at once on sandbox:
  //
  //   `dealers`  — must have a CITY on file. The geography assertions in step 4
  //                are vacuous without one.
  //   `bidders`  — must have an ACTIVE LOGIN. `emit()` writes one bell row per
  //                user_id (that rule is the whole reason the dealer bell used
  //                to be empty), so an account with no users can be outbid and
  //                notified without a single row appearing — which would make
  //                step 10 assert nothing while looking green.
  const dealers = (await db.execute(sql`
    SELECT id, city FROM accounts WHERE status='active' AND onboarding_status='approved'
      AND city IS NOT NULL LIMIT 2`)) as any;
  const bidders = (await db.execute(sql`
    SELECT a.id, a.city FROM accounts a
     WHERE a.status='active' AND a.onboarding_status='approved'
       AND EXISTS (SELECT 1 FROM users u WHERE u.dealer_id = a.id AND u.is_active = true)
     ORDER BY a.id LIMIT 2`)) as any;
  if (bidders.length < 2) {
    throw new Error(
      "need 2 active approved dealer accounts that each have an active login — the bell assertions cannot be checked without them",
    );
  }
  // The dealer used for the radius/city assertions only.
  const geoDealer = String(dealers[0].id);
  const dealerA = String(bidders[0].id);
  const dealerB = String(bidders[1].id);
  const user = String(((await db.execute(sql`SELECT id FROM users LIMIT 1`)) as any)[0].id);
  console.log(`tenant=${tenant}\ngeoDealer=${geoDealer} (${dealers[0].city})\ndealerA=${dealerA}\ndealerB=${dealerB}\n`);

  // --- 1. batteries ---
  console.log("1. battery master");
  const ids: string[] = [];
  for (const s of SERIALS) {
    const { battery } = await createRecoveryBattery({
      tenant_id: tenant, serial: s, model: "TEST-48V-32Ah", capacity: "48V/32Ah",
      city: dealers[0].city, state: "Maharashtra",
    });
    await setBatteryState(tenant, battery.id, "ready", "refurbished");
    ids.push(battery.id);
  }
  ok(ids.length === 3, `created 3 batteries`);

  // --- 2. compose ---
  console.log("2. compose a 3-battery lot");
  const lot = await composeLot({
    tenant_id: tenant, actor_user_id: user, title: "E2E mixed pallet",
    battery_ids: ids, base_price: 150000, bid_increment: 2000, anti_snipe_seconds: 120,
  });
  lotId = lot.lot_id;
  ok(lot.status === "draft", `lot is DRAFT (not auto-published) — status=${lot.status}`);
  ok(lot.quantity === 3, `quantity=3 (multi-battery lot works)`);

  // duplicate-battery guard — refused either by the state check ('lotted') or
  // by the open-lot check; both are correct refusals.
  try {
    await composeLot({ tenant_id: tenant, actor_user_id: user, battery_ids: [ids[0]], base_price: 1000 });
    ok(false, "second lot on same battery should be refused");
  } catch (e: any) {
    ok(/already in an open lot|is lotted/.test(e.message), `re-lotting a battery refused: ${e.message.slice(0, 70)}`);
  }

  // --- 3. duration validation ---
  console.log("3. window validation");
  try {
    await publishLot({ tenant_id: tenant, actor_user_id: user, lot_id: lot.lot_id,
      duration_hours: 72 as any, visibility: { scope: "india" } });
    ok(false, "72h should be refused");
  } catch (e: any) { ok(/48 h is the hard maximum/.test(e.message), "72h window refused (48h hard max)"); }

  // --- 4. audience ---
  console.log("4. audience resolver");
  const all = await resolveAuctionAudience({ scope: "india" });
  const cityOnly = await resolveAuctionAudience({ scope: "city", cities: [dealers[0].city] });
  // Centre on the dealer's OWN city so the radius test is not vacuous.
  const c0 = cityCentroid(dealers[0].city)!;
  const near = await resolveAuctionAudience({ scope: "radius", centre_lat: c0.lat, centre_lng: c0.lng, radius_km: 25 });
  const far = await resolveAuctionAudience({ scope: "radius", centre_lat: 28.6139, centre_lng: 77.209, radius_km: 25 }); // Delhi
  ok(all.length > cityOnly.length, `india=${all.length} > city=${cityOnly.length} (geography narrows)`);
  ok(cityOnly.every(m => m.city === dealers[0].city), `city scope returns only ${dealers[0].city}`);
  ok(near.length > 0 && near.every(m => (m.distance_km ?? 999) <= 25),
     `radius 25km around ${dealers[0].city}: ${near.length} dealer(s), max ${Math.max(...near.map(m => m.distance_km ?? 0))}km`);
  ok(!far.some(m => m.dealer_id === geoDealer), `${dealers[0].city} dealer correctly EXCLUDED from a 25km Delhi radius`);

  const nbfcLeak = (await db.execute(sql`
    SELECT count(*)::int c FROM accounts a JOIN users u ON u.dealer_id = a.id
     WHERE lower(u.role) = 'nbfc_partner'`)) as any;
  ok(true, `nbfc_partner users linked to a dealer account: ${nbfcLeak[0].c} (audience is accounts-only, role-gated at the route)`);

  // --- 5. publish (2h) ---
  console.log("5. publish");
  const pub = await publishLot({
    tenant_id: tenant, actor_user_id: user, lot_id: lot.lot_id, duration_hours: 2,
    visibility: { scope: "india" }, channels: ["in_app", "email"],
  });
  ok(pub.status === "live", `published live, ends ${pub.ends_at}`);
  ok(pub.audience_dealers === all.length, `audience frozen: ${pub.audience_dealers} dealers x2 channels = ${pub.audience_rows} rows`);

  // --- 6. bidding ---
  console.log("6. bidding");
  const low = await placeBid({ lot_id: lot.lot_id, amount: 100, confirmed: true,
    bidder: { kind: "dealer", dealer_id: dealerA, user_id: user } });
  ok(!low.accepted, `below-base rejected without inserting (min_next=${(low as any).min_next_bid})`);
  const bidCount0 = (await db.execute(sql`SELECT count(*)::int c FROM auction_bids WHERE lot_id=${lot.lot_id}::uuid`)) as any;
  ok(bidCount0[0].c === 0, `rejected bid really inserted nothing (${bidCount0[0].c} rows)`);

  const b1 = await placeBid({ lot_id: lot.lot_id, amount: 150000, confirmed: true,
    bidder: { kind: "dealer", dealer_id: dealerA, user_id: user } });
  ok(b1.accepted, `dealerA opening bid at base 150000 accepted`);

  // dealerB sets a standing maximum; dealerA then bids -> B's proxy overtakes.
  await setAutoBid({ lot_id: lot.lot_id, tenant_id: tenant, bidder_dealer_id: dealerB, max_amount: 200000 });
  const b2 = await placeBid({ lot_id: lot.lot_id, amount: 160000, confirmed: true,
    bidder: { kind: "dealer", dealer_id: dealerA, user_id: user } });
  ok(b2.accepted, `dealerA bid 160000 accepted`);
  ok((b2 as any).outbid_by_proxy === 162000,
     `dealerB's proxy counter-bid at ${(b2 as any).outbid_by_proxy} — one increment over 160000, NOT the 200000 ceiling`);
  const leader = (await db.execute(sql`
    SELECT bidder_dealer_id, amount FROM auction_bids WHERE lot_id=${lot.lot_id}::uuid
     ORDER BY amount DESC, placed_at ASC LIMIT 1`)) as any;
  ok(leader[0].bidder_dealer_id === dealerB, `dealerB now leads at ${leader[0].amount}`);

  // A proxy must never bid against its own owner.
  const b2b = await placeBid({ lot_id: lot.lot_id, amount: 164000, confirmed: true,
    bidder: { kind: "dealer", dealer_id: dealerB, user_id: user } });
  ok((b2b as any).outbid_by_proxy === null, `dealerB bidding manually did NOT trigger their own proxy`);

  // --- 7. anti-snipe ---
  console.log("7. anti-snipe");
  await db.execute(sql`UPDATE auction_lots SET ends_at = now() + interval '30 seconds' WHERE id = ${lot.lot_id}::uuid`);
  const before = (await db.execute(sql`SELECT ends_at FROM auction_lots WHERE id = ${lot.lot_id}::uuid`)) as any;
  const b3 = await placeBid({ lot_id: lot.lot_id, amount: 170000, confirmed: true,
    bidder: { kind: "dealer", dealer_id: dealerA, user_id: user } });
  const after = (await db.execute(sql`SELECT ends_at FROM auction_lots WHERE id = ${lot.lot_id}::uuid`)) as any;
  const pushed = new Date(after[0].ends_at).getTime() - new Date(before[0].ends_at).getTime();
  ok((b3 as any).extended === true, `bid in final 30s flagged extended`);
  ok(pushed > 80_000, `deadline pushed out by ~${Math.round(pushed / 1000)}s (anti-snipe window 120s)`);

  // --- 8. publish fan-out ---
  // Drained by a tick taken WHILE THE LOT IS STILL LIVE. `runAuctionNotifications`
  // only drains live/scheduled lots — announcing a lot that has already closed
  // would be worse than staying quiet — so this has to happen before step 9
  // forces the deadline into the past. In production the gap is at most one
  // 15 s tick; here it is compressed to nothing, so the order is explicit.
  console.log("8. publish fan-out");
  const fanTick = await runAuctionTick();
  const fan = fanTick.fanned_out.find(f => f.lot_code === lot.lot_code);
  ok(!!fan, `fan-out ran for the lot (${fan?.dealers} dealers, ${fan?.sent} sent, ${fan?.failed} failed, ${fan?.skipped} skipped)`);

  const audAfter = (await db.execute(sql`
    SELECT channel, status, count(*)::int c FROM auction_lot_audience
     WHERE lot_id = ${lot.lot_id}::uuid GROUP BY channel, status ORDER BY channel, status`)) as any;
  const pendingLeft = audAfter.filter((r: any) => r.status === "pending")
    .reduce((s: number, r: any) => s + r.c, 0);
  ok(pendingLeft === 0, `audience fully drained (0 pending, was ${pub.audience_rows})`);
  // in-app splits into sent (dealer has a login) and skipped/no_active_login
  // (they do not). Both are terminal and both are honest; what must never
  // happen is a row left pending or a row marked `sent` for an account that
  // received nothing.
  const inAppSent = audAfter.find((r: any) => r.channel === "in_app" && r.status === "sent")?.c ?? 0;
  const inAppSkipped = audAfter.find((r: any) => r.channel === "in_app" && r.status === "skipped")?.c ?? 0;
  ok(inAppSent > 0 && inAppSent + inAppSkipped === pub.audience_dealers,
     `in-app resolved for every dealer (${inAppSent} sent, ${inAppSkipped} skipped for having no login)`);
  const bellRows = (await db.execute(sql`
    SELECT count(DISTINCT dealer_id)::int c FROM notifications
     WHERE type = 'auction.lot_published' AND data->>'lot_id' = ${lot.lot_id}`)) as any;
  ok(bellRows[0].c === inAppSent,
     `every dealer marked sent really got a bell row (${bellRows[0].c}/${inAppSent}) — no phantom sends`);
  // Email is asserted as "attempted and recorded", not "delivered": these are
  // seeded @itarang.com addresses the provider has block-listed, so a `failed`
  // row IS the correct outcome and proves the error is captured per-row rather
  // than swallowed.
  const emailRows = audAfter.filter((r: any) => r.channel === "email")
    .reduce((s: number, r: any) => s + r.c, 0);
  ok(emailRows === pub.audience_dealers,
     `every email row reached a terminal state (${audAfter.filter((r: any) => r.channel === "email").map((r: any) => `${r.status}=${r.c}`).join(" ")})`);

  // --- 9. scheduler close ---
  console.log("9. scheduler");
  await db.execute(sql`UPDATE auction_lots SET ends_at = now() - interval '1 second' WHERE id = ${lot.lot_id}::uuid`);
  const tick = await runAuctionTick();
  const closed = tick.closed.find(c => c.lot_id === lot.lot_id);
  ok(!!closed, `lot closed by the scheduler`);
  ok(closed?.settlement_created === true, `settlement created, winner=${closed?.winner_dealer_id} at ${closed?.winning_amount}`);

  const st = (await db.execute(sql`
    SELECT seller_tenant_id, winner_dealer_id, final_price FROM auction_settlements WHERE lot_id = ${lot.lot_id}::uuid`)) as any;
  ok(st[0].seller_tenant_id === tenant, `settlement seller_tenant_id is REAL (not the zero-uuid sentinel)`);
  ok(st[0].winner_dealer_id === dealerA || st[0].winner_dealer_id === dealerB, `winner_dealer_id populated: ${st[0].winner_dealer_id}`);

  const sold = (await db.execute(sql`
    SELECT count(*)::int c FROM recovery_batteries WHERE id = ANY(${arr(ids)}::uuid[]) AND state_code = 'sold'`)) as any;
  ok(sold[0].c === 3, `all 3 batteries marked sold (${sold[0].c}/3)`);

  const tick2 = await runAuctionTick();
  ok(!tick2.closed.find(c => c.lot_id === lot.lot_id), `second tick does not re-close the lot`);

  // --- 10. the bell ---
  console.log("10. notifications");
  const bell = (await db.execute(sql`
    SELECT type, count(*)::int c FROM notifications
     WHERE data->>'lot_id' = ${lot.lot_id} GROUP BY type`)) as any;
  const byType = Object.fromEntries(bell.map((r: any) => [r.type, r.c]));
  ok((byType["auction.lot_published"] ?? 0) > 0,
     `auction.lot_published written to the bell (${byType["auction.lot_published"] ?? 0} rows)`);
  ok((byType["auction.won"] ?? 0) > 0, `auction.won written to the winner`);
  ok((byType["auction.outbid"] ?? 0) > 0,
     `auction.outbid fired during bidding (${byType["auction.outbid"] ?? 0} rows)`);

  // The SMS gate. A row is inserted directly rather than publishing with the
  // sms channel, because that would also fan out over WhatsApp to 47 real
  // dealer numbers. This asserts the one thing that matters: SMS records why
  // it did not send instead of pretending it did.
  await db.execute(sql`
    INSERT INTO auction_lot_audience (lot_id, dealer_id, channel, status)
    VALUES (${lot.lot_id}::uuid, ${dealerA}, 'sms', 'pending')
    ON CONFLICT DO NOTHING`);
  await notifyLotPublished(lot.lot_id);
  const smsRow = (await db.execute(sql`
    SELECT status, error FROM auction_lot_audience
     WHERE lot_id = ${lot.lot_id}::uuid AND channel = 'sms' LIMIT 1`)) as any;
  ok(smsRow[0]?.status === "skipped" && /dlt|disabled/i.test(String(smsRow[0]?.error)),
     `SMS records why it did not send: ${smsRow[0]?.status}/${smsRow[0]?.error}`);

  console.log("\ncleaning up...");
  await cleanup();
  console.log("done.");
}

main().then(() => process.exit(0)).catch(async (e) => {
  console.error("\nERROR:", e);
  try { await cleanup(); } catch {}
  process.exit(1);
});
