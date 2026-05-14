// One-off diagnostic to reproduce the production scraper-promotion bug.
//
// promoteLeadsToDealerLeads (src/lib/scraper/storage/leadStore.ts) is failing
// to insert into dealer_leads in production. The catch block at line 97
// swallows the real error as a "duplicate count". We don't know the actual
// SQLSTATE. This script reproduces that exact Drizzle call against the DB
// pointed to by DATABASE_URL and pretty-prints every postgres-js error field.
//
// Usage:
//   npx tsx scripts/diagnose-dealer-leads-insert.ts          # sandbox/local
//   npx tsx scripts/diagnose-dealer-leads-insert.ts --synthetic
//   CONFIRM_PROD=yes npx tsx scripts/diagnose-dealer-leads-insert.ts        # prod
//
// NOT committed to git — temporary debug tool. Delete after the root cause
// is identified and fixed.

import * as dotenv from "dotenv";

// CRITICAL: load .env.local BEFORE importing anything that reads
// process.env.DATABASE_URL at module load (src/lib/db/index.ts does this on
// line 5). Static imports get hoisted, so this top-level call wouldn't run
// in time — use dynamic import() below instead.
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const SYNTHETIC_PHONE = "9999999001";

function hostFromUrl(url: string | undefined): string {
  if (!url) return "<unset>";
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "<unparseable>";
  }
}

function printErrorFields(err: any) {
  const fields = [
    "message",
    "code",
    "detail",
    "hint",
    "constraint",
    "constraint_name",
    "severity",
    "routine",
    "where",
    "schema",
    "table",
    "column",
    "dataType",
    "internal_position",
    "internal_query",
    "file",
    "line",
  ];
  console.error("\n=== POSTGRES ERROR FIELDS ===");
  for (const f of fields) {
    if (err?.[f] !== undefined) {
      console.error(`  ${f.padEnd(18)}: ${err[f]}`);
    }
  }
  if (err?.stack) {
    console.error("\n=== STACK ===");
    console.error(err.stack);
  }
  console.error("\n=== RAW err (own props) ===");
  try {
    console.error(JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
  } catch {
    console.error(err);
  }
}

async function main() {
  const host = hostFromUrl(process.env.DATABASE_URL);
  console.log(`[diag] DATABASE_URL host: ${host}`);

  const looksProd =
    /prod/i.test(host) || /prod/i.test(process.env.DATABASE_URL ?? "");
  if (looksProd && process.env.CONFIRM_PROD !== "yes") {
    console.error(
      "[diag] Aborting: DATABASE_URL looks like production. Set CONFIRM_PROD=yes to proceed.",
    );
    process.exit(2);
  }

  // Dynamic imports — only NOW (after dotenv) are env vars populated for
  // src/lib/db/index.ts to read.
  const { sql } = await import("drizzle-orm");
  const { nanoid } = await import("nanoid");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const schema = await import("../src/lib/db/schema");
  const { dealerLeads, scrapedDealerLeads } = schema;
  const { toTenDigits } = await import("../src/lib/ai/phone");

  // Build a fresh Drizzle client with logger ON so we can see the actual SQL.
  // (Don't reuse the cached singleton — it has logger off.)
  const queryClient = postgres(process.env.DATABASE_URL!, {
    ssl: "require",
    prepare: false,
    max: 2,
  });
  const db = drizzle(queryClient, { schema, logger: true });

  // Step 1: show which DB / role / server / row count we're connected to.
  // Compare these against pgAdmin to confirm we're on the same DB.
  try {
    const roleRow = await db.execute(
      sql`SELECT inet_server_addr()::text AS server_ip,
                 current_database() AS db_name,
                 current_user::text AS current_user,
                 session_user::text AS session_user,
                 current_setting('role', true) AS role_setting,
                 (SELECT COUNT(*)::int FROM dealer_leads) AS dealer_leads_total,
                 (SELECT COUNT(*)::int FROM information_schema.columns
                    WHERE table_name='dealer_leads' AND column_name='provider') AS has_provider_col`,
    );
    console.log("[diag] Connected as:", roleRow);
  } catch (err) {
    console.error("[diag] role query failed:", err);
  }

  // Step 2: pick a row to insert. Default to a real scraped row so the test
  // matches what the scraper does. --synthetic for an obviously-unused phone.
  const synthetic = process.argv.includes("--synthetic");
  let rawPhone: string | null = null;
  let dealerName: string | null = null;
  let locationCity: string | null = null;

  if (synthetic) {
    rawPhone = SYNTHETIC_PHONE;
    dealerName = "DIAG Synthetic Test";
    locationCity = "DIAG-City";
    console.log(`[diag] Using synthetic phone ${SYNTHETIC_PHONE}`);
  } else {
    const rows = await db
      .select({
        dealer_name: scrapedDealerLeads.dealer_name,
        phone: scrapedDealerLeads.phone,
        location_city: scrapedDealerLeads.location_city,
      })
      .from(scrapedDealerLeads)
      .where(
        sql`${scrapedDealerLeads.phone} IS NOT NULL AND ${scrapedDealerLeads.phone} <> ''`,
      )
      .limit(1);
    if (!rows.length) {
      console.error(
        "[diag] No scraped_dealer_leads rows with phone found. Use --synthetic.",
      );
      process.exit(3);
    }
    const r = rows[0];
    rawPhone = r.phone;
    dealerName = r.dealer_name;
    locationCity = r.location_city;
    console.log(
      `[diag] Picked scraped row: name=${dealerName}, phone=${rawPhone}, city=${locationCity}`,
    );
  }

  const phone = toTenDigits(rawPhone);
  if (!phone) {
    console.error(
      `[diag] toTenDigits rejected ${rawPhone}. Pick a different row or use --synthetic.`,
    );
    process.exit(4);
  }
  console.log(`[diag] Normalized phone: ${phone}`);

  // Step 3: build the row exactly like leadStore.ts:65-76.
  const row = {
    id: `L-${nanoid(8)}`,
    dealer_name: dealerName?.trim() || null,
    shop_name: dealerName?.trim() || null,
    phone,
    location: locationCity?.trim() || null,
    language: "hindi",
    current_status: "new",
    total_attempts: 0,
    follow_up_history: [] as any,
    created_at: new Date(),
  };
  console.log("[diag] Row to insert:", row);

  // Step 4: the literal three-call chain from leadStore.ts:91-95.
  try {
    console.log("[diag] Attempting Drizzle insert...");
    const res = await db
      .insert(dealerLeads)
      .values([row])
      .onConflictDoNothing({ target: dealerLeads.phone })
      .returning({ id: dealerLeads.id });
    console.log(`[diag] SUCCESS — inserted ${res.length} row(s):`, res);
    if (res.length === 0) {
      console.log(
        "[diag] (returning 0 means ON CONFLICT fired — the row's phone already exists in dealer_leads. Not an error.)",
      );
    }
  } catch (err: any) {
    console.error(
      "[diag] FAILED — this is the error promote chunk swallows in production.",
    );
    printErrorFields(err);
    process.exit(10);
  }

  // Cleanup synthetic insert so the diagnostic is idempotent.
  if (synthetic) {
    try {
      await db.execute(
        sql`DELETE FROM dealer_leads WHERE phone = ${phone} AND dealer_name = 'DIAG Synthetic Test'`,
      );
      console.log("[diag] Cleaned up synthetic row.");
    } catch (err) {
      console.error("[diag] cleanup delete failed (ok if RLS blocks it):", err);
    }
  }

  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  console.error("[diag] Uncaught error in main:", err);
  printErrorFields(err);
  process.exit(1);
});
