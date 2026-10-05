// The salesperson on a dealer onboarding (tracker ID 66, E-321): an active
// ISR, ASM or Sales Head, picked from a dropdown and stored as a user id. The
// same list is who may own a dealer account (ID 65).

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export const SALESPERSON_ROLES = ["inside_sales_rep", "asm", "sales_head"] as const;

export const SALESPERSON_ROLE_LABEL: Record<(typeof SALESPERSON_ROLES)[number], string> = {
    inside_sales_rep: "Inside Sales",
    asm: "ASM",
    sales_head: "Sales Head",
};

export type SalespersonOption = { id: string; name: string; role: string };
export type Salesperson = SalespersonOption & { email: string; phone: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const eligible = and(
    eq(users.is_active, true),
    inArray(sql`LOWER(${users.role})`, [...SALESPERSON_ROLES]),
);

/** Dropdown options. Name and role only — the wizard is open to the public. */
export async function listSalespeople(): Promise<SalespersonOption[]> {
    return db
        .select({ id: users.id, name: users.name, role: users.role })
        .from(users)
        .where(eligible)
        .orderBy(asc(users.name));
}

/** The picked user, or null when the id is not an active ISR / ASM / Sales Head. */
export async function resolveSalesperson(userId: string | null | undefined): Promise<Salesperson | null> {
    const id = (userId ?? "").trim();
    if (!UUID_RE.test(id)) return null;
    const [row] = await db
        .select({ id: users.id, name: users.name, role: users.role, email: users.email, phone: users.phone })
        .from(users)
        .where(and(eq(users.id, id), eligible))
        .limit(1);
    return row ?? null;
}

/** "+91 98765-43210" → "9876543210"; anything else → null. */
export function salespersonMobile(phone: string | null | undefined): string | null {
    let d = (phone ?? "").replace(/\D/g, "");
    if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
    else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    return /^[6-9]\d{9}$/.test(d) ? d : null;
}
