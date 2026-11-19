/**
 * Read-only check of the E-390 dealer-assignment check (Battery Pool diagram 1).
 *
 *   node --import tsx --env-file=.env.local scripts/verify-dealer-checks.ts [staffNameFilter]
 *
 * Prints, using the real helpers (writes nothing):
 *  - iTarang staff who own dealers → their eligible dealers (eligibleDealersForStaff);
 *  - which WhatsApp operators / house team logins are linked to a sales person;
 *  - the open + recent dealer checks and, per lead, the lender-routing verdict.
 */
import { desc, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { accountOwnership, houseLoginStaffLinks, leadDealerReviews, leads, users, whatsappOperators } from "@/lib/db/schema";
import { dealerCheckKindLabel, eligibleDealersForStaff, isNbfcRoutingBlocked } from "@/lib/leads/dealer-assignment";

async function main() {
  const filter = (process.argv[2] ?? "").toLowerCase();

  const owners = await db
    .select({ id: users.id, name: users.name, role: users.role, n: sql<number>`count(*)::int` })
    .from(accountOwnership)
    .innerJoin(users, eq(users.id, accountOwnership.owner_user_id))
    .groupBy(users.id, users.name, users.role);
  console.log("Sales people who own dealers:");
  for (const o of owners) {
    if (filter && !(o.name ?? "").toLowerCase().includes(filter)) continue;
    const el = await eligibleDealersForStaff(o.id);
    console.log(`  ${o.name} [${o.role}] owns ${o.n} → eligible ${el.length}: ${el.map((d) => d.name).join(", ") || "—"}`);
  }

  const ops = await db
    .select({ name: whatsappOperators.display_name, phone: whatsappOperators.wa_phone, userId: whatsappOperators.user_id, active: whatsappOperators.is_active })
    .from(whatsappOperators);
  console.log("\nWhatsApp operators:");
  for (const o of ops) console.log(`  ${o.name} +${o.phone} ${o.active ? "active" : "off"} → sales person ${o.userId ?? "not linked"}`);

  const links = await db
    .select({ login: houseLoginStaffLinks.login_user_id, staff: houseLoginStaffLinks.staff_user_id })
    .from(houseLoginStaffLinks)
    .where(isNotNull(houseLoginStaffLinks.staff_user_id));
  console.log(`\nHouse team logins linked: ${links.length}`);

  const reviews = await db
    .select({
      id: leadDealerReviews.id,
      lead_id: leadDealerReviews.lead_id,
      dealer_id: leadDealerReviews.dealer_id,
      kind: leadDealerReviews.reason_kind,
      status: leadDealerReviews.status,
      channel: leadDealerReviews.channel,
      at: leadDealerReviews.created_at,
      assignment_status: leads.assignment_status,
    })
    .from(leadDealerReviews)
    .leftJoin(leads, eq(leads.id, leadDealerReviews.lead_id))
    .orderBy(desc(leadDealerReviews.created_at))
    .limit(20);
  console.log("\nLatest dealer checks:");
  for (const r of reviews) {
    const gate = isNbfcRoutingBlocked(r.assignment_status);
    console.log(
      `  ${r.at.toISOString().slice(0, 16)} ${r.lead_id} → ${r.dealer_id} [${r.status}] ${dealerCheckKindLabel(r.kind)} (${r.channel}) · lead ${r.assignment_status} · lender routing ${gate.blocked ? "BLOCKED" : "open"}`,
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
