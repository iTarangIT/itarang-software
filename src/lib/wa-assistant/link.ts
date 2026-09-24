// Number linking (BRD §8.5, UC-12).
//
//   1. The rep, logged into the CRM, asks for a code: a 6-digit, single-use,
//      10-minute code tied to them. Only an HMAC of it is stored, as a
//      status='pending' row in assistant_wa_bindings (no separate table).
//   2. They send "LINK 482913" from their own phone. The sender's number comes
//      from Meta, never from the text.
//   3. On a match the pending row becomes the active binding; any older
//      binding for that user, and any binding another user held on that
//      number, is revoked (one number per user, one user per number).
//   4. Five wrong codes from one number within an hour lock that number for an
//      hour. Every attempt is logged on its assistant_wa_messages row.
//
// Why HMAC and not a slow hash: the code must be FOUND by its hash (a LINK
// message names no user). HMAC keyed with the app secret keeps a leaked table
// from being brute-forced offline across a 10⁶ space.
//
// Verification runs under a per-number advisory lock held for milliseconds, so
// two concurrent wrong codes cannot both read "4 failures" and slip past the
// lock-out.

import crypto from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { assistantWaBindings, assistantWaMessages } from "@/lib/db/schema";
import { isAssistantRole, type AssistantUser } from "@/lib/assistant/types";

export const CODE_TTL_MINUTES = 10;
export const MAX_FAILURES = 5;
export const LOCK_WINDOW_MS = 60 * 60 * 1000;

const LINK_RE = /^\s*LINK\s+(\d{6})\s*$/i;

/** "LINK 482913" → "482913"; anything else → null. */
export function parseLinkCommand(text: string | null | undefined): string | null {
    const m = LINK_RE.exec(text ?? "");
    return m ? m[1] : null;
}

export function generateCode(): string {
    return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashCode(code: string, secret: string): string {
    return crypto.createHmac("sha256", secret).update(`wa-assist-link:${code}`).digest("hex");
}

/**
 * When a number is locked until, given its failed attempts (any order). A
 * number is locked for an hour from the 5th failure of any burst of five
 * within one hour.
 */
export function lockedUntil(failures: Date[], now: Date): Date | null {
    const t = failures.map((d) => d.getTime()).sort((a, b) => a - b);
    let until: number | null = null;
    for (let i = MAX_FAILURES - 1; i < t.length; i++) {
        if (t[i] - t[i - (MAX_FAILURES - 1)] <= LOCK_WINDOW_MS) {
            const u = t[i] + LOCK_WINDOW_MS;
            if (until === null || u > until) until = u;
        }
    }
    return until !== null && until > now.getTime() ? new Date(until) : null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string } };
    return e?.code === "23505" || e?.cause?.code === "23505";
}

/** Issue (or replace) the user's pending code. Returns the plaintext code ONCE. */
export async function issueLinkCode(
    userId: string,
    secret: string,
): Promise<{ code: string; expiresAt: Date }> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const code = generateCode();
        try {
            const rows = await db.execute<{ code_expires_at: string }>(sql`
                INSERT INTO assistant_wa_bindings (user_id, status, code_hash, code_expires_at)
                VALUES (${userId}::uuid, 'pending', ${hashCode(code, secret)},
                        now() + make_interval(mins => ${CODE_TTL_MINUTES}))
                ON CONFLICT (user_id) WHERE status = 'pending'
                DO UPDATE SET code_hash = EXCLUDED.code_hash,
                              code_expires_at = EXCLUDED.code_expires_at,
                              updated_at = now()
                RETURNING code_expires_at
            `);
            return { code, expiresAt: new Date(rows[0]!.code_expires_at) };
        } catch (err) {
            // Another user's outstanding code has the same digits (≈ pending/10⁶).
            if (!isUniqueViolation(err) || attempt === 2) throw err;
        }
    }
    throw new Error("unreachable");
}

export type LinkOutcome =
    | { kind: "linked"; user: AssistantUser }
    | { kind: "invalid" }
    | { kind: "locked"; until: Date }
    | { kind: "ineligible" };

async function setHandling(tx: Tx, rowId: string, handling: string, userId: string | null) {
    await tx
        .update(assistantWaMessages)
        .set({ handling, handled_at: new Date(), user_id: userId })
        .where(eq(assistantWaMessages.id, rowId));
}

/**
 * Verify a LINK code sent from `waPhone`. Records the attempt on the inbound
 * message row (`messageRowId`) inside the same locked transaction.
 */
export async function verifyLinkCode(args: {
    waPhone: string;
    code: string;
    messageRowId: string;
    secret: string;
}): Promise<LinkOutcome> {
    const { waPhone, code, messageRowId, secret } = args;
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`wa-assist-link:${waPhone}`}))`);
        const [{ now }] = await tx.execute<{ now: string }>(sql`SELECT now() AS now`);
        const nowDate = new Date(now);

        const failures = await tx
            .select({ at: assistantWaMessages.created_at })
            .from(assistantWaMessages)
            .where(
                and(
                    eq(assistantWaMessages.wa_phone, waPhone),
                    eq(assistantWaMessages.handling, "link_failed"),
                    gt(assistantWaMessages.created_at, new Date(nowDate.getTime() - 2 * LOCK_WINDOW_MS)),
                ),
            );
        const until = lockedUntil(failures.map((f) => f.at), nowDate);
        if (until) {
            await setHandling(tx, messageRowId, "link_locked", null);
            return { kind: "locked", until };
        }

        const pending = await tx.execute<{
            id: string;
            user_id: string;
            name: string;
            role: string;
            is_active: boolean;
        }>(sql`
            SELECT b.id, b.user_id::text AS user_id, u.name, u.role, u.is_active
              FROM assistant_wa_bindings b
              JOIN users u ON u.id = b.user_id
             WHERE b.status = 'pending'
               AND b.code_hash = ${hashCode(code, secret)}
               AND b.code_expires_at > now()
             FOR UPDATE OF b
        `);
        const row = pending[0];
        if (!row) {
            await setHandling(tx, messageRowId, "link_failed", null);
            return { kind: "invalid" };
        }

        if (!row.is_active || !isAssistantRole(row.role)) {
            await tx
                .update(assistantWaBindings)
                .set({ status: "revoked", revoked_at: sql`now()`, revoked_reason: "ineligible", updated_at: sql`now()` })
                .where(eq(assistantWaBindings.id, row.id));
            await setHandling(tx, messageRowId, "link_ineligible", row.user_id);
            return { kind: "ineligible" };
        }

        // One number per user, one user per number: retire whatever either
        // side held before. Two statements so the reason says which.
        await tx
            .update(assistantWaBindings)
            .set({ status: "revoked", revoked_at: sql`now()`, revoked_reason: "relinked", updated_at: sql`now()` })
            .where(and(eq(assistantWaBindings.user_id, row.user_id), eq(assistantWaBindings.status, "active")));
        await tx
            .update(assistantWaBindings)
            .set({ status: "revoked", revoked_at: sql`now()`, revoked_reason: "number_relinked", updated_at: sql`now()` })
            .where(and(eq(assistantWaBindings.wa_phone, waPhone), eq(assistantWaBindings.status, "active")));

        await tx
            .update(assistantWaBindings)
            .set({
                status: "active",
                wa_phone: waPhone,
                verified_at: sql`now()`,
                code_hash: null,
                code_expires_at: null,
                updated_at: sql`now()`,
            })
            .where(eq(assistantWaBindings.id, row.id));
        await setHandling(tx, messageRowId, "link_ok", row.user_id);

        return { kind: "linked", user: { id: row.user_id, name: row.name, role: row.role } };
    });
}

/** Unlink from the CRM page: retire the active binding and any outstanding code. */
export async function revokeForUser(userId: string, reason: string): Promise<number> {
    const rows = await db
        .update(assistantWaBindings)
        .set({ status: "revoked", revoked_at: sql`now()`, revoked_reason: reason, updated_at: sql`now()` })
        .where(and(eq(assistantWaBindings.user_id, userId), inArray(assistantWaBindings.status, ["active", "pending"])))
        .returning({ id: assistantWaBindings.id });
    return rows.length;
}

export type LinkState = {
    linked: { waPhone: string; verifiedAt: string | null } | null;
    pendingExpiresAt: string | null;
};

export async function getLinkState(userId: string): Promise<LinkState> {
    const rows = await db
        .select({
            status: assistantWaBindings.status,
            wa_phone: assistantWaBindings.wa_phone,
            verified_at: assistantWaBindings.verified_at,
            code_expires_at: assistantWaBindings.code_expires_at,
        })
        .from(assistantWaBindings)
        .where(and(eq(assistantWaBindings.user_id, userId), inArray(assistantWaBindings.status, ["active", "pending"])));
    const active = rows.find((r) => r.status === "active");
    const pending = rows.find((r) => r.status === "pending" && r.code_expires_at && r.code_expires_at > new Date());
    return {
        linked: active?.wa_phone
            ? { waPhone: active.wa_phone, verifiedAt: active.verified_at?.toISOString() ?? null }
            : null,
        pendingExpiresAt: pending?.code_expires_at?.toISOString() ?? null,
    };
}
