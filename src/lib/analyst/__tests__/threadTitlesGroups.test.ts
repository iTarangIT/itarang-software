// 251 items 15 and 19 (10 Nov change list): short titles and date groups in the conversation list.
import { describe, expect, it } from "vitest";

import { dateGroup, groupByDate, mergeThreads, shortTitle, type ListThread } from "../threadList";

const TEN_NOV = "2026-11-10T09:30:00Z"; // 3:00 pm IST, 10 Nov

describe("shortTitle", () => {
    it("keeps the subject words and dates the conversation", () => {
        expect(shortTitle("how many visits did Biplab made today?", TEN_NOV)).toBe("Visits Biplab, 10 Nov");
        expect(shortTitle("How many files are financed?", TEN_NOV)).toBe("Files financed, 10 Nov");
    });

    it("stops at four words or about 32 characters", () => {
        const t = shortTitle("revenue against target split by every salesperson and region this quarter", TEN_NOV);
        expect(t.split(",")[0]!.split(" ").length).toBeLessThanOrEqual(4);
        expect(t.split(",")[0]!.length).toBeLessThanOrEqual(32);
    });

    it("falls back to the question when only filler is left, and works without a date", () => {
        expect(shortTitle("how many?", TEN_NOV)).toBe("how many?");
        expect(shortTitle("Hot leads in Lucknow")).toBe("Hot leads Lucknow");
    });
});

describe("dateGroup / groupByDate", () => {
    const now = new Date("2026-11-14T06:00:00Z"); // 11:30 am IST, 14 Nov
    it("uses IST calendar days", () => {
        expect(dateGroup("2026-11-14T00:10:00Z", now)).toBe("Today");
        expect(dateGroup("2026-11-13T19:00:00Z", now)).toBe("Today"); // 00:30 IST on 14 Nov
        expect(dateGroup("2026-11-13T10:00:00Z", now)).toBe("Yesterday");
        expect(dateGroup("2026-11-08T10:00:00Z", now)).toBe("Last 7 days");
        expect(dateGroup("2026-11-01T10:00:00Z", now)).toBe("Older");
        expect(dateGroup(null, now)).toBe("Older");
    });

    it("groups in order and leaves out empty groups", () => {
        const t = (id: string, at: string) => ({ thread_id: id, last_run_at: at }) as ListThread;
        const groups = groupByDate([t("a", "2026-11-14T05:00:00Z"), t("b", "2026-11-01T05:00:00Z"), t("c", "2026-11-14T01:00:00Z")], now);
        expect(groups.map((g) => [g.label, g.threads.map((x) => x.thread_id)])).toEqual([
            ["Today", ["a", "c"]],
            ["Older", ["b"]],
        ]);
    });
});

describe("mergeThreads titles", () => {
    it("a renamed conversation keeps its name; others get the short title, the question on hover", () => {
        const agent = [
            { thread_id: "crm.u.1", title: "how many visits did Biplab made today?", run_count: 1, last_run_at: TEN_NOV, last_status: "done", connection_id: "c" },
            { thread_id: "crm.u.2", title: "leads today", run_count: 1, last_run_at: TEN_NOV, last_status: "done", connection_id: "c" },
        ];
        const meta = [
            {
                thread_id: "crm.u.2",
                title: "My leads check",
                title_custom: true,
                questions: "leads today",
                connection_id: "c",
                run_count: 1,
                last_asked_at: TEN_NOV,
                pinned_at: null,
                archived_at: null,
                deleted_at: null,
                shared: false,
                created_at: TEN_NOV,
            },
        ];
        const got = mergeThreads(agent as never, meta);
        expect(got.find((x) => x.thread_id === "crm.u.1")).toMatchObject({ title: "Visits Biplab, 10 Nov", full_title: agent[0]!.title });
        expect(got.find((x) => x.thread_id === "crm.u.2")!.title).toBe("My leads check");
    });
});
