/**
 * [E-256] Guards on the admin "start auction" action.
 *
 * Non-mutating by construction: every case below is one the service must
 * REFUSE, so a passing run leaves the database exactly as it found it. The
 * happy path is deliberately not exercised here — publishing a lot is a real,
 * announced event, not something a verifier should do behind an operator's
 * back. It runs through `publishLot()`, the same function the seller's own
 * composer calls.
 *
 *   node --import tsx --env-file=.env.local scripts/_verify-e256-admin-start.ts
 */
import { db } from "@/lib/db";
import { auctionLots } from "@/lib/db/schema";
import { startAuction } from "@/lib/nbfc/admin/auctionControlService";

const ACTOR = "00000000-0000-0000-0000-000000000000";

async function expectThrow(label: string, prefix: string, run: () => Promise<unknown>) {
  try {
    await run();
    console.log(`FAIL  ${label} — expected ${prefix}, got success`);
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const ok = msg.startsWith(prefix);
    console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${msg}`);
    return ok;
  }
}

async function main() {
  const lots = await db
    .select({ id: auctionLots.id, lot_code: auctionLots.lot_code, status: auctionLots.status })
    .from(auctionLots);
  const byStatus = (s: string) => lots.find((l) => l.status === s);
  console.log(`lots on this database: ${lots.map((l) => `${l.lot_code}=${l.status}`).join(", ") || "none"}\n`);

  const results: boolean[] = [];

  results.push(
    await expectThrow("missing reason", "BAD_REQUEST", () =>
      startAuction({ lot_id: lots[0]?.id ?? ACTOR, reason: "   ", actor_user_id: ACTOR }),
    ),
  );

  results.push(
    await expectThrow("unknown lot", "NOT_FOUND", () =>
      startAuction({
        lot_id: "11111111-1111-1111-1111-111111111111",
        reason: "verifier",
        actor_user_id: ACTOR,
      }),
    ),
  );

  const paused = byStatus("paused");
  if (paused) {
    results.push(
      await expectThrow(`paused lot ${paused.lot_code} points at Resume`, "CONFLICT", () =>
        startAuction({ lot_id: paused.id, reason: "verifier", actor_user_id: ACTOR }),
      ),
    );
  } else {
    console.log("SKIP  no paused lot on this database");
  }

  const ended = byStatus("ended");
  if (ended) {
    results.push(
      await expectThrow(`ended lot ${ended.lot_code} cannot be started`, "CONFLICT", () =>
        startAuction({ lot_id: ended.id, reason: "verifier", actor_user_id: ACTOR }),
      ),
    );
  } else {
    console.log("SKIP  no ended lot on this database");
  }

  const draft = byStatus("draft");
  if (draft) {
    results.push(
      await expectThrow(`draft ${draft.lot_code} without a visibility rule`, "BAD_REQUEST", () =>
        startAuction({ lot_id: draft.id, reason: "verifier", actor_user_id: ACTOR, duration_hours: 12 }),
      ),
    );
    results.push(
      await expectThrow(`draft ${draft.lot_code} with a rule that reaches nobody`, "CONFLICT", () =>
        startAuction({
          lot_id: draft.id,
          reason: "verifier",
          actor_user_id: ACTOR,
          duration_hours: 12,
          visibility: { scope: "city", cities: ["Nowhere-On-Sea"] },
        }),
      ),
    );
  } else {
    console.log("SKIP  no draft lot on this database — draft-only guards not exercised");
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} guards held`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
