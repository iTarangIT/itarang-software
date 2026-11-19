/**
 * E-390 — active iTarang staff an iTarang House team login or a WhatsApp
 * operator number can be linked to (so the dealers that person owns in
 * Account ownership are offered when they start an application).
 */
import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

/** Roles that are never an iTarang sales person. */
const NOT_STAFF = ["dealer", "user", "scrap_vendor", "refurbisher", "customer"];

export function isStaffRole(role: string | null | undefined): boolean {
  const r = (role ?? "").toLowerCase();
  return !!r && !NOT_STAFF.includes(r) && !r.startsWith("nbfc");
}

export async function staffOptions(): Promise<Array<{ id: string; name: string; role: string | null }>> {
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.is_active, true))
    .orderBy(asc(users.name));
  return rows.filter((r) => isStaffRole(r.role)).map((r) => ({ id: r.id, name: r.name || r.email || "—", role: r.role }));
}
