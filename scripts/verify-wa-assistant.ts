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

function routerDeps(replies: { to: string; text: string }[]): RouterDeps {
    return {
        verifyLink: (a) => verifyLinkCode({ ...a, secret: SECRET }),
        resolveSender,
        markHandled,
        replyText: async (to, text) => {
            replies.push({ to, text });
        },
        log: () => {},
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

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    refuseProduction();
    const gate = Number(process.argv[process.argv.indexOf("--gate") + 1] || "1");
    try {
        if (gate >= 1) await gate1();
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
