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

import { users, notifications } from "@/lib/db/schema";

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
    const lower = roles.map((r) => r.toLowerCase()).filter(Boolean);
    if (lower.length === 0) return;

    await db.execute(sql`
        INSERT INTO ${notifications}
            (id, user_id, type, title, message, data, lead_id, read, created_at)
        SELECT
            gen_random_uuid()::text, u.id, ${n.type}, ${n.title}, ${n.message},
            ${JSON.stringify(n.data ?? {})}::jsonb, ${n.leadId ?? null},
            false, NOW()
        FROM ${users} u
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

    await db.execute(sql`
        INSERT INTO ${notifications}
            (id, user_id, type, title, message, data, lead_id, read, created_at)
        VALUES (
            gen_random_uuid()::text, ${userId}::uuid, ${n.type}, ${n.title}, ${n.message},
            ${JSON.stringify(n.data ?? {})}::jsonb, ${n.leadId ?? null},
            false, NOW()
        )
    `);
}
