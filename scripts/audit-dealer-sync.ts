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

function formatRow(e: DealerEntry) {
  return {
    email: e.email,
    rds_id: e.rds?.id ?? "",
    auth_id: e.auth?.id ?? "",
    rds_dealer_id: e.rds?.dealer_id ?? "",
    auth_role:
      (typeof e.auth?.metadata.role === "string"
        ? (e.auth.metadata.role as string)
        : "") || "",
    auth_dealer_code:
      (typeof e.auth?.metadata.dealer_code === "string"
        ? (e.auth.metadata.dealer_code as string)
        : "") || "",
    app_status: e.app?.onboardingStatus ?? "",
  };
}

async function main() {
  console.log("=".repeat(60));
  console.log("DEALER SYNC AUDIT (read-only)");
  console.log("=".repeat(60));
  printEnvBanner("AUDIT");

  const [rdsList, authList, appList] = await Promise.all([
    loadDealerRds(),
    loadAllAuthUsers(),
    loadOpenApplications(),
  ]);

  console.log("Loaded:");
  console.log("  RDS users (role=dealer)            :", rdsList.length);
  console.log("  Supabase Auth users (all, paginated):", authList.length);
  console.log("  Non-approved applications          :", appList.length);
  console.log("");

  const entries = classify(rdsList, authList, appList);
  const byCat = groupByCategory(entries);

  const summary = (Object.keys(byCat) as CategoryCode[]).map((c) => ({
    category: c,
    label: CATEGORY_LABEL[c],
    count: byCat[c].length,
  }));

  console.log("Summary:");
  console.table(summary);

  for (const c of ["A", "B", "C", "D", "E", "F"] as CategoryCode[]) {
    const rows = byCat[c];
    if (!rows.length) continue;
    console.log("");
    console.log(`--- Category ${c} — ${CATEGORY_LABEL[c]} (${rows.length}) ---`);
    console.table(rows.map(formatRow));
  }

  const drift = byCat.B.length + byCat.C.length + byCat.D.length + byCat.E.length;
  console.log("");
  if (drift === 0) {
    console.log("No drift detected. Both stores are in sync.");
  } else {
    console.log(`Drift detected: ${drift} entries across B/C/D/E.`);
    console.log(
      "Run `npx tsx scripts/repair-dealer-sync.ts` for a dry-run repair plan.",
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
