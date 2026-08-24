/**
 * One-off repair for the batteries that `publishLotFromRecovery()` put on an
 * auto-seeded lot without flipping `recovery_batteries.state_code`.
 *
 * Every other path to a lot (composeLot, addLotItems) sets `lotted`; the
 * recovery-board seeder did not, so a battery could sit on a live auction and
 * still read `inspected` / `ready` everywhere else in the product. The code fix
 * is in src/lib/nbfc/auction/createLot.ts — this aligns the rows that were
 * already written.
 *
 * Narrow and idempotent: only batteries that are on a lot which is still in
 * play, and only from a sellable state, so nothing walks `sold` or `scrapped`
 * backwards. Re-running it updates 0 rows.
 *
 *   node --env-file=.env.local scripts/backfill-lotted-batteries.mjs
 */
import pg from "pg";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const { rows } = await client.query(`
  UPDATE recovery_batteries rb
     SET state_code = 'lotted', updated_at = now()
   WHERE rb.state_code IN ('ready', 'inspected')
     AND EXISTS (
       SELECT 1
         FROM auction_lot_items ali
         JOIN auction_lots al ON al.id = ali.lot_id
        WHERE ali.battery_id = rb.id
          AND al.status IN ('draft', 'scheduled', 'live', 'paused')
     )
  RETURNING rb.serial
`);

console.log(`repaired ${rows.length} batter${rows.length === 1 ? "y" : "ies"}`);
for (const r of rows) console.log(`  ${r.serial}`);

await client.end();
