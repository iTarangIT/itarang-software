/**
 * A39 — server side of the account gate: when a password was last set
 * (E-345), and the check the dashboard layout runs on every page.
 */
import { sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { decideAccountGate, gateRedirect } from "@/lib/auth/accountGate";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

let tableKnown: boolean | null = null;
async function hasMeta(): Promise<boolean> {
    if (tableKnown !== null) return tableKnown;
    try {
        const r = rowsOf<{ ok: boolean }>(await db.execute(sql`SELECT to_regclass('public.user_password_meta') IS NOT NULL AS ok`));
        tableKnown = Boolean(r[0]?.ok);
    } catch {
        return false;
    }
    return tableKnown;
}

/** Record that a user just set their password (starts the 90-day clock). Never throws. */
export async function recordPasswordChange(userId: string, forcedBy: string | null = null): Promise<void> {
    try {
        if (!(await hasMeta())) return;
        await db.execute(sql`
            INSERT INTO user_password_meta (user_id, password_changed_at, forced_by, updated_at)
            VALUES (${userId}, now(), ${forcedBy}, now())
            ON CONFLICT (user_id) DO UPDATE SET password_changed_at = now(), forced_by = ${forcedBy}, updated_at = now()`);
    } catch (e) {
        console.warn("[passwordMeta] could not record the change:", e instanceof Error ? e.message : e);
    }
}

/** When the user last set their password; null when unknown (or no E-345). */
export async function passwordChangedAt(userId: string): Promise<Date | null> {
    try {
        if (!(await hasMeta())) return null;
        const [r] = rowsOf<{ at: string }>(
            await db.execute(sql`SELECT password_changed_at::text AS at FROM user_password_meta WHERE user_id = ${userId}`),
        );
        return r ? new Date(r.at) : null;
    } catch {
        return null;
    }
}

/**
 * Run on every dashboard page (the layout): a deactivated user is sent to the
 * login page, a forced or expired password to /change-password. Users with no
 * session or no users row are left to the page's own auth.
 */
export async function enforceAccountGate(): Promise<void> {
    let gate: ReturnType<typeof decideAccountGate> = null;
    try {
        const { createClient } = await import("@/lib/supabase/server");
        const supabase = await createClient();
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;
        const [u] = rowsOf<{ id: string; is_active: boolean | null; must_change_password: boolean | null }>(
            await db.execute(sql`
                SELECT id::text AS id, is_active, must_change_password FROM users
                 WHERE id::text = ${user.id} OR (${user.email ?? null}::text IS NOT NULL AND lower(email) = lower(${user.email ?? ""}))
                 ORDER BY (id::text = ${user.id}) DESC LIMIT 1`),
        );
        if (!u) return;
        gate = decideAccountGate({
            isActive: u.is_active,
            mustChangePassword: u.must_change_password,
            passwordChangedAt: await passwordChangedAt(u.id),
            now: new Date(),
        });
        if (gate === "inactive") await supabase.auth.signOut().catch(() => undefined);
    } catch (e) {
        // Never lock everyone out because the check itself failed.
        console.warn("[accountGate] check skipped:", e instanceof Error ? e.message : e);
        return;
    }
    if (gate) redirect(gateRedirect(gate));
}
