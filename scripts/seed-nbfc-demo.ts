/**
 * Seed a demo NBFC tenant + sample loan ↔ vehicleno links.
 *
 * Run:  tsx scripts/seed-nbfc-demo.ts
 *
 * Idempotent: safe to re-run. Reads existing loan_applications and assigns
 * the first 50 to the demo tenant with a synthesised vehicleno based on the
 * IoT roster. If you have a real loan↔vehicle mapping, replace the random
 * assignment with that lookup.
 */
import "dotenv/config";
import { db } from "@/lib/db";
import { nbfcTenants, nbfcLoans, loanApplications } from "@/lib/db/schema";
import { iotSql } from "@/lib/db/iot";
import { eq } from "drizzle-orm";

async function main() {
  console.log("Seeding NBFC demo tenant…");

  // 1. Tenant
  const slug = "demo-nbfc";
  const existing = await db.select().from(nbfcTenants).where(eq(nbfcTenants.slug, slug)).limit(1);
  let tenantId: string;
  if (existing[0]) {
    tenantId = existing[0].id;
    console.log(`  tenant exists: ${tenantId}`);
  } else {
    const inserted = await db
      .insert(nbfcTenants)
      .values({
        slug,
        display_name: "Demo NBFC Pvt Ltd",
        contact_email: "ops@demo-nbfc.example",
        aum_inr: "154000000",
        active_loans: 0,
      })
      .returning({ id: nbfcTenants.id });
    tenantId = inserted[0]!.id;
    console.log(`  tenant created: ${tenantId}`);
  }

  // 2. Pull some vehiclenos from IoT
  const vnoRows = await iotSql<Array<{ vehicleno: string }>>`
    SELECT vehicleno FROM vehicle_state ORDER BY vehicleno LIMIT 50
  `;
  console.log(`  IoT returned ${vnoRows.length} vehiclenos`);

  // 3. Pull some loan_applications to link
  const loans = await db.select({ id: loanApplications.id }).from(loanApplications).limit(50);
  console.log(`  CRM has ${loans.length} loan_applications`);

  if (loans.length === 0 || vnoRows.length === 0) {
    console.log("  no loans or no IoT vehicles — skipping nbfc_loans seed");
    return;
  }

  // 4. Pair them and upsert
  const pairs = loans.slice(0, Math.min(loans.length, vnoRows.length));
  for (let i = 0; i < pairs.length; i++) {
    const loan = pairs[i]!;
    const vno = vnoRows[i]!.vehicleno;
    // Random EMI 4000-9000, random DPD 0-21 (heavily skewed to 0)
    const emi = 4000 + Math.floor(Math.random() * 5000);
    const dpd = Math.random() < 0.7 ? 0 : Math.floor(Math.random() * 21);
    const out = emi * (12 + Math.floor(Math.random() * 36));
    await db
      .insert(nbfcLoans)
      .values({
        loan_application_id: loan.id,
        tenant_id: tenantId,
        vehicleno: vno,
        emi_amount: String(emi),
        emi_due_date_dom: 5,
        current_dpd: dpd,
        outstanding_amount: String(out),
        is_active: true,
      })
      .onConflictDoUpdate({
        target: nbfcLoans.loan_application_id,
        set: {
          tenant_id: tenantId,
          vehicleno: vno,
          emi_amount: String(emi),
          current_dpd: dpd,
          outstanding_amount: String(out),
          updated_at: new Date(),
        },
      });
  }
  console.log(`  linked ${pairs.length} loans to ${slug}`);

  // 5. Update active_loans count
  await db.update(nbfcTenants).set({ active_loans: pairs.length, updated_at: new Date() }).where(eq(nbfcTenants.id, tenantId));

  console.log("Done.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
