// Lightweight in-app notification helper. Inserts one `notifications` row per
// active user holding any of the given roles, in a single INSERT … SELECT.
//
// BRD §0.6 — admin is notified in-app when an escalation is raised; the CEO is
// notified for Urgent escalations. Email/SMS are out of V1 scope.
//
// Best-effort by contract: callers wrap this in try/catch so a notification
// failure can never break the action that triggered it.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    blockedDashboardsFor,
    blockedRoleClause,
    filterAllowedRoles,
} from "@/lib/notifications/access";

export async function notifyRoles(
    roles: string[],
    n: {
        type: string;
        title: string;
        message: string;
        data?: unknown;
        leadId?: string | null;
    },
): Promise<void> {
    const requested = roles.map((r) => r.toLowerCase()).filter(Boolean);
    if (requested.length === 0) return;

    // E-231 — drop any dashboard that has muted this type in its bell. Narrowing
    // the role list is the whole gate here: the statement below already selects
    // by role, so nothing else has to change. Returns `requested` untouched when
    // nothing is muted, which is the common case.
    const lower = await filterAllowedRoles(requested, n.type);
    if (lower.length === 0) return;

    await db.execute(sql`
        INSERT INTO notifications
            (id, user_id, type, title, message, data, lead_id, read, created_at)
        SELECT
            gen_random_uuid()::text, u.id, ${n.type}, ${n.title}, ${n.message},
            ${JSON.stringify(n.data ?? {})}::jsonb, ${n.leadId ?? null},
            false, NOW()
        FROM users u
        WHERE LOWER(u.role) IN ${lower} AND u.is_active = TRUE
    `);
}

// Notify one specific user (by id). Same best-effort contract as notifyRoles —
// callers wrap it in try/catch so a notification failure never breaks the action.
export async function notifyUser(
    userId: string,
    n: {
        type: string;
        title: string;
        message: string;
        data?: unknown;
        leadId?: string | null;
    },
): Promise<void> {
    if (!userId) return;

    // E-231 — one indexed lookup for this user's dashboard, then the gate.
    // Deliberately NOT folded into the INSERT as an `INSERT … SELECT FROM users`:
    // that would change behaviour, because today a userId with no `users` row
    // still inserts, and a SELECT would silently write nothing instead.
    const blocked = await blockedDashboardsFor(n.type);
    if (blocked.length > 0) {
        const rows = await db.execute<{ role: string | null }>(
            sql`SELECT role FROM users WHERE id = ${userId}::uuid LIMIT 1`,
        );
        // postgres-js: execute() returns the row array itself, not { rows }.
        const role = (rows[0]?.role ?? "").trim().toLowerCase();
        if (role && blocked.includes(role)) return;
    }

    await db.execute(sql`
        INSERT INTO notifications
            (id, user_id, type, title, message, data, lead_id, read, created_at)
        VALUES (
            gen_random_uuid()::text, ${userId}::uuid, ${n.type}, ${n.title}, ${n.message},
            ${JSON.stringify(n.data ?? {})}::jsonb, ${n.leadId ?? null},
            false, NOW()
        )
    `);
}

// Notify every member of an NBFC tenant — one row per active nbfc_users seat for
// that tenant, keyed to user_id. Used to push an admin update up to the NBFC
// (Change 3/5). Same best-effort contract as notifyRoles.
export async function notifyNbfcTenant(
    tenantId: string,
    n: {
        type: string;
        title: string;
        message: string;
        data?: unknown;
        leadId?: string | null;
    },
): Promise<void> {
    if (!tenantId) return;

    // E-231 — join users so the gate reads the CRM dashboard (users.role, which
    // is 'nbfc_partner' for every seat), not nbfc_users.role. Expressed as a
    // join rather than an early `if (blocked.includes("nbfc_partner")) return`
    // so that a seat carrying some other CRM role is still governed correctly.
    const guard = blockedRoleClause(sql`u.role`, await blockedDashboardsFor(n.type));

    await db.execute(sql`
        INSERT INTO notifications
            (id, user_id, type, title, message, data, lead_id, read, created_at)
        SELECT
            gen_random_uuid()::text, nu.user_id, ${n.type}, ${n.title}, ${n.message},
            ${JSON.stringify(n.data ?? {})}::jsonb, ${n.leadId ?? null},
            false, NOW()
        FROM nbfc_users nu
        JOIN users u ON u.id = nu.user_id
        WHERE nu.tenant_id = ${tenantId}::uuid
        ${guard}
    `);
}
