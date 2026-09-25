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

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    refuseProduction();
    const gate = Number(process.argv[process.argv.indexOf("--gate") + 1] || "1");
    try {
        if (gate >= 1) await gate1();
        if (gate >= 2) await gate2();
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
