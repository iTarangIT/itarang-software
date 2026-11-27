/**
 * 27 Nov 2026 — House team logins: one login ID per person. Who already holds
 * an email on the CRM, and the message the Sales Head sees.
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  ceo: "CEO",
  business_head: "Business Head",
  sales_head: "Sales Head",
  sales_manager: "Sales Manager",
  sales_executive: "Sales Executive",
  asm: "ASM",
  isr: "Inside Sales (ISR)",
  finance_controller: "Finance Controller",
  inventory_manager: "Inventory Manager",
  service_engineer: "Service Engineer",
  sales_order_manager: "Sales Order Manager",
  nbfc_partner: "NBFC Partner",
  partner: "Partner",
  dealer: "Dealer",
};

/** Any CRM login already using this email, and its role. */
export async function existingLogin(email: string, houseCode: string): Promise<{ role: string; isHouse: boolean } | null> {
  const [row] = await db
    .select({ role: users.role, dealerId: users.dealer_id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.toLowerCase()))
    .limit(1);
  if (!row) return null;
  return { role: (row.role ?? "").toLowerCase(), isHouse: row.dealerId === houseCode };
}

export function takenMessage(email: string, t: { role: string; isHouse: boolean }): string {
  const label = t.isHouse ? "House team login" : ROLE_LABELS[t.role] ?? (t.role || "another");
  return `Change the login ID — ${email} is already on the CRM with the ${label} role.`;
}

