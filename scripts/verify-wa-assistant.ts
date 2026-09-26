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
 * Checks that need E-309 report SKIP (naming the migration) until it is applied.
 * Exit code 1 if anything FAILs.
 */
import { sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import {
    assert, check, hasColumn, hasTable, Skip, Rollback, RUN, LEAD_PREFIX, SECRET, phone, makeUser, makeLead, dbDate,
    inbound, routerDeps, scriptedModel, handlingOf, type Sent, scriptedCalls, g4Deps, say, tap, lastActionId,
    actionRow, leadRow, counts, actionsFor, runSuites,
} from "./wa-assistant-fixtures";
import { recordVisit } from "../src/lib/asm/recordVisit";
import { fetchAsmQueueRows } from "../src/lib/asm/queryBuilder";
import { claimLead } from "../src/lib/inside-sales/claimLead";
import { issueLinkCode, getLinkState } from "../src/lib/wa-assistant/link";
import { resolveSender } from "../src/lib/wa-assistant/identity";
import { applyStatus, insertInbound, recordOutbound } from "../src/lib/wa-assistant/messages";
import { routeMessage } from "../src/lib/wa-assistant/router";
import { REPLY } from "../src/lib/wa-assistant/replies";
import { withUserLease } from "../src/lib/wa-assistant/lock";
import { fetchQueueRows } from "../src/lib/inside-sales/queryBuilder";
import { QUEUE_TABS } from "../src/lib/inside-sales/types";
import { ASM_QUEUE_TABS } from "../src/lib/asm/types";
import { findLeadInScope } from "../src/lib/assistant/scope";
import { toolsFor } from "../src/lib/assistant/registry";
import { agentTurn } from "../src/lib/assistant/turn";
import { loadHistory, saveHistory, toolsetStamp } from "../src/lib/assistant/memory";
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
import { renderLeadCard } from "../src/lib/wa-assistant/render";
import { executeAction, sweepActions } from "../src/lib/assistant/executor";
import { createPending } from "../src/lib/assistant/actions";
import { istNow } from "../src/lib/assistant/prompt";

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

    // ── Needs E-309 ──
    const e309 = await hasTable("assistant_wa_bindings");
    const needE305 = () => {
        if (!e309) throw new Skip("needs E-309 (drizzle/E-309_wa_assistant.sql) on this database");
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
            throw new Skip("needs E-309 (drizzle/E-309_wa_assistant.sql) on this database");
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

    await check("G2.6 memory: saved turns load back; 24 h idle resets; a changed tool set resets", async () => {
        const reads = toolsetStamp(toolsFor("asm", false).map((t) => t.name));
        const writes = toolsetStamp(toolsFor("asm", true).map((t) => t.name));
        await saveHistory(asm.id, reads, [new HumanMessage("hi"), new AIMessage("hello")]);
        const back = await loadHistory(asm.id, reads);
        assert(back.length === 2 && back[1].content === "hello", JSON.stringify(back.map((m) => m.content)));
        const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
        assert((await loadHistory(asm.id, reads, "whatsapp", later)).length === 0, "not reset after 24 h idle");
        // Joined the write pilot (or a deploy added a tool): the old history must not replay.
        assert((await loadHistory(asm.id, writes)).length === 0, "history replayed after the tool set changed");
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
            throw new Skip("needs E-309 (drizzle/E-309_wa_assistant.sql) on this database");
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

async function gate4() {
    if (!(await hasTable("assistant_actions"))) {
        await check("G4.* executor", async () => {
            throw new Skip("needs E-309 (drizzle/E-309_wa_assistant.sql) on this database");
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
        assert(
            p.kind === "buttons" &&
                p.buttons.map((b) => b.id).join(" ") === `ast:c:${id} ast:e:${id} ast:x:${id}`,
            "buttons",
        );
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
        // One live card per user: a new card supersedes older PENDING ones, so
        // make the stuck one executing before the second card is created.
        const stuck = await mk();
        await db.execute(sql`UPDATE assistant_actions SET status = 'executing', updated_at = now() - interval '6 minutes' WHERE id = ${stuck}::uuid`);
        const old = await mk();
        await db.execute(sql`UPDATE assistant_actions SET expires_at = now() - interval '1 minute' WHERE id = ${old}::uuid`);
        await sweepActions();
        assert((await actionRow(old))?.status === "expired", "not expired");
        assert((await actionRow(stuck))?.status === "failed", "stuck not failed");
    });
}

// ── Gate 5 ──────────────────────────────────────────────────────────────────

async function gate5() {
    if (!(await hasTable("assistant_actions"))) {
        await check("G5.* field writes", async () => {
            throw new Skip("needs E-309 (drizzle/E-309_wa_assistant.sql) on this database");
        });
        return;
    }
    const isr: AssistantUser = { id: await makeUser("inside_sales_rep"), name: "WA Test inside_sales_rep", role: "inside_sales_rep" };
    const asm: AssistantUser = { id: await makeUser("asm"), name: "WA Test asm", role: "asm" };
    const isrPhone = phone(50);
    const asmPhone = phone(51);
    for (const [u, p] of [[isr, isrPhone], [asm, asmPhone]] as const) {
        await db.execute(sql`INSERT INTO assistant_wa_bindings (user_id, wa_phone, status, verified_at) VALUES (${u.id}::uuid, ${p}, 'active', now())`);
    }
    process.env.ASSISTANT_WRITES_ENABLED_USER_IDS = [isr.id, asm.id].join(",");
    // A territory of the fixture ASM's own, so no real lead is ever in its pool.
    const myState = `WA-T5-${RUN}`;
    await db.execute(sql`INSERT INTO asm_territories (asm_id, state) VALUES (${asm.id}, ${myState})`);

    const today = istNow(new Date()).isoDate;
    const yesterday = istNow(new Date(Date.now() - 86_400_000)).isoDate;
    const dbToday = await dbDate(0);

    await check("G5.1 UC-01 end to end: one preview → Confirm → visit + touchpoint + interest + next visit, in Today's Schedule", async () => {
        const lead = await makeLead("uc01", { owner: asm.id, asm: asm.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        // Visited yesterday, next visit today: the only way to see "Friday appears in
        // Today's Schedule" without waiting for Friday (the same trick as G1.1).
        const deps = g4Deps(sent, () => scriptedCalls([{
            name: "log_visit",
            args: {
                lead_id: lead, visit_status: "visited", outcome: "productive", visit_date: yesterday, interest: "hot",
                remarks: "owner Ramesh, needs 10 batteries at X", next_action: "next_visit", next_visit_date: today,
            },
        }]));
        await say(deps, asmPhone, "Met ABC Traders yesterday, owner Ramesh. Needs 10 batteries at X each. Aaj phir jaana hai.");
        const id = lastActionId(sent);
        const body = sent.at(-1)!.text;
        assert(/^\*Log visit — /.test(body) && /Visit: visited · productive/.test(body) && /Temperature: none → hot/.test(body) &&
               /Next visit: .*\(goes to Today's Schedule\)/.test(body) && /Resets idle clock: yes/.test(body), body);
        const before = await counts(lead);
        assert(before.visits === 0 && before.touchpoints === 0 && before.overrides === 0, `the preview wrote: ${JSON.stringify(before)}`);

        await tap(deps, asmPhone, `ast:c:${id}`);
        assert(sent.at(-1)!.text.startsWith("✅ Saved"), sent.at(-1)!.text);
        const c = await counts(lead);
        assert(c.visits === 2 && c.scheduled === 1 && c.overrides === 1, `rows ${JSON.stringify(c)}`);
        const v = await db.execute<{ visit_status: string; visit_outcome: string | null; actual: string | null; sched: string | null }>(sql`
            SELECT visit_status, visit_outcome, actual_visit_date::text AS actual, scheduled_date::text AS sched
              FROM lead_visits WHERE dealer_lead_id = ${lead} ORDER BY visit_status`);
        assert(v[0]!.visit_status === "scheduled" && v[0]!.sched === today, `scheduled row ${JSON.stringify(v[0])}`);
        assert(v[1]!.visit_status === "visited" && v[1]!.visit_outcome === "productive" && v[1]!.actual === yesterday, `visit row ${JSON.stringify(v[1])}`);
        const tp = await db.execute<{ touchpoint_type: string }>(sql`SELECT touchpoint_type FROM lead_touchpoints WHERE dealer_lead_id = ${lead}`);
        assert(tp.length === 1 && tp[0]!.touchpoint_type === "visit", JSON.stringify(tp));
        const l = await db.execute<{ interest_level: string | null }>(sql`SELECT interest_level FROM dealer_leads WHERE id = ${lead}`);
        assert(l[0]!.interest_level === "hot", `interest ${l[0]!.interest_level}`);
        const a = await actionRow(id);
        assert(a?.status === "confirmed" && a.after?.visit_id && a.after?.scheduled_visit_id, JSON.stringify(a));
        if (today === dbToday) {
            const rows = await fetchAsmQueueRows({ tab: "today", asmId: asm.id, page: 1, limit: 100 });
            assert(rows.some((r) => r.id === lead), "the next visit is not in Today's Schedule");
            return "visit + visit touchpoint + interest override + scheduled row; lead in Today's Schedule";
        }
        return `all four parts written (DB date ${dbToday} ≠ IST ${today}: Today's Schedule check skipped)`;
    });

    await check("G5.2 UC-01 rollback: a failure after the visit insert leaves ZERO new rows", async () => {
        const lead = await makeLead("uc01-rb", { owner: asm.id, asm: asm.id, status: "Under_Discussion" });
        const version = (await db.execute<{ updated_at: string }>(sql`SELECT updated_at FROM dealer_leads WHERE id = ${lead}`))[0]!.updated_at;
        // A stored plan whose LAST step fails ('other' with no notes → markLeadLost throws)
        // after recordVisit (visit + touchpoint + scheduled row) and setInterestLevel ran.
        const { id } = await createPending({
            userId: asm.id, tool: "log_visit", leadId: lead, leadVersion: new Date(version),
            plan: {
                lead_id: lead, visit_status: "visited", visit_outcome: "dealer_uninterested", visit_date: yesterday,
                remarks: "forced failure", next_action: "next_visit", next_visit_date: today,
                interest: "cold", status_to: null, lost: { reason: "other", notes: null },
            },
            preview: { title: "t", lines: [], resets_idle_clock: true, warning: null, needs_second_confirm: false, crm_url: "x" },
            before: {}, sourceMessageId: null,
        });
        const before = await counts(lead);
        const out = await executeAction(id, asm, { messageId: null });
        assert(out.kind === "error", `expected error, got ${out.kind}`);
        const after = await counts(lead);
        assert(JSON.stringify(after) === JSON.stringify(before), `rows survived: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
        const l = await db.execute<{ interest_level: string | null; lead_status: string }>(sql`SELECT interest_level, lead_status FROM dealer_leads WHERE id = ${lead}`);
        assert(l[0]!.interest_level === null && l[0]!.lead_status === "Under_Discussion", JSON.stringify(l[0]));
        const a = await actionRow(id);
        // markLeadLost's own refusal: proves the failure came AFTER recordVisit + setInterestLevel ran.
        assert(a?.status === "failed" && /lost_reason_notes is required/.test(a.error ?? ""), JSON.stringify(a));
        return `counts ${JSON.stringify(after)} before and after; action failed`;
    });

    await check("G5.3 §9.3 row 7: commercials progressed → Commercials_Explained, on its own history row, same action", async () => {
        const lead = await makeLead("visit-ce", { owner: asm.id, asm: asm.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{
            name: "log_visit",
            args: { lead_id: lead, visit_status: "visited", outcome: "commercials_progressed", status: "Commercials_Explained",
                    remarks: "rate bata diya", next_action: "escalate" },
        }]));
        await say(deps, asmPhone, "rate pe baat hui, commercials explain kar diye, escalate karna hai");
        await tap(deps, asmPhone, `ast:c:${lastActionId(sent)}`);
        const l = await leadRow(lead);
        const c = await counts(lead);
        assert(l.lead_status === "Commercials_Explained", `status ${l.lead_status}`);
        assert(c.visits === 1 && c.scheduled === 0 && c.touchpoints === 2 && c.history >= 1, JSON.stringify(c));
    });

    await check("G5.4 §9.3 row 8: dealer uninterested + Lost(not_interested) → visit and Lost in one action", async () => {
        const lead = await makeLead("visit-lost", { owner: asm.id, asm: asm.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{
            name: "log_visit",
            args: { lead_id: lead, visit_status: "visited", outcome: "dealer_uninterested", status: "Lost", lost_reason: "not_interested",
                    remarks: "dealer ko interest nahi", next_action: "lost" },
        }]));
        await say(deps, asmPhone, "dealer ko interest nahi, lost kar do");
        await tap(deps, asmPhone, `ast:c:${lastActionId(sent)}`);
        const l = await leadRow(lead);
        assert(l.lead_status === "Lost" && l.lost_reason === "not_interested", JSON.stringify(l));
        assert((await counts(lead)).visits === 1, "visit row missing");
    });

    await check("G5.5 mark_lost: preview → Confirm → Lost with the reason and notes", async () => {
        const lead = await makeLead("lost", { owner: isr.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{ name: "mark_lost", args: { lead_id: lead, lost_reason: "loan_procedure_issue", notes: "loan rejected twice" } }]));
        await say(deps, isrPhone, "Mark it lost, loan nahi ho raha");
        const id = lastActionId(sent);
        assert(/Status: Under Discussion → Lost \(loan procedure issue\)/.test(sent.at(-1)!.text), sent.at(-1)!.text);
        assert((await leadRow(lead)).touchpoints === 0, "the preview wrote");
        await tap(deps, isrPhone, `ast:c:${id}`);
        const l = await leadRow(lead);
        assert(l.lead_status === "Lost" && l.lost_reason === "loan_procedure_issue" && l.touchpoints === 1, JSON.stringify(l));
        assert((await actionRow(id))?.status === "confirmed", "action not confirmed");
    });

    await check("G5.6 mark_lost high-impact (duplicate_lead): step 1 writes nothing, a repeated step-1 tap doesn't count, step 2 saves", async () => {
        const lead = await makeLead("lost-hi", { owner: isr.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{ name: "mark_lost", args: { lead_id: lead, lost_reason: "duplicate_lead" } }]));
        await say(deps, isrPhone, "yeh duplicate hai, lost kar do");
        const step1 = lastActionId(sent);
        assert(/High-impact/.test(sent.at(-1)!.text), sent.at(-1)!.text);
        await tap(deps, isrPhone, `ast:c:${step1}`);
        const step2 = lastActionId(sent);
        assert(step2 !== step1 && /Tap Confirm again/.test(sent.at(-1)!.text), sent.at(-1)!.text);
        await tap(deps, isrPhone, `ast:c:${step1}`);
        assert((await leadRow(lead)).touchpoints === 0 && (await actionRow(step1))?.status === "escalated", "step 1 wrote");
        await tap(deps, isrPhone, `ast:c:${step2}`);
        const l = await leadRow(lead);
        assert(l.lead_status === "Lost" && l.lost_reason === "duplicate_lead" && l.touchpoints === 1, JSON.stringify(l));
    });

    await check("G5.7 UC-05 ISR: 'Claim <name> from the pool' → preview → Confirm → owner + Assigned_Not_Contacted + lead_claimed", async () => {
        const lead = await makeLead(`uc05-${RUN}`, { owner: null, asm: null, status: "New_Unassigned" });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{ name: "claim_lead", args: { name: `WA Test Shop uc05-${RUN}` } }]));
        await say(deps, isrPhone, `Claim WA Test Shop uc05-${RUN} from the pool`);
        const id = lastActionId(sent);
        assert(/Status: New Unassigned → Assigned Not Contacted/.test(sent.at(-1)!.text), sent.at(-1)!.text);
        await tap(deps, isrPhone, `ast:c:${id}`);
        const r = await db.execute<{ o: string | null; a: string | null; s: string; tp: number }>(sql`
            SELECT current_owner_id AS o, asm_id AS a, lead_status AS s,
                   (SELECT count(*) FROM lead_touchpoints WHERE dealer_lead_id = ${lead} AND touchpoint_type = 'lead_claimed')::int AS tp
              FROM dealer_leads WHERE id = ${lead}`);
        assert(r[0]!.o === isr.id && r[0]!.a === null && r[0]!.s === "Assigned_Not_Contacted" && r[0]!.tp === 1, JSON.stringify(r[0]));
        assert((await actionRow(id))?.status === "confirmed", "action not confirmed");
    });

    await check("G5.8 claim: two pool leads with one name → candidates, never a pick; nothing proposed", async () => {
        const a = await makeLead(`dup-${RUN}-a`, { owner: null, status: "New_Unassigned" });
        const b = await makeLead(`dup-${RUN}-b`, { owner: null, status: "New_Unassigned" });
        const sent: Sent[] = [];
        await say(g4Deps(sent, () => scriptedCalls([{ name: "claim_lead", args: { name: `dup-${RUN}` } }])), isrPhone, `claim dup-${RUN}`);
        const p = sent.at(-1)!.payload;
        assert(p?.kind === "list", `expected a list, got ${p?.kind}: ${sent.at(-1)!.text}`);
        assert((await actionsFor(a)) === 0 && (await actionsFor(b)) === 0, "an action was created");
    });

    await check("G5.9 UC-05 ASM: in-territory claim sets owner + field ASM; an out-of-territory lead is refused", async () => {
        const inside = await makeLead("asm-in", { owner: null, asm: null, status: null, state: myState });
        const outside = await makeLead("asm-out", { owner: null, asm: null, status: null, state: `WA-T5-ELSEWHERE-${RUN}` });
        const sent: Sent[] = [];
        let deps = g4Deps(sent, () => scriptedCalls([{ name: "claim_lead", args: { lead_id: inside } }]));
        await say(deps, asmPhone, "claim this one");
        await tap(deps, asmPhone, `ast:c:${lastActionId(sent)}`);
        const r = await db.execute<{ o: string | null; a: string | null; s: string }>(sql`
            SELECT current_owner_id AS o, asm_id AS a, lead_status AS s FROM dealer_leads WHERE id = ${inside}`);
        assert(r[0]!.o === asm.id && r[0]!.a === asm.id && r[0]!.s === "Assigned_Not_Contacted", JSON.stringify(r[0]));

        // Visible (the Territory Feed shows unowned leads anywhere) but not claimable.
        assert(await findLeadInScope(asm, outside), "fixture: the outside lead should be readable");
        const n = sent.length;
        deps = g4Deps(sent, () => scriptedCalls([{ name: "claim_lead", args: { lead_id: outside } }]));
        await say(deps, asmPhone, "claim the other one too");
        const tr = await db.execute<{ output: { kind?: string; reason?: string } }>(sql`
            SELECT output FROM assistant_tool_calls WHERE user_id = ${asm.id}::uuid AND tool = 'claim_lead' ORDER BY created_at DESC LIMIT 1`);
        assert(tr[0]?.output?.kind === "declined" && /outside your territory/.test(tr[0].output.reason ?? ""), JSON.stringify(tr[0]));
        assert(!sent.slice(n).some((s) => s.payload?.kind === "buttons"), "a preview was sent");
        const o = await db.execute<{ o: string | null }>(sql`SELECT current_owner_id AS o FROM dealer_leads WHERE id = ${outside}`);
        assert(o[0]!.o === null && (await actionsFor(outside)) === 0, "out-of-territory lead was claimed / proposed");
    });

    await check("G5.10 claim re-checked at tap: taken by someone else, or territory ended → not_claimable, nothing written", async () => {
        const other = await makeUser("inside_sales_rep");
        const l1 = await makeLead("claim-raced", { owner: null, status: "New_Unassigned" });
        const sent: Sent[] = [];
        let deps = g4Deps(sent, () => scriptedCalls([{ name: "claim_lead", args: { lead_id: l1 } }]));
        await say(deps, isrPhone, "claim it");
        const a1 = lastActionId(sent);
        const out = await claimLead(l1, other, { actorRole: "inside_sales_rep" });
        assert(out.ok, "fixture claim failed");
        await tap(deps, isrPhone, `ast:c:${a1}`);
        assert((await actionRow(a1))?.error === "rejected: not_claimable", JSON.stringify(await actionRow(a1)));
        const o1 = await db.execute<{ o: string | null; tp: number }>(sql`
            SELECT current_owner_id AS o, (SELECT count(*) FROM lead_touchpoints WHERE dealer_lead_id = ${l1})::int AS tp FROM dealer_leads WHERE id = ${l1}`);
        assert(o1[0]!.o === other && o1[0]!.tp === 1, `the Assistant's claim wrote: ${JSON.stringify(o1[0])}`);

        const l2 = await makeLead("claim-territory-ended", { owner: null, status: null, state: myState });
        deps = g4Deps(sent, () => scriptedCalls([{ name: "claim_lead", args: { lead_id: l2 } }]));
        await say(deps, asmPhone, "claim it");
        const a2 = lastActionId(sent);
        await db.execute(sql`UPDATE asm_territories SET active_to = CURRENT_DATE - 1 WHERE asm_id = ${asm.id}`);
        try {
            await tap(deps, asmPhone, `ast:c:${a2}`);
        } finally {
            await db.execute(sql`UPDATE asm_territories SET active_to = NULL WHERE asm_id = ${asm.id}`);
        }
        assert((await actionRow(a2))?.error === "rejected: not_claimable", JSON.stringify(await actionRow(a2)));
        const o2 = await db.execute<{ o: string | null }>(sql`SELECT current_owner_id AS o FROM dealer_leads WHERE id = ${l2}`);
        assert(o2[0]!.o === null, "claimed after the territory ended");
    });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function gate6() {
    if (!(await hasTable("assistant_actions"))) {
        await check("G6.* Phase 2 lead actions", async () => {
            throw new Skip("needs E-309 (drizzle/E-309_wa_assistant.sql) on this database");
        });
        return;
    }
    const isr: AssistantUser = { id: await makeUser("inside_sales_rep"), name: "WA Test inside_sales_rep", role: "inside_sales_rep" };
    const asm: AssistantUser = { id: await makeUser("asm"), name: "WA Test asm", role: "asm" };
    const isrPhone = phone(60);
    const asmPhone = phone(61);
    for (const [u, p] of [[isr, isrPhone], [asm, asmPhone]] as const) {
        await db.execute(sql`INSERT INTO assistant_wa_bindings (user_id, wa_phone, status, verified_at) VALUES (${u.id}::uuid, ${p}, 'active', now())`);
    }
    process.env.ASSISTANT_WRITES_ENABLED_USER_IDS = [isr.id, asm.id].join(",");
    // The fixture ASM covers a state of its own, so it is the in-territory ASM for the fixture leads.
    const myState = `WA-T6-${RUN}`;
    await db.execute(sql`INSERT INTO asm_territories (asm_id, state) VALUES (${asm.id}, ${myState})`);
    const lastText = (sent: Sent[]) => sent.at(-1)!.text;
    const owner = async (id: string) =>
        (await db.execute<{ current_owner_id: string | null; asm_id: string | null; lead_status: string | null }>(sql`
            SELECT current_owner_id, asm_id, lead_status FROM dealer_leads WHERE id = ${id}`))[0]!;

    await check("G6.1 transfer_to_asm end to end: preview writes nothing; Confirm → ASM owns it, Transferred_to_ASM, a visit row, one asm_transfer touchpoint", async () => {
        const lead = await makeLead("t6-transfer", { owner: isr.id, status: "Under_Discussion", state: myState });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{
            name: "transfer_to_asm",
            args: { lead_id: lead, asm: asm.id, reason: "Site_Visit_Needed", visit_type: "Initial_Visit", handoff_notes: "wants a demo at the shop" },
        }]));
        await say(deps, isrPhone, "Transfer this lead to the ASM, site visit needed");
        const id = lastActionId(sent);
        assert(/^\*Transfer WA Test Shop t6-transfer → WA Test asm\*/.test(lastText(sent)), lastText(sent));
        assert(/Under Discussion → Transferred to ASM/.test(lastText(sent)) && /read-only for you/.test(lastText(sent)), lastText(sent));
        const before = await counts(lead);
        assert(before.visits === 0 && before.touchpoints === 0 && before.history === 0, `the preview wrote: ${JSON.stringify(before)}`);

        await tap(deps, isrPhone, `ast:c:${id}`);
        assert(lastText(sent).startsWith("✅ Saved"), lastText(sent));
        const o = await owner(lead);
        assert(o.current_owner_id === asm.id && o.asm_id === asm.id && o.lead_status === "Transferred_to_ASM", JSON.stringify(o));
        const c = await counts(lead);
        assert(c.visits === 1 && c.touchpoints === 1 && c.history === 1, `rows ${JSON.stringify(c)}`);
        const tp = await db.execute<{ touchpoint_type: string }>(sql`SELECT touchpoint_type FROM lead_touchpoints WHERE dealer_lead_id = ${lead}`);
        assert(tp[0]!.touchpoint_type === "asm_transfer", JSON.stringify(tp));
        return "owner + asm_id → ASM, status + history, visit pending_scheduling, asm_transfer touchpoint";
    });

    await check("G6.2 a lead changed after the transfer preview → stale, nothing written", async () => {
        const lead = await makeLead("t6-stale", { owner: isr.id, status: "Under_Discussion", state: myState });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{
            name: "transfer_to_asm",
            args: { lead_id: lead, asm: asm.id, reason: "Demo_Requested", visit_type: "Demo" },
        }]));
        await say(deps, isrPhone, "transfer to asm");
        const id = lastActionId(sent);
        await db.execute(sql`UPDATE dealer_leads SET updated_at = now() + interval '1 second' WHERE id = ${lead}`);
        await tap(deps, isrPhone, `ast:c:${id}`);
        assert(/changed after the preview/.test(lastText(sent)), lastText(sent));
        const o = await owner(lead);
        const c = await counts(lead);
        assert(o.current_owner_id === isr.id && c.visits === 0 && c.touchpoints === 0, `${JSON.stringify(o)} ${JSON.stringify(c)}`);
    });

    await check("G6.3 reassign_lead ASM → ISR: owner moves back, asm_id kept, one ownership_transfer touchpoint", async () => {
        const lead = await makeLead("t6-reassign", { owner: asm.id, asm: asm.id, status: "Under_Discussion", state: myState });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{
            name: "reassign_lead",
            args: { lead_id: lead, to: isr.id, reason: "dealer only wants phone follow-ups for now" },
        }]));
        await say(deps, asmPhone, "give this back to inside sales");
        const id = lastActionId(sent);
        assert(/Owner: you → WA Test inside_sales_rep \(ISR\)/.test(lastText(sent)), lastText(sent));
        await tap(deps, asmPhone, `ast:c:${id}`);
        assert(lastText(sent).startsWith("✅ Saved"), lastText(sent));
        const o = await owner(lead);
        assert(o.current_owner_id === isr.id && o.asm_id === asm.id, JSON.stringify(o));
        const tp = await db.execute<{ touchpoint_type: string }>(sql`SELECT touchpoint_type FROM lead_touchpoints WHERE dealer_lead_id = ${lead}`);
        assert(tp.length === 1 && tp[0]!.touchpoint_type === "ownership_transfer", JSON.stringify(tp));
    });

    await check("G6.4 escalate_lead: escalation row + pending_review; the owner does not change", async () => {
        const lead = await makeLead("t6-escalate", { owner: isr.id, status: "Under_Discussion", state: myState });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{
            name: "escalate_lead",
            args: { lead_id: lead, reason: "Commercial_Decision_Needed", urgency: "normal", notes: "dealer wants a price only the sales head can approve" },
        }]));
        await say(deps, isrPhone, "escalate this, price approval needed");
        const id = lastActionId(sent);
        await tap(deps, isrPhone, `ast:c:${id}`);
        assert(lastText(sent).startsWith("✅ Saved"), lastText(sent));
        const e = await db.execute<{ n: number; status: string | null }>(sql`
            SELECT (SELECT count(*) FROM lead_escalations WHERE dealer_lead_id = ${lead})::int AS n,
                   (SELECT escalation_status FROM dealer_leads WHERE id = ${lead}) AS status`);
        assert(e[0]!.n === 1 && e[0]!.status === "pending_review", JSON.stringify(e[0]));
        assert((await owner(lead)).current_owner_id === isr.id, "owner changed");
    });

    await check("G6.5 mark_converted: Converted + GSTIN + onboarding application in one commit; reply offers Send invite; the invite tap only proposes (declined: no phone)", async () => {
        const lead = await makeLead("t6-convert", { owner: isr.id, status: "Under_Discussion", state: myState });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{ name: "mark_converted", args: { lead_id: lead, gstin: "27aaacb1234c1z5" } }]));
        await say(deps, isrPhone, "deal done, GST 27aaacb1234c1z5");
        const id = lastActionId(sent);
        assert(/GSTIN: 27AAACB1234C1Z5/.test(lastText(sent)), lastText(sent));
        await tap(deps, isrPhone, `ast:c:${id}`);
        const reply = sent.at(-1)!.payload;
        assert(reply?.kind === "buttons" && reply.buttons[0]?.id === `ast:inv:${lead}` && !reply.actionId, JSON.stringify(reply));
        const l = await db.execute<{ lead_status: string | null; gstin: string | null; app: string | null }>(sql`
            SELECT lead_status, gstin, dealer_onboarding_application_id::text AS app FROM dealer_leads WHERE id = ${lead}`);
        assert(l[0]!.lead_status === "Converted" && l[0]!.gstin === "27AAACB1234C1Z5" && l[0]!.app, JSON.stringify(l[0]));

        // The fixture lead has no phone, so the invite is refused at the proposal — nothing is sent.
        await tap(deps, isrPhone, `ast:inv:${lead}`);
        assert(/no valid phone number/.test(lastText(sent)), lastText(sent));
        const pendingInvites = await db.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM assistant_actions WHERE lead_id = ${lead} AND tool = 'invite_dealer_onboarding'`);
        assert(pendingInvites[0]!.n === 0, "an invite action was created");
    });

    await check("G6.6 create_lead: ISR's lead lands unowned in the claim pool; the same phone again is refused", async () => {
        let created: string | null = null;
        const digits = `9${String(Date.now()).slice(-9)}`;
        try {
            const sent: Sent[] = [];
            const deps = g4Deps(sent, () => scriptedCalls([{ name: "create_lead", args: { dealer_name: `WA Test ${RUN}`, phone: digits, city: "Pune" } }]));
            await say(deps, isrPhone, `new lead WA Test ${RUN} ${digits} Pune`);
            const id = lastActionId(sent);
            assert(/Goes to: the unassigned claim pool/.test(lastText(sent)), lastText(sent));
            await tap(deps, isrPhone, `ast:c:${id}`);
            assert(lastText(sent).startsWith("✅ Saved"), lastText(sent));
            const a = await actionRow(id);
            created = (a?.after?.lead_id as string) ?? null;
            assert(created, JSON.stringify(a));
            const l = await db.execute<{ current_owner_id: string | null; lead_status: string | null; originator_id: string | null }>(sql`
                SELECT current_owner_id, lead_status, originator_id FROM dealer_leads WHERE id = ${created}`);
            assert(l[0]!.current_owner_id === null && l[0]!.lead_status === "New_Unassigned" && l[0]!.originator_id === isr.id, JSON.stringify(l[0]));

            const again = g4Deps(sent, () => scriptedCalls([{ name: "create_lead", args: { dealer_name: "WA Test dup", phone: digits } }]));
            const n = sent.length;
            await say(again, isrPhone, `new lead ${digits}`);
            assert(sent.length > n && sent.at(-1)!.payload?.kind !== "buttons", `a preview was offered for a duplicate: ${lastText(sent)}`);
            return `created ${created}; duplicate refused`;
        } finally {
            if (created) {
                await db.execute(sql`DELETE FROM lead_registry WHERE source_table = 'dealer_leads' AND source_id = ${created}`).catch(() => {});
                await db.execute(sql`UPDATE assistant_actions SET lead_id = NULL WHERE lead_id = ${created}`);
                await db.execute(sql`DELETE FROM dealer_leads WHERE id = ${created}`);
            }
        }
    });
}

async function gate7() {
    if (!(await hasTable("assistant_actions"))) {
        await check("G7.* auto status / Edit", async () => {
            throw new Skip("needs E-309 (drizzle/E-309_wa_assistant.sql) on this database");
        });
        return;
    }
    const isr: AssistantUser = { id: await makeUser("inside_sales_rep"), name: "WA Test inside_sales_rep", role: "inside_sales_rep" };
    const asm: AssistantUser = { id: await makeUser("asm"), name: "WA Test asm", role: "asm" };
    const isrPhone = phone(70);
    const asmPhone = phone(71);
    for (const [u, p] of [[isr, isrPhone], [asm, asmPhone]] as const) {
        await db.execute(sql`INSERT INTO assistant_wa_bindings (user_id, wa_phone, status, verified_at) VALUES (${u.id}::uuid, ${p}, 'active', now())`);
    }
    process.env.ASSISTANT_WRITES_ENABLED_USER_IDS = [isr.id, asm.id].join(",");
    const lastText = (sent: Sent[]) => sent.at(-1)!.text;
    const leadState = async (id: string) =>
        (await db.execute<{ lead_status: string | null; interest_level: string | null; next_follow_up_at: string | null }>(sql`
            SELECT lead_status, interest_level, next_follow_up_at::text AS next_follow_up_at FROM dealer_leads WHERE id = ${id}`))[0]!;
    const tomorrow = istNow(new Date(Date.now() + 86_400_000)).isoDate;
    const dayAfter = istNow(new Date(Date.now() + 2 * 86_400_000)).isoDate;

    await check("G7.1 auto: a connected 'Details Shared' call with nothing else said → Under Discussion + warm, marked (auto), audited as auto", async () => {
        const lead = await makeLead("t7-auto", { owner: isr.id, status: "Assigned_Not_Contacted" });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{
            name: "log_call",
            args: { lead_id: lead, channel: "call", connect_status: "connected", disposition: "Details Shared", remarks: "shared brochure" },
        }]));
        await say(deps, isrPhone, "Baat hui, details share kar di");
        const id = lastActionId(sent);
        assert(/Status: Assigned Not Contacted → Under Discussion \(auto\)/.test(lastText(sent)) && /Temperature: none → warm \(auto\)/.test(lastText(sent)), lastText(sent));
        await tap(deps, isrPhone, `ast:c:${id}`);
        const l = await leadState(lead);
        assert(l.lead_status === "Under_Discussion" && l.interest_level === "warm", JSON.stringify(l));
        const o = await db.execute<{ reason: string | null }>(sql`
            SELECT reason FROM interest_level_overrides WHERE dealer_lead_id = ${lead} ORDER BY created_at DESC LIMIT 1`);
        assert(/^Auto:/.test(o[0]?.reason ?? ""), `override reason ${o[0]?.reason}`);
    });

    await check("G7.2 auto: an ASM's productive visit on a transferred lead → Under Discussion (auto)", async () => {
        const lead = await makeLead("t7-visit", { owner: asm.id, asm: asm.id, status: "Transferred_to_ASM" });
        const sent: Sent[] = [];
        const deps = g4Deps(sent, () => scriptedCalls([{
            name: "log_visit",
            args: { lead_id: lead, visit_status: "visited", outcome: "productive", remarks: "met the owner", next_action: "escalate" },
        }]));
        await say(deps, asmPhone, "visit kiya, productive");
        const id = lastActionId(sent);
        assert(/Under Discussion \(auto\)/.test(lastText(sent)), lastText(sent));
        await tap(deps, asmPhone, `ast:c:${id}`);
        assert((await leadState(lead)).lead_status === "Under_Discussion", "status not moved");
    });

    await check("G7.3 Edit: card has Confirm/Edit/Cancel; Edit → next message revises it; old card refused as replaced; new card saves the corrected date", async () => {
        const lead = await makeLead("t7-edit", { owner: isr.id, status: "Under_Discussion" });
        const sent: Sent[] = [];
        let turn = 0;
        const deps = g4Deps(sent, () => scriptedCalls([{
            name: "set_follow_up",
            args: { lead_id: lead, follow_up_at: `${turn++ === 0 ? tomorrow : dayAfter}T11:00:00+05:30`, note: "call again" },
        }]));
        await say(deps, isrPhone, "kal 11 baje follow up");
        const first = lastActionId(sent);
        const card = sent.at(-1)!.payload;
        assert(card?.kind === "buttons" && card.buttons.map((b) => b.title).join("/") === "Confirm/Edit/Cancel", JSON.stringify(card));

        await tap(deps, isrPhone, `ast:e:${first}`);
        assert(/Kya badalna hai/.test(lastText(sent)), lastText(sent));
        assert((await actionRow(first))?.status === "pending", "Edit tap changed the card");

        await say(deps, isrPhone, "kal nahi, parso");
        const second = lastActionId(sent);
        assert(second !== first, "no new card");
        const hist = await db.execute<{ m: string }>(sql`
            SELECT messages::text AS m FROM assistant_conversations WHERE user_id = ${isr.id}::uuid`);
        assert(/\[EDIT\]/.test(hist[0]?.m ?? ""), "the edit context never reached the agent");
        const old = await actionRow(first);
        assert(old?.status === "cancelled" && /^superseded by /.test(old.error ?? ""), JSON.stringify(old));

        await tap(deps, isrPhone, `ast:c:${first}`);
        assert(/replaced by a newer one/.test(lastText(sent)), lastText(sent));
        await tap(deps, isrPhone, `ast:c:${second}`);
        assert(lastText(sent).startsWith("✅ Saved"), lastText(sent));
        const l = await leadState(lead);
        assert(istNow(new Date(l.next_follow_up_at!)).isoDate === dayAfter, `follow-up ${l.next_follow_up_at}`);
    });
}

async function main() {
    const gate = Number(process.argv[process.argv.indexOf("--gate") + 1] || "1");
    await runSuites([gate1, gate2, gate3, gate4, gate5, gate6, gate7].slice(0, gate));
}

void main();
