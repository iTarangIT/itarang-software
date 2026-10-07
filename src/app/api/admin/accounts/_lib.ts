/**
 * Shared bits of the /api/admin/accounts/* routes (tracker P1-1 / P1-2).
 * Route files may only export HTTP handlers, so the common pieces live here.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";
import { GSTIN_RE } from "@/lib/leads/gstin";

/**
 * Who can open the Accounts tab and change owners / GSTINs.
 *
 * sales_head was added on 5 Oct 2026 when the two parallel account screens
 * were merged into this one: the duplicate "Account management" screen it
 * replaced admitted sales_head, and the sales-head dashboard sends them here
 * to assign accounts that have no owner.
 */
export const ACCOUNT_ADMIN_ROLES = ["admin", "ceo", "sales_head"];

/**
 * Roles an account can be owned by — the iTarang sales team: inside sales
 * reps and ASMs (the lead owners), plus the sales managers / executives /
 * head who also carry dealers.
 */
export const ASSIGNABLE_OWNER_ROLES = [
    "inside_sales_rep",
    "asm",
    "sales_executive",
    "sales_manager",
    "sales_head",
    "business_head",
] as const;

export class HttpError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

/** 503 with a clear message until E-321 is applied on this database. */
export async function requireAccountTables(): Promise<void> {
    if (!(await hasAccountOwnershipTables())) {
        throw new HttpError(
            "E-321 not applied: the account ownership tables do not exist on this database yet.",
            503,
        );
    }
}

/** document_type values that hold a GST certificate (web vs WhatsApp flows). */
export const GST_CERT_DOC_TYPES = ["gst_certificate", "gst"];

export const uuidSchema = z.string().uuid();
export const daySchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

/**
 * Validate that `userId` is an active user with a sales role. Throws a
 * 400 HttpError otherwise. Returns the user's name.
 */
export async function assertAssignableOwner(userId: string): Promise<string> {
    if (!uuidSchema.safeParse(userId).success) throw new HttpError("Invalid owner id", 400);
    const rows = (await db.execute(sql`
        SELECT name, lower(role) AS role, is_active
          FROM users WHERE id = ${userId}::uuid LIMIT 1
    `)) as unknown as Array<{ name: string; role: string; is_active: boolean | null }>;
    const u = rows[0];
    if (!u) throw new HttpError("Owner not found", 400);
    if (u.is_active === false) throw new HttpError(`${u.name} is inactive and cannot own accounts`, 400);
    if (!(ASSIGNABLE_OWNER_ROLES as readonly string[]).includes(u.role)) {
        throw new HttpError(`${u.name} (${u.role}) is not a sales role and cannot own accounts`, 400);
    }
    return u.name;
}

/**
 * SQL predicate: the account's GSTIN is missing — NULL, blank, the
 * 'PENDING' placeholder, or not a well-formed GSTIN. `col` is the column
 * expression (e.g. sql`a.gstin`).
 */
export function gstinMissingSql(col: ReturnType<typeof sql>) {
    return sql`(${col} IS NULL
        OR btrim(${col}) = ''
        OR upper(btrim(${col})) = 'PENDING'
        OR upper(regexp_replace(${col}, '\\s', '', 'g')) !~ ${GSTIN_RE.source})`;
}
