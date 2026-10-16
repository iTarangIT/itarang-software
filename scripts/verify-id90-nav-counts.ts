// ID 90 — the left menu's waiting counts, worked out exactly as /api/admin/nav-counts
// does, per role, and checked against the lists the queue pages render. Read-only.
//
//   node --import tsx --env-file=.env.local scripts/verify-id90-nav-counts.ts
//
// Prints each role's counts, then for the queues whose page loads a full list
// (Number repair, Ready to assign, WhatsApp onboarding) re-counts that list and
// says whether it matches. Writes nothing.

async function main() {
  const { NAV_QUEUES_BY_ROLE, navQueueCounts } = await import("@/lib/nav/queueCounts");
  const { listNumberRepair } = await import("@/lib/leads/contactability");
  const { listReadyToAssign } = await import("@/lib/leads/salesReady");
  const { whatsappOnboardingSummary } = await import("@/lib/whatsapp/onboardingSummary");

  const byRole: Record<string, Record<string, number>> = {};
  for (const role of Object.keys(NAV_QUEUES_BY_ROLE)) {
    byRole[role] = await navQueueCounts(role);
    console.log(`${role}:`, JSON.stringify(byRole[role]));
  }

  const admin = byRole.admin ?? {};
  let ok = true;
  const check = (label: string, menu: number | undefined, page: number) => {
    const same = menu === page;
    ok &&= same;
    console.log(`${same ? "OK  " : "DIFF"} ${label}: menu ${menu ?? "-"} · page ${page}`);
  };
  check("Number repair", admin.numberRepair, (await listNumberRepair(100_000)).length);
  check("Ready to assign", admin.readyToAssign, (await listReadyToAssign({ limit: 100_000 })).length);
  check("WhatsApp onboarding (still in progress)", admin.whatsappOnboarding, (await whatsappOnboardingSummary()).inProgress);
  console.log(ok ? "All checked counts match their pages." : "Some counts differ — see DIFF lines.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
