import { describe, expect, it } from "vitest";
import {
    addImportSync,
    clampSyncFrom,
    IMPORT_SYNC_BATCH,
    runImportSyncBatch,
    tallyImportSync,
    type ImportSyncOutcome,
} from "../importSync";

// No Ecofy here: `one` is a fake that records which cases were looked up.
const cases = (n: number) => Array.from({ length: n }, (_, i) => `ECF-${i + 1}`);

async function runAll(total: number, opts: { batch?: number; deadlineAfterGroups?: number } = {}) {
    const caseNos = cases(total);
    const seen: string[] = [];
    let from = 0;
    let runs = 0;
    let sum = null as ReturnType<typeof tallyImportSync> | null;
    for (;;) {
        runs++;
        let groups = 0;
        const outcomes = await runImportSyncBatch({
            caseNos,
            from,
            batch: opts.batch,
            concurrency: 4,
            // Fake clock: "past the deadline" after N groups of this run.
            deadline: opts.deadlineAfterGroups == null ? undefined : 0,
            now: () => (groups++ >= (opts.deadlineAfterGroups ?? 0) ? 1 : -1),
            one: async (c): Promise<ImportSyncOutcome> => {
                seen.push(c);
                return "added";
            },
        });
        const r = tallyImportSync({ importId: "i", status: "COMMITTED", reportRows: total, cases: total, from }, outcomes);
        sum = addImportSync(sum, r);
        if (r.nextFrom == null) break;
        expect(r.nextFrom).toBeGreaterThan(from);
        from = r.nextFrom;
        if (runs > 100) throw new Error("no progress");
    }
    return { seen, runs, sum: sum! };
}

describe("ID 51 — import sync brings in ALL cases, a batch per run", () => {
    it("1,250 cases: three runs of at most 500, every case once, none repeated", async () => {
        const { seen, runs, sum } = await runAll(1250);
        expect(IMPORT_SYNC_BATCH).toBe(500);
        expect(runs).toBe(3);
        expect(seen).toHaveLength(1250);
        expect(new Set(seen).size).toBe(1250);
        expect(seen[0]).toBe("ECF-1");
        expect(seen[1249]).toBe("ECF-1250");
        expect(sum).toMatchObject({ cases: 1250, checked: 1250, added: 1250, from: 0, nextFrom: null });
    });

    it("a run cut short by the time budget continues where it stopped", async () => {
        // Each run gets 2 groups of 4 before the clock says stop.
        const { seen, runs } = await runAll(30, { deadlineAfterGroups: 1 });
        expect(new Set(seen).size).toBe(30);
        expect(seen).toHaveLength(30);
        expect(runs).toBe(4); // 8 + 8 + 8 + 6
    });

    it("500 or fewer cases finish in one run", async () => {
        const { runs, sum } = await runAll(500);
        expect(runs).toBe(1);
        expect(sum.nextFrom).toBeNull();
    });

    it("an import with no cases reports done", async () => {
        const r = tallyImportSync({ importId: "i", status: "COMMITTED", reportRows: 0, cases: 0 }, []);
        expect(r).toMatchObject({ checked: 0, from: 0, nextFrom: null });
    });

    it("clamps a bad cursor", () => {
        expect(clampSyncFrom(undefined, 10)).toBe(0);
        expect(clampSyncFrom(-5, 10)).toBe(0);
        expect(clampSyncFrom(3.7, 10)).toBe(3);
        expect(clampSyncFrom(99, 10)).toBe(10);
        expect(clampSyncFrom("7", 10)).toBe(0);
    });
});
