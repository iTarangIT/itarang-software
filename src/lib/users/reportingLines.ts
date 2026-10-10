/**
 * Tracker ID 155 — reporting lines (users.reports_to, E-335).
 *
 * Stored and shown only: nothing decides what a person may see from these
 * lines yet (team views and scoping are the follow-up).
 *
 * users.reports_to is NOT in schema.ts (see the E-335 header), so every read
 * here goes through `to_jsonb(u) ->> 'reports_to'`, which reads NULL on a
 * database without the column instead of erroring; the write checks the
 * column first and reports "not available" there.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkReportingLine, type ReportingCheck } from "./reportingCycle";

/** Logins that are not iTarang staff never get a reporting line. */
const EXTERNAL_ROLES = ["dealer", "scrap_vendor", "refurbisher", "user"];

export type ReportingLineRow = {
    user_id: string;
    name: string | null;
    email: string;
    role: string;
    is_active: boolean;
    reports_to: string | null;
    reports_to_name: string | null;
};

const PROBE_TTL_MS = 5 * 60_000;
let present: boolean | null = null;
let probedAt = 0;

export async function hasReportsToColumn(): Promise<boolean> {
    const now = Date.now();
    if (present !== null && now - probedAt < PROBE_TTL_MS) return present;
    try {
        const res = (await db.execute(sql`
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'reports_to'
            ) AS ok
        `)) as unknown as Array<{ ok: boolean }>;
        present = Boolean(res[0]?.ok);
    } catch {
        present = false;
    }
    probedAt = now;
    return present;
}

type Exec = Pick<typeof db, "execute">;

/** Every staff login with its manager, active first, then by name. */
export async function listReportingLines(exec: Exec = db): Promise<ReportingLineRow[]> {
    const rows = await exec.execute(sql`
        SELECT u.id::text AS user_id, u.name, u.email, u.role, u.is_active,
               to_jsonb(u) ->> 'reports_to' AS reports_to,
               m.name AS reports_to_name
        FROM users u
        LEFT JOIN users m ON m.id::text = to_jsonb(u) ->> 'reports_to'
        WHERE LOWER(u.role) NOT IN (${sql.join(EXTERNAL_ROLES.map((r) => sql`${r}`), sql`, `)})
          AND LOWER(u.role) NOT LIKE 'nbfc%'
        ORDER BY u.is_active DESC, u.name ASC
    `);
    return rows as unknown as ReportingLineRow[];
}

export type SetReportingResult =
    | { ok: true }
    | { ok: false; status: 400 | 404 | 503; message: string; check?: ReportingCheck };

/**
 * Set (or clear, with null) whom `userId` reports to. Refuses self, cycles,
 * unknown users, external logins and inactive managers.
 */
export async function setReportsTo(userId: string, managerId: string | null): Promise<SetReportingResult> {
    if (!(await hasReportsToColumn())) {
        return { ok: false, status: 503, message: "Reporting lines are not available on this database yet (migration E-335)." };
    }
    // One writer at a time, so two saves cannot each pass the loop check and
    // together close a loop.
    return db.transaction(async (tx): Promise<SetReportingResult> => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"users.reports_to"}))`);
        const lines = await listReportingLines(tx);
        const byId = new Map(lines.map((l) => [l.user_id, l]));
        const user = byId.get(userId);
        if (!user) return { ok: false, status: 404, message: "User not found." };
        if (managerId != null) {
            const manager = byId.get(managerId);
            if (!manager) return { ok: false, status: 404, message: "Manager not found." };
            if (!manager.is_active) return { ok: false, status: 400, message: "Pick an active user as the manager." };
        }
        const check = checkReportingLine(userId, managerId, new Map(lines.map((l) => [l.user_id, l.reports_to])));
        if (!check.ok) {
            const names = check.chain.map((id) => byId.get(id)?.name ?? id).join(" → ");
            return {
                ok: false,
                status: 400,
                message: check.reason === "self" ? "A person cannot report to themselves." : `That would make a loop: ${names}.`,
                check,
            };
        }
        await tx.execute(sql`
            UPDATE users SET reports_to = ${managerId}::uuid, updated_at = now() WHERE id::text = ${userId}
        `);
        return { ok: true };
    });
}
