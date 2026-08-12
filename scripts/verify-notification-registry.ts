/**
 * Checks the E-231 notification registry against a live database.
 *
 * WHY THIS EXISTS ON TOP OF THE UNIT TEST. `registry.test.ts` can only compare
 * the registry against the two taxonomy maps — it sees what the code CLAIMS is
 * emittable. It cannot see a `type` string that some route passes to notifyRoles
 * and nobody ever added to `CATEGORY_BY_TYPE`: that type is real, it lands in
 * the bell, and it is invisible to the admin Notification Access screen because
 * the screen derives its list from the maps. Same story for a `users.role` value
 * that exists in the wild but in no registry (ops_manager, super_admin,
 * risk_head): those users receive everything and no dashboard governs them.
 *
 * Only the database knows about either. Run this against sandbox before shipping
 * a change to the registry, and after any release that adds an emitter.
 *
 *   npm run verify:notifications
 *
 * Exits non-zero if anything is unaccounted for, so it can gate a deploy.
 */
import postgres from "postgres";

import {
  DASHBOARDS,
  assertRegistryComplete,
  isKnownType,
} from "../src/lib/notifications/registry";

const LOOKBACK_DAYS = 180;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Try: npm run verify:notifications --  (with .env.local loaded)");
    process.exit(2);
  }

  // Cheapest check first, and the only one that needs no database.
  try {
    assertRegistryComplete();
    console.log("✓ registry is internally complete (every catalogued type has a label)");
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exitCode = 1;
  }

  const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
  let problems = 0;

  try {
    console.log(`\nhost: ${new URL(url).host}`);

    const types = await sql<{ type: string; n: number }[]>`
      SELECT type, COUNT(*)::int AS n
        FROM notifications
       WHERE created_at > now() - ${`${LOOKBACK_DAYS} days`}::interval
       GROUP BY type
       ORDER BY n DESC
    `;
    const unknownTypes = types.filter((t) => !isKnownType(t.type));
    if (unknownTypes.length === 0) {
      console.log(`✓ all ${types.length} type(s) seen in the last ${LOOKBACK_DAYS}d are governable`);
    } else {
      problems += unknownTypes.length;
      console.error(
        `\n✗ ${unknownTypes.length} notification type(s) reach the bell but are NOT in the ` +
          `catalogue, so they cannot be muted from the admin screen:`,
      );
      for (const t of unknownTypes) console.error(`    ${t.type}  (${t.n} rows)`);
      console.error(`  Fix: map each in src/lib/notifications/catalog.ts, then label it in registry.ts.`);
    }

    const known = new Set(DASHBOARDS.map((d) => d.value));
    const roles = await sql<{ role: string; n: number }[]>`
      SELECT LOWER(role) AS role, COUNT(*)::int AS n
        FROM users
       WHERE is_active = TRUE AND role IS NOT NULL
       GROUP BY LOWER(role)
       ORDER BY n DESC
    `;
    const unknownRoles = roles.filter((r) => r.role && !known.has(r.role));
    if (unknownRoles.length === 0) {
      console.log(`✓ all ${roles.length} active role(s) map to a dashboard on the screen`);
    } else {
      problems += unknownRoles.length;
      console.error(
        `\n✗ ${unknownRoles.length} active role(s) are governed by no dashboard, so those users ` +
          `receive every notification:`,
      );
      for (const r of unknownRoles) console.error(`    ${r.role}  (${r.n} active user(s))`);
      console.error(`  Fix: add to DASHBOARDS in src/lib/notifications/registry.ts, or confirm it is intentional.`);
    }

    // Rows the screen wrote that the resolver can no longer match — e.g. a type
    // renamed after someone muted it. Harmless but misleading: the checkbox
    // shows muted while notifications keep arriving.
    const stale = await sql<{ dashboard: string; notification_type: string }[]>`
      SELECT dashboard, notification_type FROM notification_access
    `.catch(() => []);
    const orphaned = stale.filter(
      (r) => !isKnownType(r.notification_type) || !known.has(r.dashboard),
    );
    if (stale.length === 0) {
      console.log("· notification_access is empty (no overrides saved yet)");
    } else if (orphaned.length === 0) {
      console.log(`✓ all ${stale.length} saved override(s) still resolve`);
    } else {
      problems += orphaned.length;
      console.error(`\n✗ ${orphaned.length} saved override(s) name something the registry no longer knows:`);
      for (const r of orphaned) console.error(`    ${r.dashboard} / ${r.notification_type}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (problems > 0 || process.exitCode === 1) {
    console.error(`\nverify-notification-registry: ${problems} problem(s) found.`);
    process.exit(1);
  }
  console.log("\nverify-notification-registry: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
