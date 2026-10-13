/**
 * Tracker ID 155 — reporting lines (users.reports_to, E-335; dated history,
 * E-338 user_reporting_lines).
 *
 * users.reports_to is the CURRENT manager. Since E-338 every change also
 * closes the open history row and opens a new one from the chosen start date,
 * so past numbers can stay with the manager of that time, and writes an
 * audit_logs row. Since ID 155's second part, a manager's team (direct
 * reports, ./team.ts) widens what they may read and reassign.
 *
 * users.reports_to is NOT in schema.ts (see the E-335 header), so every read
 * here goes through `to_jsonb(u) ->> 'reports_to'`, which reads NULL on a
 * database without the column instead of erroring; the write checks the
 * column first and reports "not available" there. The history table is
 * probed with to_regclass: without it the write behaves as E-335 did.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { generateId } from "@/lib/api-utils";
import { checkReportingLine, type ReportingCheck } from "./reportingCycle";
import { checkLineStart } from "./teamRules";

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
    /** E-338: first day of the current line (null without the table / no line). */
    reports_since: string | null;
};

export type ReportingHistoryRow = {
    id: string;
    manager_id: string;
    manager_name: string | null;
    effective_from: string;
    effective_to: string | null;
    changed_by_name: string | null;
    reason: string | null;
    created_at: string;
};

const PROBE_TTL_MS = 5 * 60_000;
let present: boolean | null = null;
let probedAt = 0;
let historyPresent: boolean | null = null;
let historyProbedAt = 0;

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

/** ID 155: is E-338 (user_reporting_lines) applied on this database? */
export async function hasReportingHistoryTable(): Promise<boolean> {
    const now = Date.now();
    if (historyPresent !== null && now - historyProbedAt < PROBE_TTL_MS) return historyPresent;
    try {
        const res = (await db.execute(sql`
            SELECT to_regclass('public.user_reporting_lines') IS NOT NULL AS ok
        `)) as unknown as Array<{ ok: boolean }>;
        historyPresent = Boolean(res[0]?.ok);
    } catch {
        historyPresent = false;
    }
    historyProbedAt = now;
    return historyPresent;
}

type Exec = Pick<typeof db, "execute">;

/** Every staff login with its manager, active first, then by name. */
export async function listReportingLines(exec: Exec = db): Promise<ReportingLineRow[]> {
    const withHistory = await hasReportingHistoryTable();
    const rows = await exec.execute(sql`
        SELECT u.id::text AS user_id, u.name, u.email, u.role, u.is_active,
               to_jsonb(u) ->> 'reports_to' AS reports_to,
               m.name AS reports_to_name,
               ${
                   withHistory
                       ? sql`(SELECT to_char(l.effective_from, 'YYYY-MM-DD') FROM user_reporting_lines l
                              WHERE l.user_id = u.id AND l.effective_to IS NULL LIMIT 1)`
                       : sql`NULL::text`
               } AS reports_since
        FROM users u
        LEFT JOIN users m ON m.id::text = to_jsonb(u) ->> 'reports_to'
        WHERE LOWER(u.role) NOT IN (${sql.join(EXTERNAL_ROLES.map((r) => sql`${r}`), sql`, `)})
          AND LOWER(u.role) NOT LIKE 'nbfc%'
        ORDER BY u.is_active DESC, u.name ASC
    `);
    return rows as unknown as ReportingLineRow[];
}

/** ID 155: one person's reporting history, newest first (empty without E-338). */
export async function listReportingHistory(userId: string): Promise<ReportingHistoryRow[]> {
    if (!(await hasReportingHistoryTable())) return [];
    const rows = await db.execute(sql`
        SELECT l.id::text AS id, l.manager_id::text AS manager_id, m.name AS manager_name,
               to_char(l.effective_from, 'YYYY-MM-DD') AS effective_from,
               to_char(l.effective_to, 'YYYY-MM-DD') AS effective_to,
               c.name AS changed_by_name, l.reason, l.created_at::text AS created_at
        FROM user_reporting_lines l
        LEFT JOIN users m ON m.id = l.manager_id
        LEFT JOIN users c ON c.id = l.changed_by
        WHERE l.user_id::text = ${userId}
        ORDER BY l.effective_from DESC, l.created_at DESC
        LIMIT 50
    `);
    return rows as unknown as ReportingHistoryRow[];
}

export type SetReportingResult =
    | { ok: true; unchanged?: boolean }
    | { ok: false; status: 400 | 404 | 503; message: string; check?: ReportingCheck };

export type SetReportingOptions = {
    /** Who made the change (audit + history). */
    changedBy: string;
    /** YYYY-MM-DD; default today (India). Today or earlier. */
    effectiveFrom?: string | null;
    reason?: string | null;
};

/**
 * Set (or clear, with null) whom `userId` reports to. Refuses self, cycles,
 * unknown users, external logins and inactive managers. With E-338: closes
 * the open history line on the start date and opens the new one from it.
 * Always writes one audit_logs row (action reporting_line_change).
 */
export async function setReportsTo(
    userId: string,
    managerId: string | null,
    opts: SetReportingOptions,
): Promise<SetReportingResult> {
    if (!(await hasReportsToColumn())) {
        return { ok: false, status: 503, message: "Reporting lines are not available on this database yet (migration E-335)." };
    }
    const withHistory = await hasReportingHistoryTable();
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
        if ((user.reports_to ?? null) === managerId) return { ok: true, unchanged: true };

        // "Today" from Postgres, never the Node clock (scheduler clock skew).
        const todayRows = (await tx.execute(sql`
            SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today
        `)) as unknown as Array<{ today: string }>;
        const today = todayRows[0].today;
        const start = opts.effectiveFrom || today;
        const reason = opts.reason?.trim() || null;

        let openFrom: string | null = null;
        if (withHistory) {
            const open = (await tx.execute(sql`
                SELECT id::text AS id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from
                FROM user_reporting_lines
                WHERE user_id::text = ${userId} AND effective_to IS NULL
                FOR UPDATE
            `)) as unknown as Array<{ id: string; effective_from: string }>;
            openFrom = open[0]?.effective_from ?? null;
            const startCheck = checkLineStart({ start, today, openFrom });
            if (!startCheck.ok) return { ok: false, status: 400, message: startCheck.message };
            if (open[0]) {
                await tx.execute(sql`
                    UPDATE user_reporting_lines SET effective_to = ${start}::date WHERE id::text = ${open[0].id}
                `);
            }
            if (managerId != null) {
                await tx.execute(sql`
                    INSERT INTO user_reporting_lines (user_id, manager_id, effective_from, changed_by, reason)
                    VALUES (${userId}::uuid, ${managerId}::uuid, ${start}::date, ${opts.changedBy}::uuid, ${reason})
                `);
            }
        }

        await tx.execute(sql`
            UPDATE users SET reports_to = ${managerId}::uuid, updated_at = now() WHERE id::text = ${userId}
        `);

        // ID 155: audit like other admin changes (one audit_logs row).
        await tx.insert(auditLogs).values({
            id: await generateId("AUDIT", auditLogs),
            entity_type: "user",
            entity_id: userId,
            action: "reporting_line_change",
            performed_by: opts.changedBy,
            old_data: { reports_to: user.reports_to, reports_to_name: user.reports_to_name, since: openFrom },
            new_data: {
                reports_to: managerId,
                reports_to_name: managerId ? (byId.get(managerId)?.name ?? null) : null,
                effective_from: withHistory ? start : null,
                reason,
            },
        });
        return { ok: true };
    });
}
