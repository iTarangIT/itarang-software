import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { users } from "../src/lib/db/schema";
import { supabaseAdmin } from "../src/lib/supabase/admin";
import {
  CATEGORY_LABEL,
  CategoryCode,
  DealerEntry,
  classify,
  groupByCategory,
  loadAllAuthUsers,
  loadDealerRds,
  loadOpenApplications,
  printEnvBanner,
} from "./_dealer-sync-core";

const ALL_CATEGORIES: CategoryCode[] = ["A", "B", "C", "D", "E", "F"];
const DEFAULT_SELECTED: CategoryCode[] = ["B", "D", "E"];

function parseSelected(argv: string[]): CategoryCode[] {
  const flag = argv.find((a) => a.startsWith("--only-category="));
  if (!flag) return DEFAULT_SELECTED;
  const raw = flag.substring("--only-category=".length);
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is CategoryCode =>
      (ALL_CATEGORIES as string[]).includes(s),
    );
  if (!parsed.length) {
    console.error(
      `--only-category=${raw} produced no valid categories. Use A-F.`,
    );
    process.exit(1);
  }
  return parsed;
}

function describe(e: DealerEntry): string {
  switch (e.category) {
    case "A":
      return `no-op (healthy): ${e.email}`;
    case "B":
      return `update Auth metadata for ${e.email} → role=dealer, dealer_code=${e.rds?.dealer_id ?? "(null)"}`;
    case "C":
      return `SKIP ${e.email}: hard mismatch — rds_id=${e.rds?.id} auth_id=${e.auth?.id}. Manual triage required.`;
    case "D":
      return `delete RDS users row for ${e.email} (id=${e.rds?.id})`;
    case "E":
      return `delete Supabase Auth user ${e.email} (id=${e.auth?.id})`;
    case "F":
      return `no-op (pre-approval): ${e.email}`;
  }
}

async function applyB(e: DealerEntry): Promise<string | null> {
  if (!e.auth || !e.rds) return "missing auth or rds";
  const { error } = await supabaseAdmin.auth.admin.updateUserById(e.auth.id, {
    user_metadata: {
      ...e.auth.metadata,
      role: "dealer",
      dealer_code: e.rds.dealer_id ?? null,
    },
  });
  return error ? error.message : null;
}

async function applyD(e: DealerEntry): Promise<string | null> {
  if (!e.rds) return "missing rds";
  try {
    await db.delete(users).where(eq(users.email, e.email));
    return null;
  } catch (err: any) {
    return err?.message || String(err);
  }
}

async function applyE(e: DealerEntry): Promise<string | null> {
  if (!e.auth) return "missing auth";
  const { error } = await supabaseAdmin.auth.admin.deleteUser(e.auth.id);
  return error ? error.message : null;
}

async function main() {
  const CONFIRM = process.argv.includes("--confirm");
  const selected = parseSelected(process.argv);

  console.log("=".repeat(60));
  console.log("DEALER SYNC REPAIR");
  console.log("=".repeat(60));
  printEnvBanner(CONFIRM ? "LIVE (will modify)" : "DRY RUN");
  console.log("Categories to repair:", selected.join(", "));
  console.log("(C is never auto-repaired; B/D/E are the default set.)");
  console.log("");

  const [rdsList, authList, appList] = await Promise.all([
    loadDealerRds(),
    loadAllAuthUsers(),
    loadOpenApplications(),
  ]);

  const entries = classify(rdsList, authList, appList);
  const byCat = groupByCategory(entries);

  const summary = ALL_CATEGORIES.map((c) => ({
    category: c,
    label: CATEGORY_LABEL[c],
    count: byCat[c].length,
    selected: selected.includes(c) ? "yes" : "no",
  }));
  console.log("Summary:");
  console.table(summary);

  // Always warn loudly about C.
  if (byCat.C.length) {
    console.log("");
    console.log("!".repeat(60));
    console.log(
      `WARNING: ${byCat.C.length} category-C hard mismatches detected.`,
    );
    console.log(
      "These have matching emails but different ids on Supabase vs RDS.",
    );
    console.log(
      "Rewriting an id would break FK references across child tables.",
    );
    console.log("Manual triage required. Rows:");
    for (const e of byCat.C) {
      console.log(
        `  - ${e.email}: rds_id=${e.rds?.id} auth_id=${e.auth?.id}`,
      );
    }
    console.log("!".repeat(60));
  }

  const planned: DealerEntry[] = [];
  for (const c of selected) {
    if (c === "A" || c === "F") continue; // no-op categories
    if (c === "C") continue; // never auto-repaired
    planned.push(...byCat[c]);
  }

  console.log("");
  console.log(`Planned actions (${planned.length}):`);
  if (!planned.length) {
    console.log("  (nothing to do)");
  } else {
    for (const e of planned) {
      console.log(`  [${e.category}] ${describe(e)}`);
    }
  }

  if (!CONFIRM) {
    console.log("");
    console.log("DRY RUN — no changes made.");
    console.log("Re-run with --confirm to execute.");
    console.log("  npx tsx scripts/repair-dealer-sync.ts --confirm");
    process.exit(0);
  }

  if (!planned.length) {
    console.log("");
    console.log("Nothing to repair. Exiting.");
    process.exit(0);
  }

  console.log("");
  console.log("DELETING — 5 second abort window (Ctrl+C)...");
  await new Promise((r) => setTimeout(r, 5000));

  let ok = 0;
  const failures: { entry: DealerEntry; error: string }[] = [];
  for (const e of planned) {
    let err: string | null = null;
    if (e.category === "B") err = await applyB(e);
    else if (e.category === "D") err = await applyD(e);
    else if (e.category === "E") err = await applyE(e);
    if (err) {
      failures.push({ entry: e, error: err });
      console.log(`  ✗ [${e.category}] ${e.email}: ${err}`);
    } else {
      ok += 1;
      console.log(`  ✓ [${e.category}] ${e.email}`);
    }
  }

  console.log("");
  console.log(`Repaired: ${ok}/${planned.length}`);
  if (failures.length) {
    console.log(`Failures : ${failures.length}`);
    for (const f of failures) {
      console.log(`  - [${f.entry.category}] ${f.entry.email}: ${f.error}`);
    }
  }
  console.log("");
  console.log(
    "Re-run `npx tsx scripts/audit-dealer-sync.ts` to verify drift is cleared.",
  );
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
