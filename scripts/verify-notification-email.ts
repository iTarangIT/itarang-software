/**
 * E-284 — verify the email-channel override table against a real DB.
 * READ-ONLY by default: no writes unless --simulate is passed.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-notification-email.ts [--simulate]
 *
 * What it asserts:
 *   1. notification_email_access exists, with the right columns, a single-column
 *      primary key on notification_type, and NO default on `enabled` (an absent
 *      default is what keeps "no row = the code default" from being writable by
 *      accident).
 *   2. Every stored override names a type the registry still knows — an override
 *      on a renamed type is dead weight that silently governs nothing.
 *   3. No override exists on a LOCKED type. The save route rejects one, so a row
 *      here means it was written by hand; the resolver ignores it, which is safe
 *      but misleading.
 *   4. The resolved answer for every governable type, printed as a diff against
 *      the code default — i.e. exactly what the settings screen shows, computed
 *      the way emit() computes it.
 *   5. The un-applied case is benign: with no overrides at all, every type still
 *      resolves through emailWorthy().
 *   6. --simulate only: the round trip actually works. Writes a real override
 *      with the SAME upsert the save route uses, reads it back through the LIVE
 *      cached reader (emailOverrideFor / emailEnabledFor — the exact calls
 *      emit() makes), proves the answer flips, proves the explicit cache
 *      invalidation is what makes it flip immediately, proves a LOCKED type is
 *      immune even to a hand-written row, and proves deleting the row reverts to
 *      the code default rather than to "off".
 *
 *      It uses `lead.created` — ordinary, not locked, emailed by default — and
 *      restores whatever was there before in a finally block, including on
 *      failure, so a run against a live DB leaves no trace. It sends no email:
 *      nothing here calls emit().
 */

export {}; // module scope — keeps Step/steps/failed off the global script namespace

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];
let failed = 0;

function pass(name: string, detail = "") {
  steps.push({ name, ok: true, detail });
  console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, detail: string) {
  steps.push({ name, ok: false, detail });
  failed += 1;
  console.log(`  ✖ ${name} — ${detail}`);
}

async function main() {
  const { db } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");
  const { emailLockedTypes, emailWorthy, resolveEmailChannel } = await import(
    "@/lib/notifications/catalog"
  );
  const { allGovernableTypes, isKnownType, TYPE_LABELS } = await import(
    "@/lib/notifications/registry"
  );

  const host = (process.env.DATABASE_URL || "").match(/@([^:/]+)/)?.[1] ?? "?";
  console.log(`\nE-282 email notification settings — verifying against ${host}\n`);

  // ── 1. Table shape ──────────────────────────────────────────────────────
  const [tbl] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM information_schema.tables
     WHERE table_name = 'notification_email_access'
  `);
  if (!tbl || Number(tbl.n) === 0) {
    fail(
      "table exists",
      "notification_email_access is missing — apply E-284. (The app is FINE " +
        "without it: every type falls back to emailWorthy(), i.e. pre-E-284 " +
        "behaviour. Only the settings tab needs the table.)",
    );
    report();
    return;
  }
  pass("table exists", "notification_email_access");

  const cols = await db.execute<{
    column_name: string;
    is_nullable: string;
    column_default: string | null;
  }>(sql`
    SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'notification_email_access'
  `);
  const byName = new Map(cols.map((c) => [c.column_name, c]));

  const missing = ["notification_type", "enabled", "updated_by", "updated_at"].filter(
    (c) => !byName.has(c),
  );
  if (missing.length === 0) pass("columns present", "all four");
  else fail("columns present", `${missing.join(", ")} missing — E-284 partly applied?`);

  const enabledCol = byName.get("enabled");
  if (enabledCol && enabledCol.column_default === null) {
    pass("enabled has NO default", "an insert must state the answer");
  } else if (enabledCol) {
    fail(
      "enabled has NO default",
      `default is ${enabledCol.column_default} — a row that does not state the answer ` +
        `would silently mean "on", which is not what an absent decision means here`,
    );
  }

  const [pk] = await db.execute<{ cols: string }>(sql`
    SELECT string_agg(a.attname, ',' ORDER BY a.attname) AS cols
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = 'notification_email_access'::regclass AND i.indisprimary
  `);
  if (pk?.cols === "notification_type") {
    pass("primary key", "notification_type");
  } else {
    fail("primary key", `expected notification_type, got ${pk?.cols ?? "none"}`);
  }

  // ── 2-3. The stored overrides ───────────────────────────────────────────
  const rows = await db.execute<{
    notification_type: string;
    enabled: boolean;
    updated_at: string;
  }>(sql`
    SELECT notification_type, enabled, updated_at
      FROM notification_email_access
     ORDER BY notification_type
  `);

  if (rows.length === 0) {
    pass("overrides", "none saved — every type follows the code default");
  } else {
    pass("overrides", `${rows.length} saved`);
  }

  const unknown = rows.filter((r) => !isKnownType(r.notification_type));
  if (unknown.length === 0) {
    pass("every override names a known type", "");
  } else {
    fail(
      "every override names a known type",
      `${unknown.map((r) => r.notification_type).join(", ")} — renamed or removed ` +
        `from the registry, so these rows govern nothing`,
    );
  }

  const lockedSet = new Set(emailLockedTypes());
  const lockedRows = rows.filter((r) => lockedSet.has(r.notification_type));
  if (lockedRows.length === 0) {
    pass("no override on a locked type", "");
  } else {
    fail(
      "no override on a locked type",
      `${lockedRows.map((r) => r.notification_type).join(", ")} — the save route ` +
        `rejects these, so they were written by hand. The resolver ignores them ` +
        `(the type stays emailed), but the row is misleading; delete it.`,
    );
  }

  // ── 4. The resolved answer, as a diff against the code ──────────────────
  const overrides = new Map(rows.map((r) => [r.notification_type, r.enabled]));
  const changed: string[] = [];
  for (const type of allGovernableTypes()) {
    const codeDefault = emailWorthy(type);
    const resolved = resolveEmailChannel(type, overrides.get(type), undefined);
    if (resolved !== codeDefault) {
      changed.push(
        `    ${resolved ? "+" : "-"} ${TYPE_LABELS[type] ?? type} (${type}) — ` +
          `now ${resolved ? "emailed" : "bell only"}, code says ` +
          `${codeDefault ? "emailed" : "bell only"}`,
      );
    }
  }
  if (changed.length === 0) {
    pass("effective settings", "identical to the code default");
  } else {
    pass("effective settings", `${changed.length} type(s) differ from the code:`);
    console.log(changed.join("\n"));
  }

  const off = allGovernableTypes().filter(
    (t) => !resolveEmailChannel(t, overrides.get(t), undefined),
  );
  console.log(
    `\n  ${allGovernableTypes().length - off.length} of ${allGovernableTypes().length} ` +
      `types are emailed; ${off.length} are bell-only.`,
  );

  // ── 5. The un-applied case is benign ────────────────────────────────────
  const answered = allGovernableTypes().every(
    (t) => typeof resolveEmailChannel(t, undefined, undefined) === "boolean",
  );
  if (answered) {
    pass("fails safe with no overrides", "every type resolves via emailWorthy()");
  } else {
    fail("fails safe with no overrides", "a type resolved to a non-boolean");
  }

  if (!process.argv.includes("--simulate")) {
    console.log("\n  (read-only run — pass --simulate to exercise the save/read round trip)");
    report();
    return;
  }

  // ── 6. The round trip, against the real table and the real reader ───────
  const { emailEnabledFor, emailOverrideFor, invalidateEmailAccessCache } = await import(
    "@/lib/notifications/email-access"
  );

  const PROBE = "lead.created"; // ordinary, not locked, emailed by default
  const LOCKED_PROBE = emailLockedTypes()[0];
  const before = overrides.get(PROBE); // restore this exactly, whatever it was

  console.log(`\n  --simulate: round-tripping ${PROBE} (and ${LOCKED_PROBE})\n`);

  try {
    // Baseline through the LIVE reader, not the snapshot taken above.
    invalidateEmailAccessCache();
    if ((await emailEnabledFor(PROBE)) === true) {
      pass("baseline", `${PROBE} is emailed`);
    } else {
      fail("baseline", `${PROBE} is already off — cannot prove the flip from here`);
    }

    // The SAME statement the PATCH route runs.
    await db.execute(sql`
      INSERT INTO notification_email_access
        (notification_type, enabled, updated_by, updated_at)
      VALUES (${PROBE}, FALSE, NULL, NOW())
      ON CONFLICT (notification_type) DO UPDATE
        SET enabled = EXCLUDED.enabled, updated_at = NOW()
    `);

    // WITHOUT invalidating, the 60s snapshot must still say the old answer.
    // This is what makes the save route's explicit invalidate load-bearing
    // rather than decorative.
    if ((await emailEnabledFor(PROBE)) === true) {
      pass("cache holds the old answer until invalidated", "60s TTL behaves as designed");
    } else {
      fail(
        "cache holds the old answer until invalidated",
        "the reader saw the write with no invalidate — the TTL is not being applied",
      );
    }

    invalidateEmailAccessCache();
    const flipped = await emailEnabledFor(PROBE);
    const rawOverride = await emailOverrideFor(PROBE);
    if (flipped === false && rawOverride === false) {
      pass("override takes effect", `${PROBE} is now bell-only`);
    } else {
      fail(
        "override takes effect",
        `expected emailEnabledFor=false/override=false, got ${flipped}/${rawOverride}`,
      );
    }

    // The exact expression emit() evaluates, including a per-recipient flag.
    if (resolveEmailChannel(PROBE, rawOverride, undefined) === false) {
      pass("emit() would not send it", "resolveEmailChannel agrees with the reader");
    } else {
      fail("emit() would not send it", "resolveEmailChannel disagrees with the reader");
    }
    if (resolveEmailChannel(PROBE, rawOverride, true) === false) {
      pass("override beats a per-recipient email flag", "");
    } else {
      fail("override beats a per-recipient email flag", "the call site won — precedence is wrong");
    }

    // A locked type must be immune even to a row written behind the API's back.
    await db.execute(sql`
      INSERT INTO notification_email_access
        (notification_type, enabled, updated_by, updated_at)
      VALUES (${LOCKED_PROBE}, FALSE, NULL, NOW())
      ON CONFLICT (notification_type) DO UPDATE
        SET enabled = EXCLUDED.enabled, updated_at = NOW()
    `);
    invalidateEmailAccessCache();
    if ((await emailEnabledFor(LOCKED_PROBE)) === true) {
      pass("locked type is immune", `${LOCKED_PROBE} still emails despite a false row`);
    } else {
      fail(
        "locked type is immune",
        `${LOCKED_PROBE} was silenced by a hand-written row — the lock is not holding`,
      );
    }

    // Deleting the row must revert to the code default, not to "off".
    await db.execute(sql`
      DELETE FROM notification_email_access WHERE notification_type = ${PROBE}
    `);
    invalidateEmailAccessCache();
    if ((await emailEnabledFor(PROBE)) === true) {
      pass("removing the row reverts to the code default", "");
    } else {
      fail(
        "removing the row reverts to the code default",
        "it stayed off — absence was read as a denial",
      );
    }
  } finally {
    // Restore exactly what was there before, whatever happened above.
    await db.execute(sql`
      DELETE FROM notification_email_access
       WHERE notification_type IN (${PROBE}, ${LOCKED_PROBE})
    `);
    if (before !== undefined) {
      await db.execute(sql`
        INSERT INTO notification_email_access
          (notification_type, enabled, updated_by, updated_at)
        VALUES (${PROBE}, ${before}, NULL, NOW())
        ON CONFLICT (notification_type) DO UPDATE SET enabled = EXCLUDED.enabled
      `);
    }
    invalidateEmailAccessCache();
    const [left] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM notification_email_access
       WHERE notification_type IN (${PROBE}, ${LOCKED_PROBE})
    `);
    console.log(
      `\n  cleanup: ${before === undefined ? "no rows restored" : `restored ${PROBE}=${before}`}` +
        ` — probe rows still present: ${left?.n ?? "?"}`,
    );
  }

  report();
}

function report() {
  console.log(
    `\n${failed === 0 ? "ALL GREEN" : `${failed} FAILED`} — ${steps.length} assertion(s)\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nverify-notification-email crashed:", err);
  process.exit(1);
});
