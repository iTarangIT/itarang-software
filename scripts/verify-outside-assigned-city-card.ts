/**
 * Read-only check of the E-274 "outside assigned city" risk card against the
 * ACTIVE database (prints the host first — DATABASE_URL flips between
 * database-1 and -2). Writes nothing.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-outside-assigned-city-card.ts [--tenant=<slug>]
 *
 * Shows, per active loan of the tenant: the assigned city and where it came
 * from, whether the centroid index knows it, and — when the IoT bridge is up
 * (`ssh -N iot-bastion`) — the distance from the city centre to the vehicle's
 * latest fix. Then runs the real evaluator and prints the card it would write.
 *
 * Uses the real query builders and the real evaluator rather than restating
 * them, so what it prints is what the cron / Risk page would compute.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getTenantLoanSlice } from "@/lib/nbfc/tenant";
import { loadRiskThresholds } from "@/lib/nbfc/risk-thresholds";
import { HAND_CODED_CARDS } from "@/lib/risk/hand-coded-cards";
import { cityCentroid } from "@/lib/geo/city-centroid";

const SLUG = "outside-assigned-city";

async function main() {
  const host = (process.env.DATABASE_URL ?? "").match(/@([^/:]+)/)?.[1] ?? "unknown";
  console.log(`DB host: ${host}\n`);

  const slugArg = process.argv.find((a) => a.startsWith("--tenant="))?.slice("--tenant=".length);
  const tenants = (await db.execute<{ id: string; slug: string; name: string; n: string }>(sql`
    SELECT t.id, t.slug, t.display_name AS name,
           (SELECT COUNT(*) FROM nbfc_loans l WHERE l.tenant_id = t.id AND l.is_active) ::text AS n
      FROM nbfc_tenants t
     WHERE ${slugArg ? sql`t.slug = ${slugArg}` : sql`TRUE`}
     ORDER BY n DESC
  `)) as unknown as { id: string; slug: string; name: string; n: string }[];

  const tenant = tenants.find((t) => Number(t.n) > 0) ?? tenants[0];
  if (!tenant) {
    console.log("No NBFC tenant found.");
    process.exit(1);
  }
  console.log(`Tenant: ${tenant.name} (${tenant.slug}) — ${tenant.n} active loans\n`);

  // Catalogue + rule presence (the migration's two seeds).
  const [hyp] = (await db.execute<{ id: string; promoted_at: string | null }>(sql`
    SELECT id, promoted_at::text FROM risk_hypotheses WHERE slug = ${SLUG} AND retired_at IS NULL
  `)) as unknown as { id: string; promoted_at: string | null }[];
  console.log(`risk_hypotheses row: ${hyp ? `present (${hyp.id}, promoted ${hyp.promoted_at ? "yes" : "NO"})` : "MISSING — apply drizzle/E-274"}`);
  const thresholds = await loadRiskThresholds();
  console.log(`city_geofence_km: ${thresholds.city_geofence_km} km · offline_alert_hours: ${thresholds.offline_alert_hours}h`);
  if (hyp) {
    const vis = (await db.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n FROM nbfc_risk_card_visibility WHERE hypothesis_id = ${hyp.id} AND tenant_id = ${tenant.id}
    `)) as unknown as { n: string }[];
    console.log(`visible to this tenant: ${Number(vis[0]?.n ?? 0) > 0 ? "yes" : "NO — enable it at /admin/nbfc/<id>/risk-cards"}`);
  }

  const loans = await getTenantLoanSlice(tenant.id);
  console.log(`\nLoan slice (${loans.length}):`);
  for (const l of loans) {
    const c = l.assigned_city ? cityCentroid(l.assigned_city) : null;
    console.log(
      `  ${l.loan_application_id.padEnd(40)} vno=${(l.vehicleno ?? "—").padEnd(14)} city=${(l.assigned_city ?? "—").padEnd(18)} src=${(l.assigned_city_source ?? "—").padEnd(8)} centroid=${c ? `${c.lat.toFixed(3)},${c.lng.toFixed(3)}` : "unknown"}`,
    );
  }

  const evaluator = HAND_CODED_CARDS[SLUG];
  if (!evaluator) {
    console.log("\nEvaluator not registered in HAND_CODED_CARDS — nothing to run.");
    process.exit(1);
  }
  console.log("\nRunning evaluator (needs the IoT bridge: ssh -N iot-bastion) …");
  try {
    const card = await evaluator(loans, thresholds);
    console.log(`\nseverity: ${card.severity} (${card.verdict_source})`);
    console.log(`finding : ${card.finding_summary}`);
    console.log(`counts  : ${card.affected_count} / ${card.total_count}`);
    for (const n of card.evidence.notes ?? []) console.log(`  note: ${n}`);
    for (const r of card.evidence.sample_rows ?? []) console.log(`  row : ${JSON.stringify(r)}`);
  } catch (e) {
    console.log(`\nEvaluator threw — IoT DB unreachable? ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
