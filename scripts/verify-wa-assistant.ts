/**
 * Integration checks for the WhatsApp Sales Assistant (docs/wa-assistant/PLAN.md).
 *
 *   node --import tsx --env-file=.env.local scripts/verify-wa-assistant.ts --gate 1
 *
 * SANDBOX ONLY (plan D3). Runs the REAL code against DATABASE_URL, which must be
 * the sandbox (database-1). It refuses to run against production — the prod
 * host by name, the host in .env.production, or NODE_ENV=production.
 *
 * It WRITES fixture rows and deletes them in `finally`:
 *   users          email wa-test+<run>…@itarang.test
 *   dealer_leads   id WA-TEST-<run>-…, phone NULL (nothing can dial them)
 *   and every row those produce (touchpoints, visits, history, bindings, logs).
 * Checks that need E-306 report SKIP (naming the migration) until it is applied.
 * Exit code 1 if anything FAILs.
 */
import { existsSync, readFileSync } from "node:fs";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { recordVisit } from "../src/lib/asm/recordVisit";
import { fetchAsmQueueRows } from "../src/lib/asm/queryBuilder";
import { claimLead } from "../src/lib/inside-sales/claimLead";
import { issueLinkCode, verifyLinkCode, getLinkState } from "../src/lib/wa-assistant/link";
import { resolveSender } from "../src/lib/wa-assistant/identity";
import { applyStatus, insertInbound, markHandled, recordOutbound } from "../src/lib/wa-assistant/messages";
import { routeMessage, type RouterDeps } from "../src/lib/wa-assistant/router";
import { REPLY } from "../src/lib/wa-assistant/replies";
import type { InboundMessage } from "../src/lib/wa-assistant/parse";
import { withUserLease } from "../src/lib/wa-assistant/lock";
import { fetchQueueRows } from "../src/lib/inside-sales/queryBuilder";
import { QUEUE_TABS } from "../src/lib/inside-sales/types";
import { ASM_QUEUE_TABS } from "../src/lib/asm/types";
import { findLeadInScope } from "../src/lib/assistant/scope";
import { toolsFor } from "../src/lib/assistant/registry";
import { agentTurn } from "../src/lib/assistant/turn";
import { loadHistory, saveHistory } from "../src/lib/assistant/memory";
import type { ToolCallingModel } from "../src/lib/assistant/agent";
import type { AssistantUser } from "../src/lib/assistant/types";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { countQueueRows } from "../src/lib/inside-sales/queryBuilder";
import { countAsmQueueRows } from "../src/lib/asm/queryBuilder";
import { readQueueFilters } from "../src/lib/leads/queueFilters";
import { readQueueSort } from "../src/lib/leads/queueSort";
import { readAsmQueueFilters } from "../src/lib/asm/queueFilterParams";
import { buildSalesDashboard } from "../src/lib/admin/salesDashboard";
import { listTargets } from "../src/lib/targets/service";
import { numbersInputs, shapeNumbers } from "../src/lib/assistant/tools/read/myNumbers";
import { sanitizeResult } from "../src/lib/assistant/agent";
import { runToolDirect } from "../src/lib/assistant/turn";
import { writeTouchpoint } from "../src/lib/touchpoints/write";
import { renderLeadCard, renderTapOutcome } from "../src/lib/wa-assistant/render";
import { cancelAction, executeAction, sweepActions } from "../src/lib/assistant/executor";
import { createPending, hasOpenPendingAction } from "../src/lib/assistant/actions";
import { istNow } from "../src/lib/assistant/prompt";
import { renderTurn, type WaPayload } from "../src/lib/wa-assistant/render";

// ── Safety ──────────────────────────────────────────────────────────────────

function hostOf(url: string | undefined): string {
    try {
        return url ? new URL(url).hostname : "";
    } catch {
        return "";
    }
}

function refuseProduction(): void {
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

type Outcome = "PASS" | "FAIL" | "SKIP";
const results: { id: string; outcome: Outcome; note: string }[] = [];
class Skip extends Error {}
class Rollback extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}

async function check(id: string, fn: () => Promise<string | void>) {
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

async function hasColumn(table: string, column: string): Promise<boolean> {
    const r = await db.execute<{ one: number }>(sql`
        SELECT 1 AS one FROM information_schema.columns WHERE table_name = ${table} AND column_name = ${column}`);
    return r.length > 0;
}

async function hasTable(name: string): Promise<boolean> {
    const r = await db.execute<{ t: string | null }>(sql`SELECT to_regclass(${name})::text AS t`);
    return !!r[0]?.t;
}

const RUN = crypto.randomBytes(3).toString("hex");
const LEAD_PREFIX = `WA-TEST-${RUN}-`;
const EMAIL_PREFIX = `wa-test+${RUN}`;
const SECRET = "verify-wa-assistant-secret";
/** Fixture phones: a reserved-looking +91 00… range no real subscriber has. */
const phone = (n: number) => `+9100000${RUN.slice(0, 3).replace(/\D/g, "0").padEnd(3, "0")}${String(n).padStart(2, "0")}`;

async function makeUser(role: string, isActive = true): Promise<string> {
    const id = crypto.randomUUID();
    await db.execute(sql`
        INSERT INTO users (id, email, name, role, is_active)
        VALUES (${id}::uuid, ${`${EMAIL_PREFIX}-${role}-${id.slice(0, 6)}@itarang.test`},
                ${`WA Test ${role}`}, ${role}, ${isActive})
    `);
    return id;
}

async function makeLead(suffix: string, cols: { owner?: string | null; asm?: string | null; status?: string | null; state?: string }) {
    const id = `${LEAD_PREFIX}${suffix}`;
    await db.execute(sql`
        INSERT INTO dealer_leads (id, dealer_name, shop_name, phone, current_owner_id, asm_id, lead_status, state, city, is_active)
        VALUES (${id}, ${`WA Test ${suffix}`}, ${`WA Test Shop ${suffix}`}, NULL,
                ${cols.owner ?? null}, ${cols.asm ?? null}, ${cols.status ?? null},
                ${cols.state ?? "WA-TEST-STATE"}, ${"WA-TEST-CITY"}, true)
    `);
    return id;
}

async function dbDate(offsetDays: number): Promise<string> {
    const r = await db.execute<{ d: string }>(sql`SELECT (CURRENT_DATE + ${offsetDays}::int)::text AS d`);
    return r[0]!.d;
}

function inbound(over: Partial<InboundMessage>): InboundMessage {
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

function routerDeps(
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
function scriptedModel(leadId: string, delayMs = 0): ToolCallingModel {
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

async function handlingOf(providerMessageId: string) {
    const r = await db.execute<{ handling: string | null; user_id: string | null }>(sql`
        SELECT handling, user_id::text AS user_id FROM assistant_wa_messages WHERE provider_message_id = ${providerMessageId}
    `);
    return r[0];
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

async function cleanup() {
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
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
}

// ── Gate 1 ──────────────────────────────────────────────────────────────────

async function gate1() {
    const asm = await makeUser("asm");
    const isr = await makeUser("inside_sales_rep");

    await check("G1.1 next visit logged via recordVisit appears in Today's Schedule", async () => {
        const lead = await makeLead("visit", { owner: asm, asm, status: "Under_Discussion" });
        const yesterday = await dbDate(-1);
        const today = await dbDate(0);
        const r = await recordVisit({
            leadId: lead, asmId: asm, visit_status: "visited", visit_outcome: "productive",
            actual_visit_date: yesterday, visit_remarks: "verify", next_action: "next_visit", next_visit_date: today,
        });
        assert(r.visitId && r.scheduledVisitId, `expected both rows, got ${JSON.stringify(r)}`);
        const rows = await fetchAsmQueueRows({ tab: "today", asmId: asm, page: 1, limit: 100 });
        assert(rows.some((x) => x.id === lead), "lead missing from Today's Schedule");
        const again = await recordVisit({
            leadId: lead, asmId: asm, visit_status: "visited", visit_outcome: "productive",
            actual_visit_date: yesterday, visit_remarks: "verify again", next_action: "next_visit", next_visit_date: today,
        });
        assert(again.scheduledVisitId === null, "second identical next visit must not add a scheduled row");
        return `scheduled ${today}; re-log reused the open row`;
    });

    await check("G1.2 recordVisit is atomic (forced failure after the insert leaves nothing)", async () => {
        const lead = await makeLead("visit-rb", { owner: asm, asm, status: "Under_Discussion" });
        try {
            await db.transaction(async (tx) => {
                await recordVisit(
                    { leadId: lead, asmId: asm, visit_status: "visited", visit_outcome: "productive",
                      visit_remarks: "rollback", next_action: "next_visit", next_visit_date: await dbDate(3) },
                    { tx },
                );
                throw new Rollback();
            });
        } catch (e) {
            if (!(e instanceof Rollback)) throw e;
        }
        const n = await db.execute<{ v: string; t: string }>(sql`
            SELECT (SELECT count(*) FROM lead_visits WHERE dealer_lead_id = ${lead})::text AS v,
                   (SELECT count(*) FROM lead_touchpoints WHERE dealer_lead_id = ${lead})::text AS t`);
        assert(n[0]!.v === "0" && n[0]!.t === "0", `rows survived: ${JSON.stringify(n[0])}`);
    });

    await check("G1.3 an ASM claim sets owner + asm_id and one lead_claimed touchpoint", async () => {
        const lead = await makeLead("claim-asm", { owner: null, asm: null, status: null });
        const out = await claimLead(lead, asm, { actorRole: "asm" });
        assert(out.ok, JSON.stringify(out));
        const r = await db.execute<{ o: string; a: string; s: string; tp: string }>(sql`
            SELECT current_owner_id AS o, asm_id AS a, lead_status AS s,
                   (SELECT count(*) FROM lead_touchpoints WHERE dealer_lead_id = ${lead} AND touchpoint_type = 'lead_claimed')::text AS tp
              FROM dealer_leads WHERE id = ${lead}`);
        assert(r[0]!.o === asm && r[0]!.a === asm && r[0]!.s === "Assigned_Not_Contacted" && r[0]!.tp === "1", JSON.stringify(r[0]));
    });

    await check("G1.4 an ISR claim leaves asm_id untouched", async () => {
        const lead = await makeLead("claim-isr", { owner: null, asm: null, status: "New_Unassigned" });
        const out = await claimLead(lead, isr, { actorRole: "inside_sales_rep" });
        assert(out.ok, JSON.stringify(out));
        const r = await db.execute<{ a: string | null }>(sql`SELECT asm_id AS a FROM dealer_leads WHERE id = ${lead}`);
        assert(r[0]!.a === null, `asm_id=${r[0]!.a}`);
    });

    await check("G1.5 claimLead rolls back fully (owner + touchpoint) on a forced failure", async () => {
        const lead = await makeLead("claim-rb", { owner: null, asm: null, status: null });
        try {
            await db.transaction(async (tx) => {
                const out = await claimLead(lead, asm, { tx, actorRole: "asm" });
                assert(out.ok, JSON.stringify(out));
                throw new Rollback();
            });
        } catch (e) {
            if (!(e instanceof Rollback)) throw e;
        }
        const r = await db.execute<{ o: string | null; tp: string }>(sql`
            SELECT current_owner_id AS o,
                   (SELECT count(*) FROM lead_touchpoints WHERE dealer_lead_id = ${lead})::text AS tp
              FROM dealer_leads WHERE id = ${lead}`);
        assert(r[0]!.o === null && r[0]!.tp === "0", JSON.stringify(r[0]));
    });

    // ── Needs E-306 ──
    const e306 = await hasTable("assistant_wa_bindings");
    const needE305 = () => {
        if (!e306) throw new Skip("needs E-306 (drizzle/E-306_wa_assistant.sql) on this database");
    };

    await check("G1.6 dedupe: the same provider_message_id is recorded once", async () => {
        needE305();
        const m = inbound({});
        assert((await insertInbound(m)) !== null, "first insert returned null");
        assert((await insertInbound(m)) === null, "duplicate was inserted");
    });

    await check("G1.7 UC-12: LINK from the phone binds it; the reply names user + role", async () => {
        needE305();
        const { code } = await issueLinkCode(asm, SECRET);
        const replies: { to: string; text: string }[] = [];
        const m = inbound({ waPhone: phone(1), text: `LINK ${code}` });
        const rowId = await insertInbound(m);
        await routeMessage(m, rowId!, routerDeps(replies));
        assert(replies[0]?.text === "Linked: WA Test asm (ASM)", JSON.stringify(replies));
        const who = await resolveSender(phone(1));
        assert(who.kind === "ok" && who.user.id === asm, JSON.stringify(who));
        assert((await handlingOf(m.providerMessageId))?.handling === "link_ok", "handling not link_ok");
        const state = await getLinkState(asm);
        assert(state.linked?.waPhone === phone(1) && state.pendingExpiresAt === null, JSON.stringify(state));
    });

    await check("G1.8 a code is single-use; re-linking moves the binding and revokes the old one", async () => {
        needE305();
        const replies: { to: string; text: string }[] = [];
        const { code } = await issueLinkCode(asm, SECRET);
        const m1 = inbound({ waPhone: phone(2), text: `LINK ${code}` });
        await routeMessage(m1, (await insertInbound(m1))!, routerDeps(replies));
        const m2 = inbound({ waPhone: phone(3), text: `LINK ${code}` });
        await routeMessage(m2, (await insertInbound(m2))!, routerDeps(replies));
        assert(replies[1]?.text === REPLY.linkInvalid, `reused code accepted: ${JSON.stringify(replies)}`);
        assert((await resolveSender(phone(1))).kind === "unlinked", "old phone still linked");
        const now = await resolveSender(phone(2));
        assert(now.kind === "ok" && now.user.id === asm, "new phone not linked");
        const r = await db.execute<{ reason: string }>(sql`
            SELECT revoked_reason AS reason FROM assistant_wa_bindings WHERE wa_phone = ${phone(1)} AND status = 'revoked'`);
        assert(r[0]?.reason === "relinked", JSON.stringify(r));
    });

    await check("G1.9 wrong LINK code ×6: five fail, the sixth is locked; all logged", async () => {
        needE305();
        const replies: { to: string; text: string }[] = [];
        const handlings: string[] = [];
        for (let i = 0; i < 6; i++) {
            const m = inbound({ waPhone: phone(4), text: "LINK 000001" });
            await routeMessage(m, (await insertInbound(m))!, routerDeps(replies));
            handlings.push((await handlingOf(m.providerMessageId))?.handling ?? "?");
        }
        assert(
            JSON.stringify(handlings) === JSON.stringify([...Array(5).fill("link_failed"), "link_locked"]),
            handlings.join(","),
        );
        assert(replies[5]!.text.startsWith("Too many wrong codes"), replies[5]!.text);
    });

    await check("G1.10 UC-13: an unlinked number gets only the fixed reply", async () => {
        needE305();
        const replies: { to: string; text: string }[] = [];
        const m = inbound({ waPhone: phone(5), text: "Show my follow-ups" });
        await routeMessage(m, (await insertInbound(m))!, routerDeps(replies));
        assert(replies.length === 1 && replies[0]!.text === REPLY.unlinked, JSON.stringify(replies));
        assert((await handlingOf(m.providerMessageId))?.handling === "unlinked", "handling");
    });

    await check("G1.11 UC-13: another role or an inactive user → fixed reply, binding revoked", async () => {
        needE305();
        for (const [n, role, active, reason] of [[6, "admin", true, "role_changed"], [7, "asm", false, "user_inactive"]] as const) {
            const u = await makeUser(role, active);
            await db.execute(sql`
                INSERT INTO assistant_wa_bindings (user_id, wa_phone, status, verified_at)
                VALUES (${u}::uuid, ${phone(n)}, 'active', now())`);
            const replies: { to: string; text: string }[] = [];
            const m = inbound({ waPhone: phone(n), text: "Aaj ka schedule?" });
            await routeMessage(m, (await insertInbound(m))!, routerDeps(replies));
            assert(replies.length === 1 && replies[0]!.text === REPLY.unlinked, `${role}: ${JSON.stringify(replies)}`);
            const r = await db.execute<{ status: string; reason: string }>(sql`
                SELECT status, revoked_reason AS reason FROM assistant_wa_bindings WHERE user_id = ${u}::uuid`);
            assert(r[0]?.status === "revoked" && r[0]?.reason === reason, JSON.stringify(r[0]));
        }
    });

    await check("G1.12 UC-14: a linked user's voice note gets the media reply, counted by type", async () => {
        needE305();
        const replies: { to: string; text: string }[] = [];
        const m = inbound({ waPhone: phone(2), type: "audio", text: null });
        await routeMessage(m, (await insertInbound(m))!, routerDeps(replies));
        assert(replies[0]?.text === REPLY.media, JSON.stringify(replies));
        const h = await handlingOf(m.providerMessageId);
        assert(h?.handling === "media" && h.user_id === asm, JSON.stringify(h));
    });

    await check("G1.13 delivery receipts never move backwards; failed always lands", async () => {
        needE305();
        const wamid = `wamid.WA-TEST-${RUN}-out`;
        await recordOutbound({ waPhone: phone(2), userId: asm, type: "text", text: "x", wamid });
        await applyStatus(wamid, "read");
        await applyStatus(wamid, "delivered");
        let r = await db.execute<{ s: string }>(sql`SELECT delivery_status AS s FROM assistant_wa_messages WHERE provider_message_id = ${wamid}`);
        assert(r[0]?.s === "read", `after late 'delivered': ${r[0]?.s}`);
        await applyStatus(wamid, "failed");
        r = await db.execute<{ s: string }>(sql`SELECT delivery_status AS s FROM assistant_wa_messages WHERE provider_message_id = ${wamid}`);
        assert(r[0]?.s === "failed", String(r[0]?.s));
    });
}

// ── Gate 2 ──────────────────────────────────────────────────────────────────

async function gate2() {
    if (!(await hasTable("assistant_conversations"))) {
        await check("G2.* agent + guards", async () => {
            throw new Skip("needs E-306 (drizzle/E-306_wa_assistant.sql) on this database");
        });
        return;
    }
    const isr: AssistantUser = { id: await makeUser("inside_sales_rep"), name: "WA Test inside_sales_rep", role: "inside_sales_rep" };
    const isr2 = await makeUser("inside_sales_rep");
    const asm: AssistantUser = { id: await makeUser("asm"), name: "WA Test asm", role: "asm" };

    await check("G2.1 lease: two parallel turns for ONE user never overlap", async () => {
        const spans: [number, number][] = [];
        const turn = async () => {
            const s = Date.now();
            await new Promise((r) => setTimeout(r, 1500));
            spans.push([s, Date.now()]);
        };
        const [a, b] = await Promise.all([withUserLease(isr.id, turn), withUserLease(isr.id, turn)]);
        assert(a.ok && b.ok, "both should eventually run");
        spans.sort((x, y) => x[0] - y[0]);
        assert(spans[1][0] >= spans[0][1], `overlap: ${JSON.stringify(spans)}`);
        return `second started ${spans[1][0] - spans[0][1]} ms after the first ended`;
    });

    await check("G2.2 lease: a held lease → busy after the wait; an expired one is reclaimable", async () => {
        let release!: () => void;
        const held = withUserLease(isr.id, () => new Promise<void>((r) => (release = r)));
        await new Promise((r) => setTimeout(r, 400));
        const busy = await withUserLease(isr.id, async () => "x", { waitMs: 800 });
        assert(!busy.ok, "expected busy while held");
        release();
        await held;
        await db.execute(sql`UPDATE assistant_conversations SET lease_token = gen_random_uuid(), lease_until = now() - interval '1 second'
                              WHERE user_id = ${isr.id}::uuid`);
        const again = await withUserLease(isr.id, async () => "ran", { waitMs: 1000 });
        assert(again.ok && again.value === "ran", "expired lease not reclaimed");
    });

    await check("G2.3 two concurrent messages from one user through the router run in sequence", async () => {
        const lead = await makeLead("seq", { owner: isr.id, status: "Under_Discussion" });
        await db.execute(sql`INSERT INTO assistant_wa_bindings (user_id, wa_phone, status, verified_at)
                             VALUES (${isr.id}::uuid, ${phone(20)}, 'active', now())`);
        const spans: [number, number][] = [];
        const replies: { to: string; text: string }[] = [];
        const deps = routerDeps(replies, async (user, text, rowId) => {
            const r = await withUserLease(user.id, async () => {
                const s = Date.now();
                const out = await agentTurn(user, text, { messageId: rowId, model: () => scriptedModel(lead, 700) });
                spans.push([s, Date.now()]);
                return out;
            });
            if (!r.ok) return { kind: "busy" };
            return r.value.kind === "ok"
                ? { kind: "ok", payload: { kind: "text", body: r.value.text }, modelCalls: r.value.modelCalls, toolCalls: r.value.results.length }
                : { kind: "not_configured" };
        });
        const m1 = inbound({ waPhone: phone(20), text: `details of ${lead}` });
        const m2 = inbound({ waPhone: phone(20), text: "and what next?" });
        const r1 = await insertInbound(m1);
        const r2 = await insertInbound(m2);
        await Promise.all([routeMessage(m1, r1!, deps), routeMessage(m2, r2!, deps)]);
        spans.sort((x, y) => x[0] - y[0]);
        assert(spans.length === 2 && spans[1][0] >= spans[0][1], `overlap: ${JSON.stringify(spans)}`);
        assert(replies.filter((r) => r.text === "scripted reply").length === 2, JSON.stringify(replies));
        for (const m of [m1, m2]) {
            assert((await handlingOf(m.providerMessageId))?.handling === "text_agent", "handling");
        }
        const calls = await db.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM assistant_tool_calls WHERE user_id = ${isr.id}::uuid AND tool = 'get_lead_details'`);
        assert(calls[0]!.n === 2, `INV9: expected 2 logged tool calls, got ${calls[0]!.n}`);
        return `turns ${spans[0][1] - spans[0][0]} ms and ${spans[1][1] - spans[1][0]} ms, no overlap; 2 tool calls logged`;
    });

    await check("G2.4 INV1: out-of-scope and nonexistent leads are indistinguishable (real DB)", async () => {
        // Closed by ANOTHER rep: not open (so not on Team), not theirs, not unowned.
        const hidden = await makeLead("hidden", { owner: isr2, status: "Lost" });
        await db.execute(sql`UPDATE dealer_leads SET closed_at = now(), closing_owner_id = ${isr2} WHERE id = ${hidden}`);
        const visible = await makeLead("visible", { owner: isr2, status: "Under_Discussion" });
        const mine = await makeLead("mine", { owner: isr.id, status: "Under_Discussion" });

        assert((await findLeadInScope(isr, hidden)) === null, "hidden lead is visible");
        assert((await findLeadInScope(isr, `${LEAD_PREFIX}nope`)) === null, "nonexistent lead found");
        const v = await findLeadInScope(isr, visible);
        assert(v && !v.owned, "Team-tab lead should be visible and read-only");
        const m = await findLeadInScope(isr, mine);
        assert(m && m.owned, "own lead should be visible and owned");

        const details = toolsFor("inside_sales_rep", true).find((t) => t.name === "get_lead_details")!;
        const ctx = { user: isr, messageId: null, now: new Date(), writesEnabled: true };
        const a = await details.run(ctx, { lead_id: hidden });
        const b = await details.run(ctx, { lead_id: `${LEAD_PREFIX}nope` });
        assert(JSON.stringify(a) === JSON.stringify(b) && a.kind === "not_found", `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

        // ASM: an ISR-owned lead outside any territory is out of scope.
        assert((await findLeadInScope(asm, visible)) === null, "ASM sees an ISR lead outside territory");
    });

    await check("G2.5 scope ⊇ every row of every real queue tab (all 10 tabs, real reps)", async () => {
        let checked = 0;
        const reps = await db.execute<{ id: string; role: string }>(sql`
            SELECT id::text AS id, role FROM users
             WHERE is_active AND role IN ('inside_sales_rep', 'asm') AND email NOT LIKE 'wa-test+%'
             ORDER BY role, created_at LIMIT 6`);
        if (reps.length === 0) throw new Skip("no active ISR/ASM users on this database");
        for (const r of reps) {
            const user = { id: r.id, role: r.role };
            const tabs = r.role === "asm" ? ASM_QUEUE_TABS : QUEUE_TABS;
            for (const tab of tabs) {
                const rows =
                    r.role === "asm"
                        ? await fetchAsmQueueRows({ tab: tab as (typeof ASM_QUEUE_TABS)[number], asmId: r.id, page: 1, limit: 25 })
                        : await fetchQueueRows({ tab: tab as (typeof QUEUE_TABS)[number], userId: r.id, page: 1, limit: 25 });
                for (const row of rows) {
                    const hit = await findLeadInScope(user, row.id);
                    assert(hit, `${r.role} ${r.id.slice(0, 8)} tab ${tab}: ${row.id} missing from scope`);
                    checked++;
                }
            }
        }
        return `${checked} rows across ${reps.length} reps' tabs all in scope`;
    });

    await check("G2.6 memory: saved turns load back; 24 h idle resets", async () => {
        await saveHistory(asm.id, [new HumanMessage("hi"), new AIMessage("hello")]);
        const back = await loadHistory(asm.id);
        assert(back.length === 2 && back[1].content === "hello", JSON.stringify(back.map((m) => m.content)));
        const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
        assert((await loadHistory(asm.id, "whatsapp", later)).length === 0, "not reset after 24 h idle");
    });
}

// ── Gate 3 ──────────────────────────────────────────────────────────────────

/** Run a tool's body exactly as the agent does (cap + redact), without auditing real reps. */
async function runTool(user: AssistantUser, name: string, input: Record<string, unknown>) {
    const spec = toolsFor(user.role, false).find((t) => t.name === name)!;
    return sanitizeResult(await spec.run({ user, messageId: null, now: new Date(), writesEnabled: false }, spec.schema.parse(input)));
}

async function gate3() {
    if (!(await hasTable("assistant_tool_calls"))) {
        await check("G3.* read tools", async () => {
            throw new Skip("needs E-306 (drizzle/E-306_wa_assistant.sql) on this database");
        });
        return;
    }
    const reps = await db.execute<{ id: string; name: string; role: string }>(sql`
        SELECT id::text AS id, name, role FROM users
         WHERE is_active AND role IN ('inside_sales_rep', 'asm') AND email NOT LIKE 'wa-test+%'
         ORDER BY role, created_at LIMIT 6`);

    await check("G3.1 my_queue = the screen, row for row, on all 10 tabs (real reps)", async () => {
        if (reps.length === 0) throw new Skip("no active ISR/ASM users on this database");
        const empty = new URLSearchParams();
        let compared = 0;
        const roles = new Set<string>();
        for (const r of reps) {
            const user = { id: r.id, name: r.name, role: r.role } as AssistantUser;
            roles.add(r.role);
            const tabs = r.role === "asm" ? ASM_QUEUE_TABS : QUEUE_TABS;
            for (const tab of tabs) {
                // What the queue route runs for page 1 with no query params (PAGE_SIZE 25).
                let screen: { id: string }[];
                let total: number;
                if (r.role === "asm") {
                    const { filters, sort, visitStatus, visitOutcome } = readAsmQueueFilters(empty);
                    const a = { tab: tab as (typeof ASM_QUEUE_TABS)[number], asmId: r.id, q: null, filters, visitStatus, visitOutcome };
                    [screen, total] = await Promise.all([fetchAsmQueueRows({ ...a, page: 1, limit: 25, sort }), countAsmQueueRows(a)]);
                } else {
                    const a = { tab: tab as (typeof QUEUE_TABS)[number], userId: r.id, q: null, neodoveOnly: false, callbackOnly: false, filters: readQueueFilters(empty) };
                    [screen, total] = await Promise.all([fetchQueueRows({ ...a, page: 1, limit: 25, sort: readQueueSort(empty) }), countQueueRows(a)]);
                }
                const tool = await runTool(user, "my_queue", { tab });
                assert(tool.kind === "leads", `${tab}: ${tool.kind}`);
                const want = screen.slice(0, 10).map((x) => x.id);
                const got = tool.rows.map((x) => x.id);
                assert(JSON.stringify(got) === JSON.stringify(want), `${r.role} ${tab}: tool ${got.length} rows ≠ screen's first ${want.length}`);
                assert(tool.total === total, `${r.role} ${tab}: total ${tool.total} ≠ screen ${total}`);
                compared += got.length;
            }
        }
        return `${compared} rows identical and in order across ${reps.length} reps (${[...roles].join(", ")}), all 5 tabs each`;
    });

    await check("G3.2 my_numbers = buildSalesDashboard + listTargets (real reps, this and last month)", async () => {
        if (reps.length === 0) throw new Skip("no active ISR/ASM users on this database");
        for (const r of reps.slice(0, 4)) {
            const user = { id: r.id, name: r.name, role: r.role } as AssistantUser;
            for (const period of ["this_month", "last_month"] as const) {
                const now = new Date();
                const { from, to, month, dashboardInput } = numbersInputs(user, period, now);
                const [dash, targets] = await Promise.all([buildSalesDashboard(dashboardInput), listTargets({ month, userId: r.id })]);
                const tool = await runTool(user, "my_numbers", { period });
                assert(tool.kind === "numbers", tool.kind);
                const want = shapeNumbers(user, period, { from, to }, dash, targets);
                assert(JSON.stringify(tool.data) === JSON.stringify(want), `${r.role} ${period}: tool output ≠ builders`);
                const a = tool.data.activity as Record<string, number>;
                assert(a.visits === dash.totals.visits && a.calls === dash.totals.calls, "activity totals differ");
            }
        }
        return "identical for 4 reps × 2 periods";
    });

    const isr: AssistantUser = { id: await makeUser("inside_sales_rep"), name: "WA Test isr", role: "inside_sales_rep" };
    const other = await makeUser("inside_sales_rep");

    await check("G3.3 search_lead: by name and spaced phone; hidden leads never; two same names → candidates", async () => {
        const a = await makeLead("abc1", { owner: isr.id, status: "Under_Discussion" });
        const b = await makeLead("abc2", { owner: other, status: "Under_Discussion" });
        await db.execute(sql`UPDATE dealer_leads SET shop_name = ${`ABC Traders ${RUN}`} WHERE id IN (${a}, ${b})`);
        await db.execute(sql`UPDATE dealer_leads SET phone = ${`+91700000${RUN.slice(0, 2).replace(/\D/g, "0").padEnd(2, "0")}12`} WHERE id = ${a}`);
        const hidden = await makeLead("abc3", { owner: other, status: "Lost" });
        await db.execute(sql`UPDATE dealer_leads SET shop_name = ${`ABC Traders ${RUN}`}, closed_at = now(), closing_owner_id = ${other} WHERE id = ${hidden}`);

        const both = await runTool(isr, "search_lead", { query: `ABC Traders ${RUN}` });
        assert(both.kind === "candidates", `expected candidates, got ${both.kind}`);
        const ids = both.rows.map((r) => r.id).sort();
        assert(JSON.stringify(ids) === JSON.stringify([a, b].sort()), `got ${ids.join(",")} — hidden lead must not appear`);
        assert(both.rows.find((r) => r.id === b)?.owned_by_you === false, "other rep's lead must be read-only");

        const phone = (await db.execute<{ phone: string }>(sql`SELECT phone FROM dealer_leads WHERE id = ${a}`))[0]!.phone;
        const spaced = `${phone.slice(0, 3)} ${phone.slice(3, 8)} ${phone.slice(8)}`;
        const one = await runTool(isr, "search_lead", { query: spaced });
        assert(one.kind === "leads" && one.rows.length === 1 && one.rows[0].id === a, `phone search: ${JSON.stringify(one)}`);
        await db.execute(sql`UPDATE dealer_leads SET phone = NULL WHERE id = ${a}`);
    });

    await check("G3.4 get_lead_details: allowlist + redaction; a tapped row runs through the audited path", async () => {
        const lead = await makeLead("detail", { owner: isr.id, status: "Under_Discussion" });
        await writeTouchpoint({
            dealerLeadId: lead, touchpointType: "inside_sales_call", performedBy: isr.id,
            remarks: "PAN ABCDE1234F, Aadhaar 2345 6789 0123, a/c 123456789012; wants 10 units",
        });
        const r = await runTool(isr, "get_lead_details", { lead_id: lead });
        assert(r.kind === "lead", r.kind);
        const s = JSON.stringify(r);
        for (const leak of ["ABCDE1234F", "2345 6789 0123", "123456789012"]) assert(!s.includes(leak), `leaked ${leak}`);
        assert(s.includes("wants 10 units"), "remarks lost");
        for (const forbidden of ["commercials", "onboarding", "address_history", "gstin", "overall_summary"]) {
            assert(!s.includes(forbidden), `non-allowlisted field ${forbidden}`);
        }
        assert(r.lead.owned_by_you === true && typeof r.lead.crm_url === "string", "owned/crm_url");

        const direct = await runToolDirect(isr, "get_lead_details", { lead_id: lead }, { messageId: null });
        assert(direct.kind === "lead", direct.kind);
        const audited = await db.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM assistant_tool_calls WHERE user_id = ${isr.id}::uuid AND tool = 'get_lead_details' AND ok`);
        assert(audited[0]!.n === 1, `expected 1 audited call, got ${audited[0]!.n}`);
        const card = renderLeadCard(direct.lead);
        assert(card.length <= 1000 && !card.includes("ABCDE1234F"), "card");
    });

    await check("G3.5 read-tool latency (from this machine; includes network to RDS)", async () => {
        if (reps.length === 0) throw new Skip("no reps");
        const r = reps.find((x) => x.role === "inside_sales_rep") ?? reps[0];
        const user = { id: r.id, name: r.name, role: r.role } as AssistantUser;
        const timings: string[] = [];
        for (const [name, input] of [
            ["my_queue", { tab: r.role === "asm" ? "today" : "my_open" }],
            ["search_lead", { query: "traders" }],
            ["my_numbers", { period: "this_month" }],
        ] as const) {
            const t0 = Date.now();
            await runTool(user, name, input);
            timings.push(`${name} ${Date.now() - t0} ms`);
        }
        return timings.join(", ");
    });
}

// ── Gate 4 ──────────────────────────────────────────────────────────────────

type Sent = { to: string; text: string; payload?: WaPayload };

/** A model that makes these tool calls (one per turn step), then answers. */
function scriptedCalls(calls: { name: string; args: Record<string, unknown> }[]): ToolCallingModel {
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
function g4Deps(sent: Sent[], model: () => ToolCallingModel): RouterDeps {
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

async function say(deps: RouterDeps, waPhone: string, text: string) {
    const m = inbound({ waPhone, text });
    await routeMessage(m, (await insertInbound(m))!, deps);
    return m;
}

async function tap(deps: RouterDeps, waPhone: string, replyId: string) {
    const m = inbound({ waPhone, type: "interactive", replyId, text: "tap" });
    await routeMessage(m, (await insertInbound(m))!, deps);
    return m;
}

function lastActionId(sent: Sent[]): string {
    const p = [...sent].reverse().find((s) => s.payload?.kind === "buttons")?.payload;
    assert(p?.kind === "buttons", `no preview sent: ${JSON.stringify(sent.map((s) => s.text))}`);
    return p.actionId;
}

async function actionRow(id: string) {
    const r = await db.execute<{ status: string; error: string | null; after: Record<string, unknown> | null; wa_message_id: string | null }>(sql`
        SELECT status, error, after, wa_message_id FROM assistant_actions WHERE id = ${id}::uuid`);
    return r[0];
}

async function leadRow(id: string) {
    const r = await db.execute<{ lead_status: string | null; lost_reason: string | null; next_follow_up_at: string | null; ai_recall_status: string | null; touchpoints: number; calls: number }>(sql`
        SELECT lead_status, lost_reason, next_follow_up_at::text AS next_follow_up_at, ai_recall_status,
               (SELECT count(*) FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id)::int AS touchpoints,
               (SELECT count(*) FROM lead_touchpoints t WHERE t.dealer_lead_id = dl.id AND t.touchpoint_type = 'inside_sales_call')::int AS calls
          FROM dealer_leads dl WHERE id = ${id}`);
    return r[0]!;
}

async function gate4() {
    if (!(await hasTable("assistant_actions"))) {
        await check("G4.* executor", async () => {
            throw new Skip("needs E-306 (drizzle/E-306_wa_assistant.sql) on this database");
        });
        return;
    }
    const isr: AssistantUser = { id: await makeUser("inside_sales_rep"), name: "WA Test inside_sales_rep", role: "inside_sales_rep" };
    const asm: AssistantUser = { id: await makeUser("asm"), name: "WA Test asm", role: "asm" };
    const isrPhone = phone(40);
    const asmPhone = phone(41);
    for (const [u, p] of [[isr, isrPhone], [asm, asmPhone]] as const) {
        await db.execute(sql`INSERT INTO assistant_wa_bindings (user_id, wa_phone, status, verified_at) VALUES (${u.id}::uuid, ${p}, 'active', now())`);
    }
    // The pilot allow-list, for these fixture users only, in this process only.
    process.env.ASSISTANT_WRITES_ENABLED_USER_IDS = [isr.id, asm.id].join(",");

    const hasDisposition = await hasColumn("lead_touchpoints", "disposition");

    const priceHigh = (leadId: string) => [{
        name: "log_call",
        args: { lead_id: leadId, channel: "call", connect_status: "connected", disposition: "Price High", bucket: "Warm", status: "Lost", remarks: "price too high" },
    }];

    await check("G4.1 UC-02 end to end: preview → typed 'yes' writes nothing → Confirm → call + Lost(price_high) in one go", async () => {
        const lead = await makeLead("uc02", { owner: isr.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls(priceHigh(lead)));
        await say(deps, isrPhone, "Called Shree Motors, not interested, price too high.");
        const id = lastActionId(sent);
        const p = sent.at(-1)!.payload!;
        assert(p.kind === "buttons" && p.buttons[0].id === `ast:c:${id}` && p.buttons[1].id === `ast:x:${id}`, "buttons");
        assert((await leadRow(lead)).touchpoints === 0, "the preview wrote something");

        // INV2: a typed yes / pasted id does NOT confirm.
        const yes = await say(deps, isrPhone, "yes");
        assert((await handlingOf(yes.providerMessageId))?.handling === "typed_confirm", "typed yes not intercepted");
        assert(sent.at(-1)!.text.includes("tap *Confirm*"), sent.at(-1)!.text);
        await say(g4Deps(sent, () => scriptedCalls([])), isrPhone, `ast:c:${id}`);
        assert((await actionRow(id))?.status === "pending" && (await leadRow(lead)).touchpoints === 0, "typed text executed the action");

        await tap(deps, isrPhone, `ast:c:${id}`);
        assert(sent.at(-1)!.text.startsWith("✅ Saved"), sent.at(-1)!.text);
        const l = await leadRow(lead);
        assert(l.lead_status === "Lost" && l.lost_reason === "price_high", JSON.stringify(l));
        assert(l.calls === 1 && l.touchpoints === 2, `touchpoints ${JSON.stringify(l)}`);
        if (hasDisposition) {
            const d = await db.execute<{ disposition: string }>(sql`
                SELECT disposition FROM lead_touchpoints WHERE dealer_lead_id = ${lead} AND touchpoint_type = 'inside_sales_call'`);
            assert(d[0]?.disposition === "Price High", `disposition ${d[0]?.disposition}`);
        }
        const a = await actionRow(id);
        assert(a?.status === "confirmed" && a.after?.touchpoint_id, JSON.stringify(a));
        const logged = await db.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM assistant_tool_calls WHERE action_id = ${id}::uuid AND tool = 'log_call'`);
        assert(logged[0]!.n === 1, "the proposal's tool call is not linked to the action");
        return `2 touchpoints, Lost/price_high, action confirmed${a?.wa_message_id ? "" : " (no wamid — fake sender)"}`;
    });

    await check("G4.2 UC-03 end to end: not connected + follow-up tomorrow 11:00 IST", async () => {
        const lead = await makeLead("uc03", { owner: isr.id, status: "Under_Discussion" });
        const tomorrow = istNow(new Date(Date.now() + 86_400_000)).isoDate;
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{
            name: "log_call",
            args: { lead_id: lead, channel: "call", connect_status: "not_connected", disposition: "Did not pick", follow_up_at: `${tomorrow}T11:00:00+05:30` },
        }]));
        await say(deps, isrPhone, "Ramesh Traders ne phone nahi uthaya, kal 11 baje try karna");
        await tap(deps, isrPhone, `ast:c:${lastActionId(sent)}`);
        const l = await leadRow(lead);
        const want = new Date(`${tomorrow}T11:00:00+05:30`).getTime();
        assert(l.lead_status === "Under_Discussion", `status changed: ${l.lead_status}`);
        assert(l.next_follow_up_at && new Date(l.next_follow_up_at).getTime() === want, `follow-up ${l.next_follow_up_at}`);
        const cs = await db.execute<{ call_status: string }>(sql`SELECT call_status FROM lead_touchpoints WHERE dealer_lead_id = ${lead}`);
        assert(cs.length === 1 && cs[0].call_status === "not_responding", JSON.stringify(cs));
    });

    await check("G4.3 UC-07 end to end: ASM schedules a visit → lead_visits row (+ Today's Schedule when today)", async () => {
        const lead = await makeLead("uc07", { owner: asm.id, asm: asm.id, status: "Under_Discussion" });
        const today = istNow(new Date()).isoDate;
        const dbToday = await dbDate(0);
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{ name: "set_follow_up", args: { lead_id: lead, visit_date: today, note: "discuss quote" } }]));
        await say(deps, asmPhone, "Schedule Gupta Motors for today");
        await tap(deps, asmPhone, `ast:c:${lastActionId(sent)}`);
        const v = await db.execute<{ visit_status: string; scheduled_date: string }>(sql`
            SELECT visit_status, scheduled_date::text AS scheduled_date FROM lead_visits WHERE dealer_lead_id = ${lead}`);
        assert(v.length === 1 && v[0].visit_status === "scheduled" && v[0].scheduled_date === today, JSON.stringify(v));
        if (today === dbToday) {
            const rows = await fetchAsmQueueRows({ tab: "today", asmId: asm.id, page: 1, limit: 100 });
            assert(rows.some((r) => r.id === lead), "not in Today's Schedule");
            return "in Today's Schedule";
        }
        return `scheduled ${today} (DB date ${dbToday} differs from IST — Today's Schedule check skipped)`;
    });

    await check("G4.4 INV3 replay: a second Confirm on the same preview → 'Already saved', nothing written twice", async () => {
        const lead = await makeLead("replay", { owner: isr.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls(priceHigh(lead)));
        await say(deps, isrPhone, "price too high, not interested");
        const id = lastActionId(sent);
        await tap(deps, isrPhone, `ast:c:${id}`);
        await tap(deps, isrPhone, `ast:c:${id}`);
        assert(sent.at(-1)!.text === "Already saved.", sent.at(-1)!.text);
        assert((await leadRow(lead)).touchpoints === 2, "written twice");
    });

    await check("G4.5 INV3 race: two concurrent Confirm taps → exactly one execution", async () => {
        const lead = await makeLead("race", { owner: isr.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls(priceHigh(lead)));
        await say(deps, isrPhone, "price too high, not interested");
        const id = lastActionId(sent);
        const outcomes = await Promise.all(Array.from({ length: 5 }, () => executeAction(id, isr, { messageId: null })));
        const kinds = outcomes.map((o) => o.kind).sort();
        assert(kinds.filter((k) => k === "confirmed").length === 1, `outcomes ${kinds.join(",")}`);
        assert(kinds.every((k) => ["confirmed", "in_progress", "already_done"].includes(k)), kinds.join(","));
        const l = await leadRow(lead);
        assert(l.touchpoints === 2 && l.calls === 1, `executed more than once: ${JSON.stringify(l)}`);
        return `5 parallel taps → ${kinds.join(", ")}`;
    });

    await check("G4.6 INV3 expired: a tap after the 10 minutes → 'expired', nothing written", async () => {
        const lead = await makeLead("expired", { owner: isr.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls(priceHigh(lead)));
        await say(deps, isrPhone, "price too high");
        const id = lastActionId(sent);
        await db.execute(sql`UPDATE assistant_actions SET expires_at = now() - interval '1 second' WHERE id = ${id}::uuid`);
        const m = await tap(deps, isrPhone, `ast:c:${id}`);
        assert(sent.at(-1)!.text.startsWith("This action expired"), sent.at(-1)!.text);
        assert((await actionRow(id))?.status === "expired" && (await leadRow(lead)).touchpoints === 0, "expired action wrote");
        assert((await handlingOf(m.providerMessageId))?.handling === "tap_confirm", "tap not logged");
    });

    await check("G4.7 stale: the lead changed on screen between preview and tap → rejected, nothing written", async () => {
        const lead = await makeLead("stale", { owner: isr.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls(priceHigh(lead)));
        await say(deps, isrPhone, "price too high");
        const id = lastActionId(sent);
        await db.execute(sql`UPDATE dealer_leads SET updated_at = now() + interval '1 second' WHERE id = ${lead}`);
        await tap(deps, isrPhone, `ast:c:${id}`);
        assert(sent.at(-1)!.text.startsWith("This lead changed"), sent.at(-1)!.text);
        const a = await actionRow(id);
        assert(a?.status === "failed" && a.error === "rejected: stale", JSON.stringify(a));
        assert((await leadRow(lead)).touchpoints === 0, "stale action wrote");
    });

    await check("G4.8 re-validation at tap time: reassigned lead / pilot removed / revoked binding → nothing written", async () => {
        const other = await makeUser("inside_sales_rep");
        // (a) ownership moved after the preview.
        const l1 = await makeLead("reassigned", { owner: isr.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        let deps = g4Deps(sent, () => scriptedCalls(priceHigh(l1)));
        await say(deps, isrPhone, "price too high");
        const a1 = lastActionId(sent);
        await db.execute(sql`UPDATE dealer_leads SET current_owner_id = ${other} WHERE id = ${l1}`);
        await tap(deps, isrPhone, `ast:c:${a1}`);
        assert((await actionRow(a1))?.error === "rejected: not_owner", "not_owner");

        // (b) removed from the pilot list after the preview.
        const l2 = await makeLead("unpiloted", { owner: isr.id, status: "Under_Discussion" });
        deps = g4Deps(sent, () => scriptedCalls(priceHigh(l2)));
        await say(deps, isrPhone, "price too high");
        const a2 = lastActionId(sent);
        process.env.ASSISTANT_WRITES_ENABLED_USER_IDS = asm.id;
        await tap(deps, isrPhone, `ast:c:${a2}`);
        process.env.ASSISTANT_WRITES_ENABLED_USER_IDS = [isr.id, asm.id].join(",");
        assert((await actionRow(a2))?.error === "rejected: writes_disabled", "writes_disabled");

        // (c) binding revoked after the preview: the tap never reaches the executor.
        const l3 = await makeLead("revoked", { owner: isr.id, status: "Under_Discussion" });
        deps = g4Deps(sent, () => scriptedCalls(priceHigh(l3)));
        await say(deps, isrPhone, "price too high");
        const a3 = lastActionId(sent);
        await db.execute(sql`UPDATE assistant_wa_bindings SET status = 'revoked', revoked_at = now(), revoked_reason = 'unlinked_by_user' WHERE user_id = ${isr.id}::uuid AND status = 'active'`);
        await tap(deps, isrPhone, `ast:c:${a3}`);
        assert(sent.at(-1)!.text === REPLY.unlinked && (await actionRow(a3))?.status === "pending", "revoked binding executed");
        await db.execute(sql`INSERT INTO assistant_wa_bindings (user_id, wa_phone, status, verified_at) VALUES (${isr.id}::uuid, ${isrPhone}, 'active', now())`);

        for (const l of [l1, l2, l3]) assert((await leadRow(l)).touchpoints === 0, `${l} was written`);
    });

    await check("G4.9 atomic: a failure after the first write rolls the whole action back", async () => {
        const lead = await makeLead("atomic", { owner: isr.id, status: "Under_Discussion" });
        // A plan whose Lost step must fail ('other' with no notes) AFTER the call touchpoint.
        const version = (await db.execute<{ updated_at: string }>(sql`SELECT updated_at FROM dealer_leads WHERE id = ${lead}`))[0]!.updated_at;
        const { id } = await createPending({
            userId: isr.id, tool: "log_call", leadId: lead, leadVersion: new Date(version),
            plan: {
                lead_id: lead, channel: "call", touchpoint_type: "inside_sales_call",
                disposition: { connect_status: "connected", label: "Not Interested", bucket: "Lost" },
                call_duration_sec: null, remarks: null, status_to: null, lost: { reason: "other", notes: null },
                follow_up_at: null, interest: null,
            },
            preview: { title: "t", lines: [], resets_idle_clock: true, warning: null, needs_second_confirm: false, crm_url: "x" },
            before: {}, sourceMessageId: null,
        });
        const out = await executeAction(id, isr, { messageId: null });
        assert(out.kind === "error", `expected error, got ${out.kind}`);
        const a = await actionRow(id);
        assert(a?.status === "failed" && /required/.test(a.error ?? ""), JSON.stringify(a));
        assert((await leadRow(lead)).touchpoints === 0, "the call touchpoint survived the rollback");
    });

    await check("G4.10 high-impact Lost via log_call: first Confirm writes nothing and asks again; only the second saves", async () => {
        const lead = await makeLead("hi", { owner: isr.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{
            name: "log_call",
            args: { lead_id: lead, channel: "call", connect_status: "connected", disposition: "Business Closed", bucket: "Lost", status: "Lost" },
        }]));
        await say(deps, isrPhone, "dukaan band ho gayi");
        const step1 = lastActionId(sent);
        await tap(deps, isrPhone, `ast:c:${step1}`);
        const step2 = lastActionId(sent);
        assert(step2 !== step1, "no second confirmation");
        assert(/Tap Confirm again/.test(sent.at(-1)!.text), sent.at(-1)!.text);
        assert((await leadRow(lead)).touchpoints === 0 && (await actionRow(step1))?.status === "escalated", "step 1 wrote");
        await tap(deps, isrPhone, `ast:c:${step1}`); // double tap on step 1 is NOT the second confirm
        assert((await leadRow(lead)).touchpoints === 0, "a repeated step-1 tap wrote");
        await tap(deps, isrPhone, `ast:c:${step2}`);
        const l = await leadRow(lead);
        assert(l.lead_status === "Lost" && l.lost_reason === "business_closed" && l.ai_recall_status === "excluded", JSON.stringify(l));
    });

    await check("G4.11 Cancel: nothing written; a later Confirm on it is refused", async () => {
        const lead = await makeLead("cancel", { owner: isr.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls(priceHigh(lead)));
        await say(deps, isrPhone, "price too high");
        const id = lastActionId(sent);
        await tap(deps, isrPhone, `ast:x:${id}`);
        assert(sent.at(-1)!.text === "Cancelled. Nothing was saved.", sent.at(-1)!.text);
        await tap(deps, isrPhone, `ast:c:${id}`);
        assert(sent.at(-1)!.text === "That was cancelled. Nothing was saved.", sent.at(-1)!.text);
        assert((await leadRow(lead)).touchpoints === 0, "cancelled action wrote");
    });

    await check("G4.12 another user's action id is answered like a missing one and never runs", async () => {
        const lead = await makeLead("foreign", { owner: isr.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        await say(g4Deps(sent, () => scriptedCalls(priceHigh(lead))), isrPhone, "price too high");
        const id = lastActionId(sent);
        const out = await executeAction(id, asm, { messageId: null });
        assert(out.kind === "not_found", out.kind);
        assert((await actionRow(id))?.status === "pending" && (await leadRow(lead)).touchpoints === 0, "foreign tap ran");
    });

    await check("G4.13 sweep: expires old previews, fails actions stuck in executing", async () => {
        const lead = await makeLead("sweep", { owner: isr.id, status: "Under_Discussion" });
        const mk = async () =>
            (await createPending({
                userId: isr.id, tool: "log_call", leadId: lead, leadVersion: null, plan: {},
                preview: { title: "t", lines: [], resets_idle_clock: false, warning: null, needs_second_confirm: false, crm_url: "x" },
                before: {}, sourceMessageId: null,
            })).id;
        const old = await mk();
        const stuck = await mk();
        await db.execute(sql`UPDATE assistant_actions SET expires_at = now() - interval '1 minute' WHERE id = ${old}::uuid`);
        await db.execute(sql`UPDATE assistant_actions SET status = 'executing', updated_at = now() - interval '6 minutes' WHERE id = ${stuck}::uuid`);
        await sweepActions();
        assert((await actionRow(old))?.status === "expired", "not expired");
        assert((await actionRow(stuck))?.status === "failed", "stuck not failed");
    });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    refuseProduction();
    const gate = Number(process.argv[process.argv.indexOf("--gate") + 1] || "1");
    try {
        if (gate >= 1) await gate1();
        if (gate >= 2) await gate2();
        if (gate >= 3) await gate3();
        if (gate >= 4) await gate4();
    } finally {
        await cleanup().catch((e) => {
            console.error("CLEANUP FAILED — remove rows with prefix", LEAD_PREFIX, EMAIL_PREFIX, e);
            process.exitCode = 1;
        });
    }
    const width = Math.max(...results.map((r) => r.id.length));
    for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.id.padEnd(width)}  ${r.note}`);
    const failed = results.filter((r) => r.outcome === "FAIL").length;
    console.log(`\n${results.length} checks: ${results.length - failed - results.filter((r) => r.outcome === "SKIP").length} pass, ${failed} fail, ${results.filter((r) => r.outcome === "SKIP").length} skip (run ${RUN})`);
    if (failed) process.exitCode = 1;
    process.exit();
}

void main();
