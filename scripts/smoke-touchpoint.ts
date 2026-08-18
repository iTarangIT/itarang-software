/**
 * Smoke test for the Part 0 foundation:
 *   - canTransition() lifecycle helper (pure)
 *   - writeTouchpoint() — DB transaction: lead_touchpoints + status history
 *     + dealer_leads.last_touchpoint_at / lead_status update
 *
 * Usage: npx tsx scripts/smoke-touchpoint.ts
 * Requires .env.local: DATABASE_URL (AWS RDS)
 *
 * Creates a temporary dealer_leads row, runs three scenarios against it,
 * verifies side effects, then deletes the test row + audit rows. Idempotent
 * — re-run as many times as you like. Exits non-zero on any check fail.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import "dotenv/config";
import { sql as drizzleSql } from "drizzle-orm";
import { db } from "../src/lib/db";
import {
  canTransition,
  HIGH_IMPACT_LOST_REASONS,
} from "../src/lib/lifecycle/transitions";
import { writeTouchpoint } from "../src/lib/touchpoints/write";

require("dotenv").config({ path: ".env.local" });

const TEST_LEAD_ID = `DL-SMOKE-${Date.now()}`;
const TEST_USER_ID = "00000000-0000-0000-0000-000000000001"; // synthetic

let failures = 0;

function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `   (${detail})` : ""}`);
  }
}

async function cleanup() {
  try {
    await db.execute(drizzleSql`DELETE FROM lead_touchpoints WHERE dealer_lead_id = ${TEST_LEAD_ID}`);
    await db.execute(drizzleSql`DELETE FROM dealer_lead_status_history WHERE dealer_lead_id = ${TEST_LEAD_ID}`);
    await db.execute(drizzleSql`DELETE FROM dealer_leads WHERE id = ${TEST_LEAD_ID}`);
  } catch (e) {
    console.error("cleanup error:", e);
  }
}

async function main() {
  console.log("Part 0 foundation smoke");
  console.log("=======================\n");

  // ── 1. Lifecycle engine — pure, no DB ──────────────────────────────────
  console.log("1. canTransition() — every transition is allowed");
  {
    const r = canTransition("New_Unassigned", "Assigned_Not_Contacted", {});
    assert("New_Unassigned → Assigned_Not_Contacted is allowed", r.ok);
  }
  {
    // The engaged-touchpoint gate is gone — reps set the status they reached.
    const r = canTransition("Assigned_Not_Contacted", "Under_Discussion", {
      engagedTouchpointCount: 0,
    });
    assert("Under_Discussion allowed without engaged touchpoint", r.ok);
  }
  {
    // The final_price gate is gone.
    const r = canTransition("Commercials_Explained", "Commercials_Finalised", {
      finalPrice: null,
    });
    assert("Commercials_Finalised allowed without final_price", r.ok);
  }
  {
    // Backwards moves are legal: an ASM visit can reopen the conversation.
    const r = canTransition("Transferred_to_ASM", "Under_Discussion", {});
    assert("Transferred_to_ASM → Under_Discussion allowed", r.ok);
  }
  {
    // Reopening a closed lead is no longer admin-only.
    const r = canTransition("Converted", "Lost", {
      actorRole: "inside_sales_rep",
      lostReason: "other",
    });
    assert("Converted → Lost allowed for a rep", r.ok);
  }
  {
    const high = HIGH_IMPACT_LOST_REASONS;
    assert(
      "HIGH_IMPACT_LOST_REASONS = BRD 4-tuple",
      high.length === 4 &&
        high.includes("business_closed") &&
        high.includes("duplicate_lead") &&
        high.includes("rejected_by_us_credit") &&
        high.includes("rejected_by_us_geography"),
    );
  }

  // ── 2. Touchpoint writer — DB transaction ─────────────────────────────
  console.log("\n2. writeTouchpoint() — BRD §0.13 audit + §0.7 status update");

  await cleanup();
  await db.execute(drizzleSql`
    INSERT INTO dealer_leads (id, dealer_name, phone, lead_status, current_owner_id, created_at)
    VALUES (${TEST_LEAD_ID}, 'SMOKE TEST DEALER', ${`+91${Date.now().toString().slice(-10)}`}, 'Assigned_Not_Contacted', ${TEST_USER_ID}, NOW())
  `);

  // Scenario A: a no-status-change touchpoint just bumps last_touchpoint_at.
  await writeTouchpoint({
    dealerLeadId: TEST_LEAD_ID,
    touchpointType: "inside_sales_call",
    performedBy: TEST_USER_ID,
    callStatus: "connected",
    isEngaged: true,
    remarks: "initial qualifying call",
  });

  {
    const rows = await db.execute<{ count: string }>(
      drizzleSql`SELECT count(*)::text AS count FROM lead_touchpoints WHERE dealer_lead_id = ${TEST_LEAD_ID}`,
    );
    assert(
      "touchpoint inserted",
      Number(rows[0]?.count ?? 0) === 1,
      `count=${rows[0]?.count}`,
    );
  }
  {
    const rows = await db.execute<{ last_touchpoint_at: string | null }>(
      drizzleSql`SELECT last_touchpoint_at FROM dealer_leads WHERE id = ${TEST_LEAD_ID}`,
    );
    assert(
      "dealer_leads.last_touchpoint_at bumped",
      rows[0]?.last_touchpoint_at != null,
    );
  }
  {
    const rows = await db.execute<{ count: string }>(
      drizzleSql`SELECT count(*)::text AS count FROM dealer_lead_status_history WHERE dealer_lead_id = ${TEST_LEAD_ID}`,
    );
    assert(
      "no status history row (no statusChange supplied)",
      Number(rows[0]?.count ?? 0) === 0,
      `count=${rows[0]?.count}`,
    );
  }

  // Scenario B: a touchpoint WITH statusChange writes history + updates dealer_leads.lead_status.
  await writeTouchpoint({
    dealerLeadId: TEST_LEAD_ID,
    touchpointType: "status_change_note",
    performedBy: TEST_USER_ID,
    statusChange: {
      from: "Assigned_Not_Contacted",
      to: "Under_Discussion",
      reasonNotes: "dealer engaged",
    },
  });

  {
    const rows = await db.execute<{ lead_status: string | null }>(
      drizzleSql`SELECT lead_status FROM dealer_leads WHERE id = ${TEST_LEAD_ID}`,
    );
    assert(
      "dealer_leads.lead_status = Under_Discussion",
      rows[0]?.lead_status === "Under_Discussion",
      `actual=${rows[0]?.lead_status}`,
    );
  }
  {
    const rows = await db.execute<{ count: string }>(
      drizzleSql`SELECT count(*)::text AS count FROM dealer_lead_status_history WHERE dealer_lead_id = ${TEST_LEAD_ID} AND to_status = 'Under_Discussion'`,
    );
    assert(
      "dealer_lead_status_history row written",
      Number(rows[0]?.count ?? 0) === 1,
      `count=${rows[0]?.count}`,
    );
  }

  // Scenario C: Terminal transition fills closed_at + closing_owner_id + closing_role.
  await writeTouchpoint({
    dealerLeadId: TEST_LEAD_ID,
    touchpointType: "status_change_note",
    performedBy: TEST_USER_ID,
    statusChange: {
      from: "Under_Discussion",
      to: "Lost",
      toLostReason: "not_interested",
      closingRole: "is_phone",
    },
  });

  {
    const rows = await db.execute<{
      lead_status: string | null;
      closed_at: string | null;
      closing_owner_id: string | null;
      closing_role: string | null;
      lost_reason: string | null;
    }>(
      drizzleSql`SELECT lead_status, closed_at, closing_owner_id, closing_role, lost_reason FROM dealer_leads WHERE id = ${TEST_LEAD_ID}`,
    );
    const r = rows[0];
    assert(
      "terminal: lead_status=Lost, closed_at set, closing_owner_id+role set",
      r?.lead_status === "Lost" &&
        r?.closed_at != null &&
        r?.closing_owner_id === TEST_USER_ID &&
        r?.closing_role === "is_phone" &&
        r?.lost_reason === "not_interested",
      JSON.stringify(r),
    );
  }

  // ── 3. Cleanup ─────────────────────────────────────────────────────────
  console.log("\n3. Cleanup");
  await cleanup();
  console.log("  ✓ test rows removed");

  console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check(s)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Fatal:", err);
  await cleanup();
  process.exit(1);
});
