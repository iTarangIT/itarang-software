/**
 * Real-model smoke run for the WhatsApp Sales Assistant (Gate 3).
 *
 *   node --import tsx --env-file=.env.local scripts/wa-assistant-smoke.ts
 *
 * Sends the 20-question English + Hinglish set per role
 * (src/lib/assistant/__tests__/fixtures/smoke-*.json) through the REAL agent
 * turn — Gemini via LangChain, the real read tools, the real sandbox DB — as
 * fixture reps who own fixture leads with the names the questions use.
 * Writes are OFF (not on the pilot list), memory is reset per question.
 *
 * A question passes when: the first tool is one the fixture expects (or no tool
 * where that is allowed); the expected args match; no write tool is called;
 * the rendered reply fits WhatsApp's limits; and every lead id in the reply
 * came from a tool result (nothing invented).
 *
 * SANDBOX ONLY: refuses database-2 / the .env.production host / NODE_ENV=production.
 * Fixtures are deleted in `finally`. Costs ~40 short Gemini turns.
 */
import { existsSync, readFileSync } from "node:fs";
import crypto from "node:crypto";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";

import { db } from "../src/lib/db";
import { assistantConfig } from "../src/lib/assistant/config";
import { createToolCallingModel, type ToolCallingModel } from "../src/lib/assistant/agent";
import { agentTurn } from "../src/lib/assistant/turn";
import { WRITE_TOOL_NAMES, type AssistantUser } from "../src/lib/assistant/types";
import { renderTurn, RENDER_LIMITS } from "../src/lib/wa-assistant/render";

function hostOf(url: string | undefined) {
    try {
        return url ? new URL(url).hostname : "";
    } catch {
        return "";
    }
}
function refuseProduction() {
    const host = hostOf(process.env.DATABASE_URL);
    const prod = existsSync(".env.production")
        ? hostOf(/^DATABASE_URL=(.+)$/m.exec(readFileSync(".env.production", "utf8"))?.[1]?.trim())
        : "";
    if (!host || host.startsWith("database-2.") || (prod && host === prod) || process.env.NODE_ENV === "production") {
        console.error(`REFUSING to run against ${host || "(no DATABASE_URL)"} — sandbox only.`);
        process.exit(2);
    }
}

type Fixture = {
    role: AssistantUser["role"];
    questions: { q: string; expect: string[]; args?: Record<string, unknown>; allowNoTool?: boolean }[];
};

const RUN = crypto.randomBytes(3).toString("hex");
const LEAD_PREFIX = `WA-TEST-${RUN}-`;
const EMAIL_PREFIX = `wa-test+${RUN}`;
const SHOPS = ["Shree Motors", "Sharma Battery House", "Ramesh Traders", "Gupta Motors", "ABC Traders"];

async function makeUser(role: string): Promise<AssistantUser> {
    const id = crypto.randomUUID();
    await db.execute(sql`
        INSERT INTO users (id, email, name, role, is_active)
        VALUES (${id}::uuid, ${`${EMAIL_PREFIX}-${role}@itarang.test`}, ${`Smoke ${role}`}, ${role}, true)`);
    return { id, name: `Smoke ${role}`, role: role as AssistantUser["role"] };
}

async function cleanup() {
    const like = `${LEAD_PREFIX}%`;
    for (const t of ["lead_touchpoints", "lead_visits", "dealer_lead_status_history", "dealer_lead_interest_history", "dealer_lead_field_changes"]) {
        const exists = await db.execute<{ t: string | null }>(sql`SELECT to_regclass(${t})::text AS t`);
        if (exists[0]?.t) await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE dealer_lead_id LIKE ${like}`);
    }
    await db.execute(sql`DELETE FROM dealer_leads WHERE id LIKE ${like}`);
    const users = sql`(SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`;
    await db.execute(sql`DELETE FROM assistant_tool_calls WHERE user_id IN ${users}`);
    await db.execute(sql`DELETE FROM assistant_conversations WHERE user_id IN ${users}`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
}

/**
 * Wrap the real model: record every AI message, and on a free-tier 429 wait the
 * delay Gemini names ("Please retry in 12.3s") and try again. This run measures
 * tool choice, not throughput, so it paces itself to the key's quota. The wait
 * happens outside the turn's clock (no abort signal is passed through).
 */
function recording(inner: ToolCallingModel, seen: AIMessage[], stats: { waitedMs: number }): ToolCallingModel {
    return {
        invoke: async (messages: BaseMessage[]) => {
            for (let attempt = 0; ; attempt++) {
                try {
                    const ai = await inner.invoke(messages);
                    seen.push(ai);
                    return ai;
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    const m = /retry in ([\d.]+)s/.exec(msg);
                    if (!/429/.test(msg) || attempt >= 4) throw err;
                    const wait = Math.ceil((m ? Number(m[1]) : 20) * 1000) + 500;
                    stats.waitedMs += wait;
                    await new Promise((r) => setTimeout(r, wait));
                }
            }
        },
    };
}

async function main() {
    refuseProduction();
    const cfg = assistantConfig();
    if (!cfg.apiKey) {
        console.error("WA_ASSIST_GEMINI_API_KEY is not set.");
        process.exit(2);
    }
    const results: { role: string; q: string; ok: boolean; tool: string; args: string; note: string; ms: number }[] = [];
    try {
        const users: Record<string, AssistantUser> = {
            inside_sales_rep: await makeUser("inside_sales_rep"),
            asm: await makeUser("asm"),
        };
        for (const [role, u] of Object.entries(users)) {
            for (const [i, shop] of SHOPS.entries()) {
                await db.execute(sql`
                    INSERT INTO dealer_leads (id, dealer_name, shop_name, phone, current_owner_id, asm_id, lead_status, interest_level, state, city, is_active)
                    VALUES (${`${LEAD_PREFIX}${role === "asm" ? "a" : "i"}${i}`}, ${`Owner of ${shop}`}, ${shop}, NULL, ${u.id},
                            ${role === "asm" ? u.id : null}, 'Under_Discussion', 'warm', 'WA-TEST-STATE', 'Pune', true)`);
            }
        }

        for (const file of ["smoke-isr.json", "smoke-asm.json"]) {
            const fx = JSON.parse(
                readFileSync(join("src", "lib", "assistant", "__tests__", "fixtures", file), "utf8"),
            ) as Fixture;
            const user = users[fx.role];
            for (const item of fx.questions) {
                await db.execute(sql`DELETE FROM assistant_conversations WHERE user_id = ${user.id}::uuid`);
                const seen: AIMessage[] = [];
                const stats = { waitedMs: 0 };
                const t0 = Date.now();
                let ok = true;
                const notes: string[] = [];
                let first = "(none)";
                let firstArgs = "";
                try {
                    const turn = await agentTurn(user, item.q, {
                        messageId: null,
                        config: { ...cfg, writeUserIds: new Set() },
                        model: (tools) => recording(createToolCallingModel({ model: cfg.model, apiKey: cfg.apiKey!, tools }), seen, stats),
                    });
                    if (turn.kind !== "ok") throw new Error(turn.kind);
                    const calls = seen.flatMap((m) => m.tool_calls ?? []);
                    first = calls[0]?.name ?? "(none)";
                    firstArgs = calls[0] ? JSON.stringify(calls[0].args) : "";

                    if (calls.length === 0) {
                        if (!item.allowNoTool) { ok = false; notes.push("no tool called"); }
                    } else if (!item.expect.includes(first)) {
                        ok = false;
                        notes.push(`expected ${item.expect.join("|") || "no tool"}`);
                    }
                    if (item.args && calls[0]) {
                        for (const [k, v] of Object.entries(item.args)) {
                            if ((calls[0].args as Record<string, unknown>)[k] !== v) { ok = false; notes.push(`${k}≠${String(v)}`); }
                        }
                    }
                    const writes = calls.filter((c) => (WRITE_TOOL_NAMES as readonly string[]).includes(c.name));
                    if (writes.length) { ok = false; notes.push(`WRITE TOOL CALLED: ${writes.map((w) => w.name).join(",")}`); }

                    const payload = renderTurn(turn);
                    const body = payload.body;
                    const limit = payload.kind === "list" ? RENDER_LIMITS.listBody : RENDER_LIMITS.text;
                    if (!body.trim()) { ok = false; notes.push("empty reply"); }
                    if (body.length > limit) { ok = false; notes.push(`reply ${body.length} > ${limit}`); }

                    const known = JSON.stringify(turn.results);
                    for (const id of body.match(/DL-[\w-]+/g) ?? []) {
                        if (!known.includes(id)) { ok = false; notes.push(`invented id ${id}`); }
                    }
                    notes.push(`${payload.kind}${payload.kind === "list" ? `×${payload.rows.length}` : ""}: ${body.replace(/\s+/g, " ").slice(0, 70)}`);
                } catch (err) {
                    ok = false;
                    notes.push(`ERROR ${err instanceof Error ? err.message : String(err)}`);
                }
                const ms = Date.now() - t0 - stats.waitedMs;
                results.push({ role: fx.role, q: item.q, ok, tool: first, args: firstArgs, note: notes.join(" | "), ms });
                console.log(`${ok ? "PASS" : "FAIL"}  ${fx.role === "asm" ? "ASM" : "ISR"}  ${String(ms).padStart(5)} ms${stats.waitedMs ? ` (+${Math.round(stats.waitedMs / 1000)}s quota wait)` : ""}  ${item.q.slice(0, 55).padEnd(55)}  → ${first} ${firstArgs}`);
                if (!ok) console.log(`        ${notes.join(" | ")}`);
            }
        }
    } finally {
        await cleanup().catch((e) => {
            console.error("CLEANUP FAILED — remove rows with prefix", LEAD_PREFIX, EMAIL_PREFIX, e);
            process.exitCode = 1;
        });
    }
    const passed = results.filter((r) => r.ok).length;
    const ms = results.map((r) => r.ms).sort((a, b) => a - b);
    console.log(
        `\n${passed}/${results.length} passed (model ${cfg.model}, run ${RUN}). Turn latency median ${ms[Math.floor(ms.length / 2)]} ms, p90 ${ms[Math.floor(ms.length * 0.9)]} ms, max ${ms.at(-1)} ms.`,
    );
    if (passed < results.length) process.exitCode = 1;
    process.exit();
}

void main();
