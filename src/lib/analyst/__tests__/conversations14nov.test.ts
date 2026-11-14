import { describe, expect, it } from "vitest";

import { exportFileName, threadToMarkdown } from "../exportThread";
import { followUps } from "../followUps";
import { checkGolden, numbersInText } from "../golden";
import { GOLDEN_CASES } from "../goldenQuestions";
import { DEFAULT_STARTERS, personalStarters } from "../starters";
import { cleanTitle, mergeThreads, viewThreads, type ThreadMeta } from "../threadList";
import { withAskedThread } from "../threads";
import type { Thread } from "../types";
import {
    joinInstructions,
    normalizeSql,
    questionSimilarity,
    rankVerified,
    VERIFIED_HEAD,
    verifiedInstructions,
} from "../verified";

// ── Verified queries (E-382) ──────────────────────────────────────────────────

describe("normalizeSql", () => {
    it("ignores case, spacing, comments and a trailing semicolon", () => {
        const a = "SELECT count(*)\n  FROM dealer_leads -- all leads\n WHERE created_at >= current_date;";
        const b = "select COUNT( * ) from dealer_leads /* x */ where created_at>=CURRENT_DATE";
        expect(normalizeSql(a)).toBe(normalizeSql(b));
    });

    it("keeps string literals exactly as typed", () => {
        expect(normalizeSql("select 1 where city = 'Delhi'")).not.toBe(normalizeSql("select 1 where city = 'delhi'"));
        expect(normalizeSql("select 'a -- not a comment'")).toContain("'a -- not a comment'");
    });

    it("a different query stays different", () => {
        expect(normalizeSql("select count(*) from visits")).not.toBe(normalizeSql("select count(*) from dealer_leads"));
    });
});

describe("questionSimilarity / rankVerified", () => {
    it("the same question worded a little differently matches", () => {
        expect(questionSimilarity("How many leads came in today?", "how many leads came in today")).toBe(1);
        expect(questionSimilarity("How many leads came in today, by source?", "Leads came in today by source")).toBeGreaterThanOrEqual(0.6);
    });

    it("an unrelated question does not", () => {
        expect(questionSimilarity("Revenue this month by salesperson", "How many visits did each ASM make")).toBeLessThan(0.3);
    });

    it("ranks closest first, drops those under the threshold, keeps k", () => {
        const cands = [
            { id: "a", question: "Revenue this month by salesperson", sql: "select 1" },
            { id: "b", question: "How many leads came in today by source", sql: "select 2" },
            { id: "c", question: "How many leads came in today", sql: "select 3" },
        ];
        const got = rankVerified("How many leads came in today?", cands, 2);
        expect(got.map((m) => m.id)).toEqual(["c", "b"]);
        expect(rankVerified("dealer churn", cands)).toEqual([]);
    });
});

describe("verifiedInstructions / joinInstructions", () => {
    const m = [{ id: "a", question: "Leads today", sql: "select\n  count(*) from dealer_leads", score: 1 }];

    it("heads the block and puts the SQL on one line", () => {
        const out = verifiedInstructions(m, 10_000);
        expect(out.startsWith(VERIFIED_HEAD)).toBe(true);
        expect(out).toContain("SQL: select count(*) from dealer_leads");
    });

    it("rules always come first; the verified block only fills the room left", () => {
        expect(joinInstructions("RULES", m, 10_000).startsWith("RULES\n\n")).toBe(true);
        expect(joinInstructions("RULES", m, 20)).toBe("RULES");
        expect(joinInstructions("RULES", [], 10_000)).toBe("RULES");
        expect(joinInstructions("", m, 10_000).startsWith(VERIFIED_HEAD)).toBe(true);
    });
});

// ── Conversation list (E-381) ─────────────────────────────────────────────────

const agentThread = (id: string, title: string, at: string): Thread => ({
    thread_id: id,
    title,
    run_count: 1,
    last_run_at: at,
    last_status: "done",
    connection_id: "c1",
});

const meta = (id: string, patch: Partial<ThreadMeta> = {}): ThreadMeta => ({
    thread_id: id,
    title: "crm title",
    title_custom: false,
    questions: "q1\nq2",
    connection_id: "c1",
    run_count: 2,
    last_asked_at: "2026-11-01T00:00:00Z",
    pinned_at: null,
    archived_at: null,
    deleted_at: null,
    shared: false,
    ...patch,
});

describe("mergeThreads / viewThreads", () => {
    it("a rename wins; the agent's title stays otherwise", () => {
        const got = mergeThreads(
            [agentThread("t1", "agent one", "2026-11-10T00:00:00Z"), agentThread("t2", "agent two", "2026-11-09T00:00:00Z")],
            [meta("t1", { title: "My name", title_custom: true }), meta("t2")],
        );
        expect(got.find((t) => t.thread_id === "t1")!.title).toBe("My name");
        expect(got.find((t) => t.thread_id === "t2")!.title).toBe("agent two");
    });

    it("deleted ones go; CRM rows the agent's top 200 lost come back", () => {
        const got = mergeThreads([agentThread("t1", "one", "2026-11-10T00:00:00Z")], [meta("t1", { deleted_at: "x" }), meta("old")]);
        expect(got.map((t) => t.thread_id)).toEqual(["old"]);
    });

    it("pinned first, then newest; archived only in their own view; search reads questions too", () => {
        const all = mergeThreads(
            [
                agentThread("new", "newest", "2026-11-12T00:00:00Z"),
                agentThread("pin", "pinned one", "2026-11-01T00:00:00Z"),
                agentThread("arc", "archived one", "2026-11-11T00:00:00Z"),
            ],
            [
                meta("pin", { pinned_at: "2026-11-02T00:00:00Z", last_asked_at: "2026-11-01T00:00:00Z", questions: "visits by ASM" }),
                meta("arc", { archived_at: "2026-11-12T00:00:00Z" }),
            ],
        );
        expect(viewThreads(all, "active").map((t) => t.thread_id)).toEqual(["pin", "new"]);
        expect(viewThreads(all, "archived").map((t) => t.thread_id)).toEqual(["arc"]);
        expect(viewThreads(all, "active", "ASM visits").map((t) => t.thread_id)).toEqual(["pin"]);
        expect(viewThreads(all, "active", "nothing like this")).toEqual([]);
    });

    it("asking in a conversation moves it to the top and out of the archive", () => {
        const list = mergeThreads([agentThread("a", "A", "2026-11-01T00:00:00Z")], [meta("a", { archived_at: "x" })]);
        const next = withAskedThread(list, { threadId: "a", question: "again", connectionId: "c1", at: "2026-11-14T00:00:00Z" });
        expect(next[0].archived).toBe(false);
        expect(next[0].run_count).toBe(2);
        const fresh = withAskedThread(next, { threadId: "b", question: "new q", connectionId: "c1", at: "2026-11-14T01:00:00Z" });
        expect(fresh[0]).toMatchObject({ thread_id: "b", title: "new q", pinned: false, archived: false });
    });

    it("cleanTitle: one line, at most 120 characters", () => {
        expect(cleanTitle("  a\n  b  ")).toBe("a b");
        expect(cleanTitle("x".repeat(200))).toHaveLength(120);
    });
});

// ── Follow-ups (item 6) ───────────────────────────────────────────────────────

describe("followUps", () => {
    it("today → yesterday, split by salesperson, show the leads", () => {
        const got = followUps("How many leads came in today?");
        expect(got.map((f) => f.label)).toEqual(["Same for yesterday", "Split by salesperson", "Show the leads"]);
        expect(got[0].question).toBe("How many leads came in yesterday?");
    });

    it("does not offer a split that is already there", () => {
        const got = followUps("How many visits did each ASM make this week?");
        expect(got.map((f) => f.label)).not.toContain("Split by salesperson");
        expect(got[0]).toEqual({ label: "Same for last week", question: "How many visits did each ASM make last week?" });
        expect(followUps("Revenue this month", ["salesperson", "revenue"]).map((f) => f.label)).not.toContain(
            "Split by salesperson",
        );
    });

    it("no period → this month; revenue → compare with last month; at most 3", () => {
        const got = followUps("Total revenue by dealer");
        expect(got).toHaveLength(3);
        expect(got[0].label).toBe("Same for this month");
        expect(got.map((f) => f.label)).toContain("Compare with last month");
    });

    it("nothing for an empty question", () => {
        expect(followUps("  ")).toEqual([]);
    });
});

// ── Starter questions (item 12) ───────────────────────────────────────────────

describe("personalStarters", () => {
    it("a new user gets the defaults", () => {
        expect(personalStarters([]).map((s) => s.question)).toEqual(DEFAULT_STARTERS);
        expect(personalStarters([]).every((s) => !s.personal)).toBe(true);
    });

    it("the most-asked come first, repeats folded, one default always left", () => {
        const asked = [
            "Revenue today by salesperson?",
            "How many visits did Rohit make this week",
            "revenue today by salesperson",
            "Show overdue receivables",
            "Leads from Delhi this month",
        ];
        const got = personalStarters(asked);
        expect(got).toHaveLength(4);
        expect(got[0]).toEqual({ question: "Revenue today by salesperson?", personal: true });
        expect(got.filter((s) => s.personal)).toHaveLength(3);
        expect(got[3].personal).toBe(false);
    });

    it("a personal question that is also a default is not shown twice", () => {
        const got = personalStarters([DEFAULT_STARTERS[0]]);
        expect(got.map((s) => s.question).filter((q) => q === DEFAULT_STARTERS[0])).toHaveLength(1);
    });
});

// ── Export (item 13) ──────────────────────────────────────────────────────────

describe("threadToMarkdown", () => {
    it("writes each question, answer and query", () => {
        const md = threadToMarkdown({
            title: "Leads",
            exportedAt: new Date("2026-11-14T06:00:00Z"),
            runs: [
                { question: "How many leads today?", answer: "**12** leads.", error: null, sql: "select 12", created_at: "2026-11-14T05:00:00Z", verified: true },
                { question: "And yesterday?", answer: null, error: "timeout", sql: null, created_at: "2026-11-14T05:10:00Z" },
            ],
        });
        expect(md).toContain("# Leads");
        expect(md).toContain("## 1. How many leads today?");
        expect(md).toContain("Verified query");
        expect(md).toContain("```sql\nselect 12\n```");
        expect(md).toContain("The analyst could not answer: timeout");
        expect(md).toContain("2 questions");
    });

    it("file names are safe", () => {
        expect(exportFileName("Revenue: this month vs last?")).toBe("revenue-this-month-vs-last.md");
        expect(exportFileName("₹₹")).toBe("analyst-conversation.md");
    });
});

// ── Golden suite check (item 2) ───────────────────────────────────────────────

describe("golden suite", () => {
    it("has 20 distinct questions, each returning n", () => {
        expect(GOLDEN_CASES).toHaveLength(20);
        expect(new Set(GOLDEN_CASES.map((c) => c.id)).size).toBe(20);
        expect(new Set(GOLDEN_CASES.map((c) => c.question)).size).toBe(20);
        for (const c of GOLDEN_CASES) expect(c.sql).toMatch(/\bAS n\b/);
    });

    it("reads Indian money and lakh / crore", () => {
        expect(numbersInText("₹1,29,56,251 this month")).toContain(12956251);
        expect(numbersInText("about 1.3 crore")).toContain(13000000);
    });

    it("passes when every figure is in the rows or the answer", () => {
        expect(checkGolden([14], [["Sonu", 14]], "").pass).toBe(true);
        expect(checkGolden([14, 3], [["Sonu", "14"]], "and 3 more").pass).toBe(true);
        expect(checkGolden([14], [["Sonu", 13]], "13 visits")).toMatchObject({ pass: false, missing: [14] });
    });

    it("money tolerance, and a zero with no rows", () => {
        expect(checkGolden([12956251], [], "Revenue was ₹1,29,56,000", 0.005).pass).toBe(true);
        expect(checkGolden([0], [], "No visits found.")).toMatchObject({ pass: true, weak: true });
    });
});

describe("golden suite: nothing in the period", () => {
    it("an empty reference passes only when the agent found nothing too", () => {
        expect(checkGolden([], [], "No leads this month.")).toMatchObject({ pass: true, weak: true });
        expect(checkGolden([], [["x", 5]], "5 leads")).toMatchObject({ pass: false });
    });
});
