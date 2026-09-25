/**
 * Shared harness + fixtures for the WhatsApp Assistant sandbox scripts
 * (verify-wa-assistant.ts, verify-wa-assistant-attacks.ts).
 *
 * SANDBOX ONLY (plan D3): refuseProduction() must run first. Fixtures are
 * prefixed with a per-run id and removed by cleanup():
 *   users          email wa-test+<run>…@itarang.test
 *   dealer_leads   id WA-TEST-<run>-…, phone NULL (nothing can dial them)
 *   and every row those produce (touchpoints, visits, history, bindings, logs,
 *   asm_territories of fixture ASMs).
 */
import { existsSync, readFileSync } from "node:fs";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { AIMessage } from "@langchain/core/messages";

import { db } from "../src/lib/db";
import { verifyLinkCode } from "../src/lib/wa-assistant/link";
import { resolveSender } from "../src/lib/wa-assistant/identity";
import { insertInbound, markHandled } from "../src/lib/wa-assistant/messages";
import { routeMessage, type RouterDeps } from "../src/lib/wa-assistant/router";
import type { InboundMessage } from "../src/lib/wa-assistant/parse";
import { withUserLease } from "../src/lib/wa-assistant/lock";
import { agentTurn } from "../src/lib/assistant/turn";
import type { ToolCallingModel } from "../src/lib/assistant/agent";
import { renderTapOutcome, renderTurn, type WaPayload } from "../src/lib/wa-assistant/render";
import { cancelAction, executeAction } from "../src/lib/assistant/executor";
import { hasOpenPendingAction } from "../src/lib/assistant/actions";


// ── Safety ──────────────────────────────────────────────────────────────────

export function hostOf(url: string | undefined): string {
    try {
        return url ? new URL(url).hostname : "";
    } catch {
        return "";
    }
}

export function refuseProduction(): void {
    const host = hostOf(process.env.DATABASE_URL);
    let prodHost = "";
    if (existsSync(".env.production")) {
        const m = /^DATABASE_URL=(.+)$/m.exec(readFileSync(".env.production", "utf8"));
        prodHost = hostOf(m?.[1]?.trim());
    }
    const reasons = [
        !host && "DATABASE_URL is not set",
        host.startsWith("database-2.") && "DATABASE_URL is database-2 (production)",
        prodHost && host === prodHost && "DATABASE_URL matches .env.production",
        process.env.NODE_ENV === "production" && "NODE_ENV=production",
    ].filter(Boolean);
    if (reasons.length) {
        console.error(`REFUSING to run: ${reasons.join("; ")}. This script writes fixtures — sandbox only.`);
        process.exit(2);
    }
    console.log(`DB host: ${host}`);
}

// ── Harness ─────────────────────────────────────────────────────────────────

export type Outcome = "PASS" | "FAIL" | "SKIP";
export const results: { id: string; outcome: Outcome; note: string }[] = [];
export class Skip extends Error {}
export class Rollback extends Error {}

export function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}

export async function check(id: string, fn: () => Promise<string | void>) {
    const t = Date.now();
    try {
        const note = (await fn()) ?? "";
        results.push({ id, outcome: "PASS", note: `${note} (${Date.now() - t} ms)` });
    } catch (e) {
        const err = e as Error & { cause?: { message?: string } };
        if (e instanceof Skip) results.push({ id, outcome: "SKIP", note: err.message });
        else results.push({ id, outcome: "FAIL", note: err.cause?.message ?? err.message });
    }
}

export async function hasColumn(table: string, column: string): Promise<boolean> {
    const r = await db.execute<{ one: number }>(sql`
        SELECT 1 AS one FROM information_schema.columns WHERE table_name = ${table} AND column_name = ${column}`);
    return r.length > 0;
}

export async function hasTable(name: string): Promise<boolean> {
    const r = await db.execute<{ t: string | null }>(sql`SELECT to_regclass(${name})::text AS t`);
    return !!r[0]?.t;
}

export const RUN = crypto.randomBytes(3).toString("hex");
export const LEAD_PREFIX = `WA-TEST-${RUN}-`;
export const EMAIL_PREFIX = `wa-test+${RUN}`;
export const SECRET = "verify-wa-assistant-secret";
/** Fixture phones: a reserved-looking +91 00… range no real subscriber has. */
export const phone = (n: number) => `+9100000${RUN.slice(0, 3).replace(/\D/g, "0").padEnd(3, "0")}${String(n).padStart(2, "0")}`;

export async function makeUser(role: string, isActive = true): Promise<string> {
    const id = crypto.randomUUID();
    await db.execute(sql`
        INSERT INTO users (id, email, name, role, is_active)
        VALUES (${id}::uuid, ${`${EMAIL_PREFIX}-${role}-${id.slice(0, 6)}@itarang.test`},
                ${`WA Test ${role}`}, ${role}, ${isActive})
    `);
    return id;
}

export async function makeLead(suffix: string, cols: { owner?: string | null; asm?: string | null; status?: string | null; state?: string }) {
    const id = `${LEAD_PREFIX}${suffix}`;
    await db.execute(sql`
        INSERT INTO dealer_leads (id, dealer_name, shop_name, phone, current_owner_id, asm_id, lead_status, state, city, is_active)
        VALUES (${id}, ${`WA Test ${suffix}`}, ${`WA Test Shop ${suffix}`}, NULL,
                ${cols.owner ?? null}, ${cols.asm ?? null}, ${cols.status ?? null},
                ${cols.state ?? "WA-TEST-STATE"}, ${"WA-TEST-CITY"}, true)
    `);
    return id;
}

export async function dbDate(offsetDays: number): Promise<string> {
    const r = await db.execute<{ d: string }>(sql`SELECT (CURRENT_DATE + ${offsetDays}::int)::text AS d`);
    return r[0]!.d;
}

export function inbound(over: Partial<InboundMessage>): InboundMessage {
    return {
        kind: "message",
        phoneNumberId: "verify",
        providerMessageId: `wamid.WA-TEST-${RUN}-${crypto.randomUUID()}`,
        waPhone: phone(99),
        type: "text",
        text: "hello",
        replyId: null,
        raw: { fixture: true },
        ...over,
    };
}

export function routerDeps(
    replies: { to: string; text: string }[],
    runTextTurn: RouterDeps["runTextTurn"] = async () => ({ kind: "not_configured" }),
): RouterDeps {
    return {
        verifyLink: (a) => verifyLinkCode({ ...a, secret: SECRET }),
        resolveSender,
        markHandled,
        replyText: async (to, text) => {
            replies.push({ to, text });
        },
        sendPayload: async (to, payload) => {
            replies.push({ to, text: payload.body });
        },
        openLead: async () => ({ kind: "text", body: "lead card" }),
        confirmAction: async (user, actionId, rowId) =>
            renderTapOutcome(await executeAction(actionId, user, { messageId: rowId })),
        cancelAction: async (user, actionId) => renderTapOutcome(await cancelAction(actionId, user)),
        isDisabled: () => false,
        hasPendingAction: async () => false,
        runTextTurn,
        log: () => {},
    };
}

/** A model that calls get_lead_details once, then answers — slowly, to widen races. */
export function scriptedModel(leadId: string, delayMs = 0): ToolCallingModel {
    let n = 0;
    return {
        invoke: async () => {
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            return n++ === 0
                ? new AIMessage({ content: "", tool_calls: [{ id: `c${n}`, name: "get_lead_details", args: { lead_id: leadId } }] })
                : new AIMessage("scripted reply");
        },
    };
}

export async function handlingOf(providerMessageId: string) {
    const r = await db.execute<{ handling: string | null; user_id: string | null }>(sql`
        SELECT handling, user_id::text AS user_id FROM assistant_wa_messages WHERE provider_message_id = ${providerMessageId}
    `);
    return r[0];
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

export async function cleanup() {
    const like = `${LEAD_PREFIX}%`;
    for (const table of [
        "lead_touchpoints",
        "dealer_lead_status_history",
        "interest_level_overrides",
        "lead_visits",
        "dealer_lead_interest_history",
        "dealer_lead_field_changes",
    ]) {
        if (await hasTable(table)) {
            await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE dealer_lead_id LIKE ${like}`);
        }
    }
    await db.execute(sql`DELETE FROM dealer_leads WHERE id LIKE ${like}`);
    if (await hasTable("assistant_wa_bindings")) {
        await db.execute(sql`DELETE FROM assistant_wa_messages WHERE provider_message_id LIKE ${`wamid.WA-TEST-${RUN}-%`}
                              OR user_id IN (SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
        await db.execute(sql`DELETE FROM assistant_wa_bindings WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
    }
    if (await hasTable("assistant_conversations")) {
        await db.execute(sql`DELETE FROM assistant_tool_calls WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
        await db.execute(sql`UPDATE assistant_actions SET parent_action_id = NULL WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
        await db.execute(sql`DELETE FROM assistant_actions WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
        await db.execute(sql`DELETE FROM assistant_conversations WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
    }
    await db.execute(sql`DELETE FROM asm_territories WHERE asm_id IN (SELECT id::text FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
}

// ── Router-driven helpers (real router → lease → agent → executor) ─────────

export type Sent = { to: string; text: string; payload?: WaPayload };

/** A model that makes these tool calls (one per turn step), then answers. */
export function scriptedCalls(calls: { name: string; args: Record<string, unknown> }[]): ToolCallingModel {
    let n = 0;
    return {
        invoke: async () => {
            const c = calls[n++];
            return c
                ? new AIMessage({ content: "", tool_calls: [{ id: `c${n}`, name: c.name, args: c.args }] })
                : new AIMessage("Tap Confirm to save.");
        },
    };
}

/** Router deps with the REAL executor and a scripted agent model. */
export function g4Deps(sent: Sent[], model: () => ToolCallingModel): RouterDeps {
    return {
        ...routerDeps([]),
        replyText: async (to, text) => {
            sent.push({ to, text });
        },
        sendPayload: async (to, payload) => {
            sent.push({ to, text: payload.body, payload });
        },
        hasPendingAction: hasOpenPendingAction,
        runTextTurn: async (user, text, rowId) => {
            const r = await withUserLease(user.id, () => agentTurn(user, text, { messageId: rowId, model: () => model() }));
            if (!r.ok) return { kind: "busy" };
            return r.value.kind === "ok"
                ? { kind: "ok", payload: renderTurn(r.value), modelCalls: r.value.modelCalls, toolCalls: r.value.results.length }
                : { kind: "not_configured" };
        },
    };
}

export async function say(deps: RouterDeps, waPhone: string, text: string) {
    const m = inbound({ waPhone, text });
    await routeMessage(m, (await insertInbound(m))!, deps);
    return m;
}

export async function tap(deps: RouterDeps, waPhone: string, replyId: string) {
    const m = inbound({ waPhone, type: "interactive", replyId, text: "tap" });
    await routeMessage(m, (await insertInbound(m))!, deps);
    return m;
}

export function lastActionId(sent: Sent[]): string {
    const p = [...sent].reverse().find((s) => s.payload?.kind === "buttons")?.payload;
    assert(p?.kind === "buttons", `no preview sent: ${JSON.stringify(sent.map((s) => s.text))}`);
    return p.actionId;
}

export async function actionRow(id: string) {
    const r = await db.execute<{ status: string; error: string | null; after: Record<string, unknown> | null; wa_message_id: string | null }>(sql`
        SELECT status, error, after, wa_message_id FROM assistant_actions WHERE id = ${id}::uuid`);
    return r[0];
}

export async function leadRow(id: string) {
    const r = await db.execute<{ lead_status: string | null; lost_reason: string | null; next_follow_up_at: string | null; ai_recall_status: string | null; touchpoints: number; calls: number }>(sql`
        SELECT lead_status, lost_reason, next_follow_up_at::text AS next_follow_up_at, ai_recall_status,
               (SELECT count(*) FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id)::int AS touchpoints,
               (SELECT count(*) FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type = 'inside_sales_call')::int AS calls
          FROM dealer_leads dl WHERE id = ${id}`);
    return r[0]!;
}

export async function counts(leadId: string) {
    const r = await db.execute<{ visits: number; scheduled: number; touchpoints: number; overrides: number; history: number }>(sql`
        SELECT (SELECT count(*) FROM lead_visits WHERE dealer_lead_id = ${leadId})::int AS visits,
               (SELECT count(*) FROM lead_visits WHERE dealer_lead_id = ${leadId} AND visit_status = 'scheduled')::int AS scheduled,
               (SELECT count(*) FROM lead_touchpoints WHERE dealer_lead_id = ${leadId})::int AS touchpoints,
               (SELECT count(*) FROM interest_level_overrides WHERE dealer_lead_id = ${leadId})::int AS overrides,
               (SELECT count(*) FROM dealer_lead_status_history WHERE dealer_lead_id = ${leadId})::int AS history`);
    return r[0]!;
}

export async function actionsFor(leadId: string) {
    const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM assistant_actions WHERE lead_id = ${leadId}`);
    return r[0]!.n;
}

// ── Runner ──────────────────────────────────────────────────────────────────

/** Run the suites, always clean up, print the table, set the exit code. */
export async function runSuites(suites: (() => Promise<void>)[]): Promise<void> {
    refuseProduction();
    try {
        for (const s of suites) await s();
    } finally {
        await cleanup().catch((e) => {
            console.error("CLEANUP FAILED — remove rows with prefix", LEAD_PREFIX, EMAIL_PREFIX, e);
            process.exitCode = 1;
        });
    }
    const width = Math.max(...results.map((r) => r.id.length));
    for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.id.padEnd(width)}  ${r.note}`);
    const failed = results.filter((r) => r.outcome === "FAIL").length;
    const skipped = results.filter((r) => r.outcome === "SKIP").length;
    console.log(`
${results.length} checks: ${results.length - failed - skipped} pass, ${failed} fail, ${skipped} skip (run ${RUN})`);
    if (failed) process.exitCode = 1;
    process.exit();
}
