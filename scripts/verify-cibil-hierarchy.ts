/**
 * Read-only check of the E-387 parent/child CIBIL approval hierarchy.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-cibil-hierarchy.ts [tenantSlugOrId]
 *
 * For one NBFC tenant (default: the first whose slug/name contains "battery"):
 * prints the switch, every member with who they report to and their delegated
 * steps, and — for up to 5 of its live Acquire leads — what each member may do
 * on that lead, using the real getHierarchyContext / decideStep. E-389: also the
 * review's conditions and the document requests raised from it (status), via
 * the real getCibilReviewView. Writes nothing.
 */
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcLeadAssignments, nbfcTenants, nbfcUsers, users } from "@/lib/db/schema";
import { HIERARCHY_STEPS, decideStep, getHierarchyContext, type GatedStep } from "@/lib/nbfc/approval-hierarchy";
import { getCibilReviewView } from "@/lib/nbfc/cibil-review";

async function main() {
  const arg = process.argv[2] ?? "battery";
  const [tenant] = await db
    .select({ id: nbfcTenants.id, slug: nbfcTenants.slug, name: nbfcTenants.display_name, enabledAt: nbfcTenants.cibil_review_enabled_at })
    .from(nbfcTenants)
    .where(/^[0-9a-f-]{36}$/i.test(arg) ? eq(nbfcTenants.id, arg) : or(ilike(nbfcTenants.slug, `%${arg}%`), ilike(nbfcTenants.display_name, `%${arg}%`)))
    .limit(1);
  if (!tenant) throw new Error(`no tenant matching ${arg}`);
  console.log(`Tenant ${tenant.name} (${tenant.slug}) — CIBIL switch: ${tenant.enabledAt ? `ON since ${tenant.enabledAt.toISOString()}` : "OFF"}`);

  const members = await db
    .select({
      user_id: nbfcUsers.user_id,
      role: nbfcUsers.role,
      parent: nbfcUsers.parent_user_id,
      steps: nbfcUsers.delegated_steps,
      name: users.name,
      email: users.email,
    })
    .from(nbfcUsers)
    .leftJoin(users, eq(users.id, nbfcUsers.user_id))
    .where(eq(nbfcUsers.tenant_id, tenant.id));
  const label = (id: string) => members.find((m) => m.user_id === id)?.name ?? id.slice(0, 8);
  for (const m of members) {
    console.log(
      `  ${m.name ?? m.email} [${m.role}]` +
        (m.parent ? ` → reports to ${label(m.parent)}; delegated: ${(m.steps ?? []).join(", ") || "none"}` : ""),
    );
  }

  const leadsRows = await db
    .select({ lead_id: nbfcLeadAssignments.lead_id, status: nbfcLeadAssignments.status })
    .from(nbfcLeadAssignments)
    .where(and(eq(nbfcLeadAssignments.tenant_id, tenant.id), isNull(nbfcLeadAssignments.deleted_at)))
    .orderBy(desc(nbfcLeadAssignments.assigned_at))
    .limit(5);
  const steps: GatedStep[] = [...HIERARCHY_STEPS.map((s) => s.key), "reject"];
  for (const l of leadsRows) {
    console.log(`\nLead ${l.lead_id} (${l.status})`);
    const view = await getCibilReviewView(tenant.id, l.lead_id);
    if (view) {
      console.log(
        `  CIBIL review: ${view.status}${view.conditions ? ` — conditions: ${view.conditions}` : ""}` +
          (view.doc_requests.length
            ? `; docs asked: ${view.doc_requests.map((d) => `[${d.items.join(", ")}] ${d.status_label}`).join(" | ")}`
            : ""),
      );
    }
    for (const m of members) {
      const ctx = await getHierarchyContext(tenant.id, m.user_id, l.lead_id);
      const allowed = steps.filter((s) => decideStep(ctx, s).ok);
      console.log(
        `  ${label(m.user_id)}: gate=${ctx.gateApplies ? "yes" : "no"} review=${ctx.review?.status ?? "none"} → can: ${allowed.join(", ") || "nothing"}`,
      );
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
