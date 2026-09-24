import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";

// scope.ts / tools use the Drizzle client; findLeadInScope is replaced per test.
vi.mock("@/lib/db", () => ({ db: { execute: vi.fn(async () => []) } }));
const findLeadInScope = vi.fn();
vi.mock("../scope", async (orig) => ({ ...(await orig<typeof import("../scope")>()), findLeadInScope }));

const { toolNamesFor, toolsFor, ROLE_TOOLS } = await import("../registry");
const { scopePredicate, scopeJoin, claimPoolPredicate } = await import("../scope");
const { tabFilter: isrTab } = await import("@/lib/inside-sales/queryBuilder");
const { tabFilter: asmTab } = await import("@/lib/asm/queryBuilder");
const { runAgentTurn, sanitizeResult, AGENT_LIMITS } = await import("../agent");
const { redactText, redactDeep } = await import("../redact");
const { trimTurns } = await import("../memory");
const { buildSystemPrompt, istNow } = await import("../prompt");
const { assistantConfig } = await import("../config");
import type { AssistantUser, ToolContext, ToolResult } from "../types";
import type { ToolSpec } from "../tools/spec";
import type { ToolCallingModel } from "../agent";
import type { ToolCallRecord } from "../audit";

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);
/** SQL text with placeholders normalised — numbering shifts when clauses are combined. */
const shape = (q: SQL) => render(q).sql.replace(/\$\d+/g, "$?");

const ISR: AssistantUser = { id: "isr-1", name: "Priya", role: "inside_sales_rep" };
const ASM: AssistantUser = { id: "asm-1", name: "Rahul", role: "asm" };
const ctx = (user: AssistantUser, writesEnabled = true): ToolContext => ({
    user, messageId: "m1", now: new Date("2026-09-24T12:00:00Z"), writesEnabled,
});

beforeEach(() => findLeadInScope.mockReset());

// ── Registry ────────────────────────────────────────────────────────────────

describe("registry", () => {
    it("unknown role → zero tools (done-when)", () => {
        for (const role of ["admin", "ceo", "dealer", "sales_head", "", null, undefined, "ASM"]) {
            expect(toolNamesFor(role, true), String(role)).toEqual([]);
            expect(toolsFor(role, true)).toEqual([]);
        }
    });

    it("off the pilot list → read tools only; on it → the role's writes", () => {
        expect(toolNamesFor("inside_sales_rep", false)).toEqual(["my_queue", "search_lead", "get_lead_details", "my_numbers"]);
        expect(toolNamesFor("asm", false)).toEqual(["my_queue", "search_lead", "get_lead_details", "my_numbers"]);
        expect(toolNamesFor("asm", true)).toContain("log_visit");
        expect(toolNamesFor("inside_sales_rep", true)).not.toContain("log_visit");
        expect(toolNamesFor("inside_sales_rep", true)).toEqual([...ROLE_TOOLS.inside_sales_rep]);
    });

    it("all nine tools have a Zod schema that rejects junk (unknown keys are stripped, never acted on)", () => {
        const all = [...toolsFor("asm", true), ...toolsFor("inside_sales_rep", true)];
        expect(new Set(all.map((t) => t.name)).size).toBe(9);
        for (const t of all.filter((x) => x.name !== "my_numbers")) {
            expect(t.schema.safeParse({ lead_id: "", evil: 1 }).success, t.name).toBe(false);
        }
        const numbers = all.find((t) => t.name === "my_numbers")!;
        expect(numbers.schema.safeParse({ period: "forever" }).success).toBe(false);
        expect(numbers.schema.parse({ user_id: "someone-else" })).toEqual({ period: "this_month" });
    });

    it("my_queue's tab enum is the role's own tabs", () => {
        const asmQueue = toolsFor("asm", false).find((t) => t.name === "my_queue")!;
        expect(asmQueue.schema.safeParse({ tab: "today" }).success).toBe(true);
        expect(asmQueue.schema.safeParse({ tab: "follow_ups" }).success).toBe(false);
        const isrQueue = toolsFor("inside_sales_rep", false).find((t) => t.name === "my_queue")!;
        expect(isrQueue.schema.safeParse({ tab: "follow_ups" }).success).toBe(true);
        expect(isrQueue.schema.safeParse({ tab: "today" }).success).toBe(false);
    });

    it("INV6: write schemas accept only the closed vocabulary", () => {
        const logCall = toolsFor("inside_sales_rep", true).find((t) => t.name === "log_call")!;
        const base = { lead_id: "DL-1", channel: "call", connect_status: "connected", disposition: "Price High" };
        expect(logCall.schema.safeParse(base).success).toBe(true);
        expect(logCall.schema.safeParse({ ...base, disposition: "Very Interested" }).success).toBe(false);
        expect(logCall.schema.safeParse({ ...base, status: "Won" }).success).toBe(false);
        expect(logCall.schema.safeParse({ ...base, lost_reason: "too_far" }).success).toBe(false);
        expect(logCall.schema.safeParse({ ...base, follow_up_at: "Friday 11am" }).success).toBe(false);
        expect(logCall.schema.safeParse({ ...base, follow_up_at: "2026-09-25T11:00:00+05:30" }).success).toBe(true);
        const markLost = toolsFor("inside_sales_rep", true).find((t) => t.name === "mark_lost")!;
        expect(markLost.schema.safeParse({ lead_id: "DL-1", lost_reason: "other" }).success).toBe(false);
        expect(markLost.schema.safeParse({ lead_id: "DL-1", lost_reason: "other", notes: "moved city" }).success).toBe(true);
    });
});

// ── Scope ───────────────────────────────────────────────────────────────────

describe("scope predicate (INV1)", () => {
    it("ISR scope is exactly the union of the 5 ISR tab clauses", () => {
        const q = shape(scopePredicate(ISR));
        const tabs = (["my_open", "follow_ups", "unassigned", "team", "my_closed"] as const).map((t) => shape(isrTab(t, ISR.id)));
        expect(q).toBe(`(${tabs.map((t) => `(${t})`).join(" OR ")})`);
        expect(render(scopePredicate(ISR)).params.filter((p) => p === ISR.id).length).toBe(3);
        expect(render(scopeJoin(ISR)).sql).toBe("");
    });

    it("ASM scope is the union of the 5 ASM tab clauses and joins the latest-visit lateral", () => {
        const q = shape(scopePredicate(ASM));
        const tabs = (["my_visits", "today", "territory", "unclaimed", "my_closed"] as const).map((t) => shape(asmTab(t, ASM.id)));
        expect(q).toBe(`(${tabs.map((t) => `(${t})`).join(" OR ")})`);
        expect(render(scopeJoin(ASM)).sql).toMatch(/LEFT JOIN LATERAL/);
    });

    it("any other role matches nothing", () => {
        expect(render(scopePredicate({ id: "x", role: "admin" })).sql).toBe("FALSE");
        expect(render(claimPoolPredicate({ id: "x", role: "ceo" })).sql).toBe("FALSE");
    });

    it("claim pool: ISR = unassigned tab; ASM = unclaimed (in-territory) tab, not the whole feed", () => {
        expect(render(claimPoolPredicate(ISR)).sql).toBe(render(isrTab("unassigned", ISR.id)).sql);
        expect(render(claimPoolPredicate(ASM)).sql).toBe(render(asmTab("unclaimed", ASM.id)).sql);
    });

    it("INV1_same_access: an out-of-scope id and a nonexistent id give the IDENTICAL result", async () => {
        const details = toolsFor("inside_sales_rep", true).find((t) => t.name === "get_lead_details")!;
        const logCall = toolsFor("inside_sales_rep", true).find((t) => t.name === "log_call")!;
        findLeadInScope.mockResolvedValue(null); // what the scoped query returns for BOTH
        const outOfScope = await details.run(ctx(ISR), { lead_id: "DL-SOMEONE-ELSES" });
        const missing = await details.run(ctx(ISR), { lead_id: "DL-DOES-NOT-EXIST" });
        expect(outOfScope).toEqual({ kind: "not_found" });
        expect(missing).toEqual(outOfScope);
        const write = await logCall.run(ctx(ISR), {
            lead_id: "DL-SOMEONE-ELSES", channel: "note",
        });
        expect(write).toEqual({ kind: "not_found" });
    });

    it("in scope but not owned is read-only for every write tool", async () => {
        findLeadInScope.mockResolvedValue({ id: "DL-1", current_owner_id: "isr-2", lead_status: "Under_Discussion", updated_at: new Date(), owned: false });
        for (const t of toolsFor("asm", true).filter((x) => x.kind === "write" && x.name !== "claim_lead")) {
            const input =
                t.name === "log_visit" ? { lead_id: "DL-1", visit_status: "visited", outcome: "productive", remarks: "x", next_action: "escalate" }
                : t.name === "mark_lost" ? { lead_id: "DL-1", lost_reason: "not_interested" }
                : t.name === "set_follow_up" ? { lead_id: "DL-1", visit_date: "2026-09-26", note: "x" }
                : { lead_id: "DL-1", channel: "note" };
            const r = await t.run(ctx(ASM), t.schema.parse(input));
            expect(r.kind, t.name).toBe("declined");
        }
    });

    it("writes off the pilot list are declined before any lookup", async () => {
        const logCall = toolsFor("inside_sales_rep", true).find((t) => t.name === "log_call")!;
        const r = await logCall.run(ctx(ISR, false), { lead_id: "DL-1", channel: "note" });
        expect(r.kind).toBe("declined");
        expect(findLeadInScope).not.toHaveBeenCalled();
    });
});

// ── Agent loop ──────────────────────────────────────────────────────────────

function scripted(replies: AIMessage[]): ToolCallingModel & { seen: BaseMessage[][] } {
    const seen: BaseMessage[][] = [];
    let i = 0;
    return {
        seen,
        invoke: vi.fn(async (messages: BaseMessage[]) => {
            seen.push(messages);
            return replies[Math.min(i++, replies.length - 1)];
        }),
    };
}

const call = (name: string, args: Record<string, unknown>, id = `c-${name}`) =>
    new AIMessage({ content: "", tool_calls: [{ id, name, args }] });

function fakeTool(name: string, kind: "read" | "write", result: ToolResult): ToolSpec & { run: ReturnType<typeof vi.fn> } {
    return { name: name as never, kind, description: name, schema: z.object({ lead_id: z.string().min(1) }), run: vi.fn(async () => result) };
}

describe("runAgentTurn", () => {
    const logToolCall = vi.fn<(r: ToolCallRecord) => Promise<void>>(async () => {});
    beforeEach(() => logToolCall.mockClear());

    it("runs a tool with VALIDATED args and the server's user, feeds the result back, returns the final text", async () => {
        const tool = fakeTool("get_lead_details", "read", { kind: "not_found" });
        const model = scripted([call("get_lead_details", { lead_id: "DL-1" }), new AIMessage("Couldn't find it.")]);
        const out = await runAgentTurn(
            { system: "sys", history: [], userText: "details of DL-1" },
            { model, tools: [tool], ctx: ctx(ISR), logToolCall },
        );
        expect(out.text).toBe("Couldn't find it.");
        expect(tool.run).toHaveBeenCalledWith(ctx(ISR), { lead_id: "DL-1" });
        const toolMsg = model.seen[1].at(-1) as ToolMessage;
        expect(JSON.parse(String(toolMsg.content))).toEqual({ kind: "not_found" });
        expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ userId: "isr-1", tool: "get_lead_details", ok: true }));
    });

    it("the model cannot choose the user: extra args are stripped by the schema", async () => {
        const tool = fakeTool("get_lead_details", "read", { kind: "not_found" });
        const model = scripted([call("get_lead_details", { lead_id: "DL-1", user_id: "admin-9", role: "admin" }), new AIMessage("ok")]);
        await runAgentTurn({ system: "s", history: [], userText: "x" }, { model, tools: [tool], ctx: ctx(ISR), logToolCall });
        expect(tool.run).toHaveBeenCalledWith(ctx(ISR), { lead_id: "DL-1" });
    });

    it("invalid arguments never reach the tool; unknown tools are refused", async () => {
        const tool = fakeTool("get_lead_details", "read", { kind: "not_found" });
        const model = scripted([
            new AIMessage({ content: "", tool_calls: [
                { id: "a", name: "get_lead_details", args: { lead_id: "" } },
                { id: "b", name: "run_sql", args: { q: "DROP TABLE users" } },
            ] }),
            new AIMessage("sorry"),
        ]);
        const out = await runAgentTurn({ system: "s", history: [], userText: "x" }, { model, tools: [tool], ctx: ctx(ISR), logToolCall });
        expect(tool.run).not.toHaveBeenCalled();
        expect(out.results).toEqual([]);
        expect(logToolCall.mock.calls.map((c) => c[0].error)).toEqual(["invalid_arguments", "unknown_tool"]);
    });

    it("at most ONE write per turn", async () => {
        const w1 = fakeTool("log_call", "write", { kind: "unavailable", message: "x" });
        const w2 = fakeTool("mark_lost", "write", { kind: "unavailable", message: "x" });
        const model = scripted([
            new AIMessage({ content: "", tool_calls: [
                { id: "a", name: "log_call", args: { lead_id: "DL-1" } },
                { id: "b", name: "mark_lost", args: { lead_id: "DL-2" } },
            ] }),
            new AIMessage("done"),
        ]);
        await runAgentTurn({ system: "s", history: [], userText: "x" }, { model, tools: [w1, w2], ctx: ctx(ISR), logToolCall });
        expect(w1.run).toHaveBeenCalledTimes(1);
        expect(w2.run).not.toHaveBeenCalled();
    });

    it("bounded: stops after maxModelCalls even if the model keeps calling tools", async () => {
        const tool = fakeTool("get_lead_details", "read", { kind: "not_found" });
        const model = scripted([call("get_lead_details", { lead_id: "DL-1" })]);
        const out = await runAgentTurn({ system: "s", history: [], userText: "x" }, { model, tools: [tool], ctx: ctx(ISR), logToolCall });
        expect(out.modelCalls).toBe(AGENT_LIMITS.maxModelCalls);
        expect(out.text).toMatch(/couldn't finish/i);
    });

    it("a throwing tool becomes a generic error, and the turn goes on", async () => {
        const tool = fakeTool("get_lead_details", "read", { kind: "not_found" });
        tool.run.mockRejectedValueOnce(new Error("connection reset"));
        const model = scripted([call("get_lead_details", { lead_id: "DL-1" }), new AIMessage("try later")]);
        const out = await runAgentTurn({ system: "s", history: [], userText: "x" }, { model, tools: [tool], ctx: ctx(ISR), logToolCall });
        expect(out.text).toBe("try later");
        expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: "connection reset" }));
    });

    it("INV9: a failed audit write fails the turn instead of handing an unlogged result to the model", async () => {
        const tool = fakeTool("get_lead_details", "read", { kind: "not_found" });
        const model = scripted([call("get_lead_details", { lead_id: "DL-1" }), new AIMessage("x")]);
        const failingLog = vi.fn(async () => { throw new Error("db down"); });
        await expect(
            runAgentTurn({ system: "s", history: [], userText: "x" }, { model, tools: [tool], ctx: ctx(ISR), logToolCall: failingLog }),
        ).rejects.toThrow("db down");
        expect(model.invoke).toHaveBeenCalledTimes(1);
    });

    it("the final reply is capped at 1000 characters", async () => {
        const model = scripted([new AIMessage("x".repeat(5000))]);
        const out = await runAgentTurn({ system: "s", history: [], userText: "x" }, { model, tools: [], ctx: ctx(ISR), logToolCall });
        expect([...out.text].length).toBe(AGENT_LIMITS.replyMaxChars);
    });
});

// ── Invariants 5 and 8 at the tool boundary ─────────────────────────────────

describe("sanitizeResult", () => {
    const row = (i: number) => ({
        id: `DL-${i}`, shop_name: "S", dealer_name: "D", city: null, status: null, interest: null,
        owner_name: null, owned_by_you: true, next_date: null, crm_url: `https://crm/x/${i}`,
    });

    it("INV5: never more than 10 rows", () => {
        const r = sanitizeResult({ kind: "leads", title: "t", rows: Array.from({ length: 25 }, (_, i) => row(i)), total: 25, crm_url: null });
        expect(r.kind === "leads" && r.rows.length).toBe(10);
    });

    it("INV8_no_sensitive_fields: Aadhaar / PAN / IFSC / account / DOB scrubbed; ids, links, dealer phone kept", () => {
        const r = sanitizeResult({
            kind: "lead",
            lead: {
                id: "DL-1042",
                phone: "+919812345678",
                crm_url: "https://crm.itarang.com/inside-sales/lead/DL-1042",
                remarks:
                    "Aadhaar 2345 6789 0123, PAN ABCDE1234F, a/c 123456789012345 IFSC HDFC0001234, DOB: 12/05/1980, " +
                    "call on 9812345678 or +919812345678, needs 10 batteries by 26/09",
            },
        });
        const s = JSON.stringify(r);
        for (const leaked of ["2345 6789 0123", "ABCDE1234F", "123456789012345", "HDFC0001234", "12/05/1980"]) {
            expect(s, leaked).not.toContain(leaked);
        }
        expect(s).toContain("DL-1042");
        expect(s).toContain("9812345678");
        expect(s).toContain("26/09");
        expect(s).toContain('"phone":"+919812345678"');
    });

    it("a bare 12-digit run is masked (an Aadhaar can start with 91)", () => {
        expect(redactText("id 919812345678")).toBe("id [redacted]");
        expect(redactDeep({ note: ["PAN abcde1234f"] })).toEqual({ note: ["PAN [redacted]"] });
    });
});

// ── Memory ──────────────────────────────────────────────────────────────────

describe("trimTurns", () => {
    it("keeps the last 20 human-started turns and clips long tool results", () => {
        const msgs: BaseMessage[] = [];
        for (let i = 0; i < 25; i++) {
            msgs.push(new HumanMessage(`q${i}`));
            msgs.push(new AIMessage({ content: "", tool_calls: [{ id: `t${i}`, name: "x", args: {} }] }));
            msgs.push(new ToolMessage({ tool_call_id: `t${i}`, content: "y".repeat(5000) }));
            msgs.push(new AIMessage(`a${i}`));
        }
        const kept = trimTurns(msgs);
        expect(kept.filter((m) => m.getType() === "human").length).toBe(20);
        expect(kept[0].content).toBe("q5");
        const tool = kept.find((m) => m.getType() === "tool")!;
        expect(String(tool.content).length).toBeLessThan(1600);
    });
});

// ── Prompt + config ─────────────────────────────────────────────────────────

describe("prompt and config", () => {
    it("names the user's own tabs only, and states IST now", () => {
        const p = buildSystemPrompt({ user: ASM, now: new Date("2026-09-24T12:10:00Z"), tools: ["my_queue"], writesEnabled: false });
        expect(p).toContain("Today's Schedule");
        expect(p).not.toContain("follow_ups");
        expect(p).toContain("today = 2026-09-24");
        expect(p).toContain("Changes are NOT enabled");
        expect(istNow(new Date("2026-09-24T20:00:00Z")).isoDate).toBe("2026-09-25");
    });

    it("kill switch and pilot list parse from env", () => {
        const c = assistantConfig({ ASSISTANT_DISABLED: " TRUE ", ASSISTANT_WRITES_ENABLED_USER_IDS: "a, b,,c " } as unknown as NodeJS.ProcessEnv);
        expect(c.disabled).toBe(true);
        expect([...c.writeUserIds]).toEqual(["a", "b", "c"]);
        expect(assistantConfig({} as unknown as NodeJS.ProcessEnv)).toMatchObject({ disabled: false, model: null });
        expect(assistantConfig({ ASSISTANT_WRITES_ENABLED_USER_IDS: "" } as unknown as NodeJS.ProcessEnv).writeUserIds.size).toBe(0);
    });
});
