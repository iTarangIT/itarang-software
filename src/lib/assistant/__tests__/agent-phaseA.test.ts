// Round 2, Phase A — the turn never hides or misstates a correct answer:
// stop causes instead of a canned Sorry, a tool-less last call, the deadline
// between tool calls, the one-write "Next:", memory that keeps lists, and the
// user's words surviving every clip.
import { describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";

vi.mock("@/lib/db", () => ({ db: { execute: vi.fn(async () => []) } }));

const { runAgentTurn, withSpeakOnlyCall, AGENT_LIMITS } = await import("../agent");
const { trimTurns, compactToolContent, TOOL_MESSAGE_MAX_CHARS } = await import("../memory");
const { composeUserText } = await import("../turn");
const { editRequestText, EDIT_CONTEXT_MAX_CHARS } = await import("../edit");
const { readTimeoutMs } = await import("../vision");
const { buildSystemPrompt } = await import("../prompt");
import type { AssistantUser, ToolContext, ToolResult } from "../types";
import type { ToolSpec } from "../tools/spec";
import type { ToolCallingModel } from "../agent";

const ISR: AssistantUser = { id: "isr-1", name: "Priya", role: "inside_sales_rep" };
const ASM: AssistantUser = { id: "asm-1", name: "Rahul", role: "asm" };
const ctx: ToolContext = { user: ISR, messageId: "m1", now: new Date("2026-10-15T06:00:00Z"), writesEnabled: true };
const logToolCall = vi.fn(async () => {});

/** A scripted model that records whether each call was offered tools. */
function scripted(replies: AIMessage[]) {
    const noTools: boolean[] = [];
    let i = 0;
    const model: ToolCallingModel = {
        invoke: vi.fn(async (_m: BaseMessage[], opts?: { noTools?: boolean }) => {
            noTools.push(opts?.noTools === true);
            return replies[Math.min(i++, replies.length - 1)];
        }),
    };
    return { model, noTools };
}

const call = (name: string, args: Record<string, unknown>, id = `c-${name}`) =>
    new AIMessage({ content: "", tool_calls: [{ id, name, args }] });

function fakeTool(name: string, kind: "read" | "write", result: ToolResult): ToolSpec & { run: ReturnType<typeof vi.fn> } {
    return { name: name as never, kind, description: name, schema: z.object({ lead_id: z.string().min(1) }), run: vi.fn(async () => result) };
}

describe("agent loop", () => {
    it("maxModelCalls is 6, and only the LAST call is offered no tools", async () => {
        expect(AGENT_LIMITS.maxModelCalls).toBe(6);
        const tool = fakeTool("get_lead_details", "read", { kind: "not_found" });
        const { model, noTools } = scripted([call("get_lead_details", { lead_id: "DL-1" })]);
        const out = await runAgentTurn({ system: "s", history: [], userText: "x" }, { model, tools: [tool], ctx, logToolCall });
        expect(noTools).toEqual([false, false, false, false, false, true]);
        expect(out).toMatchObject({ text: "", stop: "cap", modelCalls: 6 });
    });

    it("production models: noTools binds the same tools with tool_choice 'none' (declared, not callable)", async () => {
        const bound: { kwargs?: Record<string, unknown>; invoke: ReturnType<typeof vi.fn> }[] = [];
        const chat = {
            bindTools: (_t: unknown[], kwargs?: Record<string, unknown>) => {
                const b = { kwargs, invoke: vi.fn(async () => new AIMessage("ok")) };
                bound.push(b);
                return b;
            },
        };
        const m = withSpeakOnlyCall(chat, [fakeTool("my_queue", "read", { kind: "not_found" })]);
        await m.invoke([], {});
        await m.invoke([], { noTools: true });
        expect(bound[0].kwargs).toBeUndefined();
        expect(bound[0].invoke).toHaveBeenCalledTimes(1);
        expect(bound[1].kwargs).toEqual({ tool_choice: "none" });
        expect(bound[1].invoke).toHaveBeenCalledTimes(1);
    });

    it("a 5-tool-step flow (quote revision / document) still gets its reply on call 6", async () => {
        const tool = fakeTool("quote_status", "read", { kind: "not_found" });
        const steps = Array.from({ length: 5 }, (_, i) => call("quote_status", { lead_id: "DL-1" }, `c${i}`));
        const { model, noTools } = scripted([...steps, new AIMessage("Quote v2 is approved.")]);
        const out = await runAgentTurn({ system: "s", history: [], userText: "x" }, { model, tools: [tool], ctx, logToolCall });
        expect(out).toMatchObject({ text: "Quote v2 is approved.", stop: "done", modelCalls: 6 });
        expect(noTools.at(-1)).toBe(true);
    });

    it("an empty reply is stop 'empty', text '' — and no empty AI message is stored", async () => {
        const { model } = scripted([new AIMessage("  ")]);
        const out = await runAgentTurn({ system: "s", history: [], userText: "x" }, { model, tools: [], ctx, logToolCall });
        expect(out).toMatchObject({ text: "", stop: "empty" });
        const last = out.turnMessages.at(-1)!;
        expect(last.getType()).toBe("ai");
        expect(String(last.content).trim().length).toBeGreaterThan(0);
    });

    it("tools get the turn's deadline; tool calls queued after it are skipped but still answered (valid pairing)", async () => {
        let now = 1_000_000;
        const clock = () => now;
        const slow = fakeTool("get_lead_details", "read", { kind: "not_found" });
        slow.run.mockImplementation(async () => {
            now += AGENT_LIMITS.turnTimeoutMs + 1; // this tool eats the whole budget
            return { kind: "not_found" };
        });
        const second = fakeTool("search_lead", "read", { kind: "not_found" });
        const both = new AIMessage({
            content: "",
            tool_calls: [
                { id: "a", name: "get_lead_details", args: { lead_id: "DL-1" } },
                { id: "b", name: "search_lead", args: { lead_id: "DL-2" } },
            ],
        });
        const { model } = scripted([both, new AIMessage("never")]);
        const out = await runAgentTurn({ system: "s", history: [], userText: "x" }, { model, tools: [slow, second], ctx, logToolCall, clock });
        expect(slow.run).toHaveBeenCalledWith({ ...ctx, deadline: 1_000_000 + AGENT_LIMITS.turnTimeoutMs }, { lead_id: "DL-1" });
        expect(second.run).not.toHaveBeenCalled();
        const toolMsgs = out.turnMessages.filter((m) => m.getType() === "tool") as ToolMessage[];
        expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(["a", "b"]);
        expect(String(toolMsgs[1].content)).toContain("Skipped");
        expect(out).toMatchObject({ text: "", stop: "timeout", modelCalls: 1 });
        expect(out.results).toEqual([{ tool: "get_lead_details", result: { kind: "not_found" } }]);
    });

    it("a second write held back by the one-change limit → 'Next: …' for the card, and the args in history", async () => {
        const preview: ToolResult = {
            kind: "preview",
            action_id: "act-1",
            preview: { title: "Log call", lines: [], resets_idle_clock: true, warning: null, needs_second_confirm: false, crm_url: "u" },
        };
        const w1 = fakeTool("log_call", "write", preview);
        const w2 = fakeTool("mark_lost", "write", { kind: "unavailable", message: "x" });
        const two = new AIMessage({
            content: "",
            tool_calls: [
                { id: "a", name: "log_call", args: { lead_id: "DL-1" } },
                { id: "b", name: "mark_lost", args: { lead_id: "DL-1" } },
            ],
        });
        const { model } = scripted([two]);
        const out = await runAgentTurn({ system: "s", history: [], userText: "x" }, { model, tools: [w1, w2], ctx, logToolCall });
        expect(w2.run).not.toHaveBeenCalled();
        expect(out.stop).toBe("done");
        expect(out.next).toMatch(/^Next: mark lost/);
        const closing = String(out.turnMessages.at(-1)!.content);
        expect(closing).toContain("Tap Confirm to save.");
        expect(closing).toContain('mark_lost {"lead_id":"DL-1"}');
    });
});

describe("memory keeps what matters", () => {
    const row = (i: number) => ({
        id: `DL-${i}`, shop_name: `Shop ${i}`, dealer_name: "Dealer name that is long", city: "Kanpur", status: "Under_Discussion",
        interest: "hot", phone: `98765432${String(i).padStart(2, "0")}`, last_activity_at: "2026-10-01T00:00:00Z",
        owner_name: "Owner", owned_by_you: true, next_date: null, crm_url: `https://crm.itarang.com/inside-sales/lead/DL-${i}`,
    });

    it("a 10-row list is compacted (id / shop / city / phone), never cut mid-list — so 'teesre wale' still resolves", () => {
        const list = JSON.stringify({ kind: "leads", title: "My Open", rows: Array.from({ length: 10 }, (_, i) => row(i)), total: 37, crm_url: "u" });
        expect(list.length).toBeGreaterThan(TOOL_MESSAGE_MAX_CHARS);
        const kept = trimTurns([
            new HumanMessage("mere leads"),
            new AIMessage({ content: "", tool_calls: [{ id: "t", name: "my_queue", args: {} }] }),
            new ToolMessage({ tool_call_id: "t", content: list }),
            new AIMessage("37 leads"),
        ]);
        const stored = JSON.parse(String(kept[2].content));
        expect(stored).toMatchObject({ kind: "leads", title: "My Open", total: 37 });
        expect(stored.rows).toHaveLength(10);
        expect(stored.rows[2]).toEqual({ id: "DL-2", shop_name: "Shop 2", city: "Kanpur", phone: "9876543202" });
        expect((kept[2] as ToolMessage).tool_call_id).toBe("t");
    });

    it("candidates keep their question; reports their total; other results are untouched", () => {
        const c = JSON.parse(compactToolContent(JSON.stringify({ kind: "candidates", question: "Which?", rows: [row(1)] })));
        expect(c).toEqual({ kind: "candidates", question: "Which?", rows: [{ id: "DL-1", shop_name: "Shop 1", city: "Kanpur", phone: "9876543201" }] });
        const r = JSON.parse(compactToolContent(JSON.stringify({ kind: "lead_report", title: "Hot leads", definition: "d", rows: [{ ...row(1), age_days: 3 }], total: 9, crm_url: null })));
        expect(r).toMatchObject({ kind: "lead_report", title: "Hot leads", total: 9 });
        const lead = JSON.stringify({ kind: "lead", lead: { id: "x" } });
        expect(compactToolContent(lead)).toBe(lead);
        expect(compactToolContent("not json")).toBe("not json");
    });

    it("a quote result is kept whole (a revision re-sends every line)", () => {
        const quote = JSON.stringify({ kind: "quote", quote: { lines: Array.from({ length: 60 }, (_, i) => ({ product_id: `p${i}`, qty: i, unit_price: 1000 + i })) } });
        expect(quote.length).toBeGreaterThan(TOOL_MESSAGE_MAX_CHARS);
        const kept = trimTurns([new HumanMessage("q"), new AIMessage({ content: "", tool_calls: [{ id: "t", name: "quote_status", args: {} }] }), new ToolMessage({ tool_call_id: "t", content: quote })]);
        expect(String(kept[2].content)).toBe(quote);
    });
});

describe("the user's words survive clipping", () => {
    it("composeUserText cuts the attachments block, never the words", () => {
        const words = "visit done at Sharma Battery, demo diya";
        const out = composeUserText("[Attachments …] " + "m7k2q9 photo ".repeat(400), words, 2000);
        expect(out.endsWith(`\n${words}`)).toBe(true);
        expect([...out].length).toBeLessThanOrEqual(2000);
        expect(composeUserText(null, words)).toBe(words);
    });

    it("an [EDIT] message puts the change first and caps the card's details", () => {
        const text = editRequestText(
            { tool: "create_quote", lead_id: "DL-1", preview: { title: "Quote", lines: [], resets_idle_clock: false, warning: null, needs_second_confirm: false, crm_url: "u" }, input: { lines: "x".repeat(5000) } },
            "price 5200 karo",
        );
        expect(text.startsWith("[EDIT] The user's change: price 5200 karo\n")).toBe(true);
        expect([...text].length).toBeLessThanOrEqual(`[EDIT] The user's change: price 5200 karo\n`.length + EDIT_CONTEXT_MAX_CHARS);
    });
});

describe("read_document budget", () => {
    it("vision timeout = min(25 s, what is left of the turn − 8 s)", () => {
        expect(readTimeoutMs({})).toBe(25_000);
        expect(readTimeoutMs({ deadline: 100_000, clock: () => 50_000 })).toBe(25_000);
        expect(readTimeoutMs({ deadline: 100_000, clock: () => 80_000 })).toBe(12_000);
        expect(readTimeoutMs({ deadline: 100_000, clock: () => 95_000 })).toBeLessThan(0);
    });
});

describe("prompt matches the tools", () => {
    const now = new Date("2026-10-15T06:00:00Z");
    const tools = ["my_queue" as const];

    it("lists only the own tabs, and says the pool is claimed by phone, not browsed", () => {
        const isr = buildSystemPrompt({ user: ISR, now, tools, writesEnabled: true });
        expect(isr).toMatch(/THE USER'S QUEUE TABS: my_open .*follow_ups .*my_closed /);
        expect(isr).toMatch(/can't be browsed here: a lead from the pool is claimed by its exact phone number with claim_lead/);
        const asm = buildSystemPrompt({ user: ASM, now, tools, writesEnabled: true });
        expect(asm).toMatch(/THE USER'S QUEUE TABS: my_visits .*today .*my_closed /);
        expect(asm).toContain('"Unclaimed in my territory"');
    });

    it("rule 14 is role-specific; stale results are re-fetched; visit captions skip read_document; ASM follow-up kinds", () => {
        const asm = buildSystemPrompt({ user: ASM, now, tools, writesEnabled: true });
        const isr = buildSystemPrompt({ user: ISR, now, tools, writesEnabled: true });
        expect(asm).toContain("Any hand-off — to another ASM, or back to inside sales — = reassign_lead.");
        expect(isr).toContain("Handing a lead to an ASM = transfer_to_asm");
        for (const p of [asm, isr]) {
            expect(p).toMatch(/may be out of date .* call the tool again/);
            expect(p).toMatch(/visit or demo .*log_visit directly, no read_document/);
        }
        expect(asm).toMatch(/"call back".* = kind "call" with follow_up_at \(the date AND the time, \+05:30\).*"visit kal".* = kind "visit" with visit_date/);
        expect(asm).toContain("offer escalate_lead");
        for (const p of [asm, isr]) {
            expect(p).toMatch(/channel "whatsapp" always needs remarks/);
            expect(p).toMatch(/Onboarding Done\) only logs the call; after Confirm, offer mark_converted/);
            expect(p).toMatch(/onboarding_fee .*batteries_per_month and finance_files_per_month/);
            expect(p).not.toContain("customer_finance");
        }
        expect(isr).not.toContain('kind "call"');
    });
});
