import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/db", () => ({ db: {} }));
const { toolsFor } = await import("../registry");

// The 20-question English + Hinglish smoke set per role (Gate 3). This test
// keeps the fixtures honest: every expected tool exists for that role and
// every expected argument is valid for its schema. The REAL-model run is
// scripts/wa-assistant-smoke.ts.

type Fixture = {
    role: "asm" | "inside_sales_rep";
    questions: { q: string; expect: string[]; args?: Record<string, unknown>; allowNoTool?: boolean }[];
};

const load = (f: string): Fixture =>
    JSON.parse(readFileSync(join(__dirname, "fixtures", f), "utf8")) as Fixture;

for (const file of ["smoke-isr.json", "smoke-asm.json"]) {
    describe(`smoke fixtures: ${file}`, () => {
        const fx = load(file);
        const tools = toolsFor(fx.role, false);

        it("has 20 questions, English and Hinglish", () => {
            expect(fx.questions).toHaveLength(20);
            expect(fx.questions.some((q) => /\b(hai|hain|dikhao|kitne|mera|mere|aaj|ka|ki|ke)\b/i.test(q.q))).toBe(true);
        });

        it("every expected tool is a READ tool this role has, and its args validate", () => {
            for (const q of fx.questions) {
                for (const name of q.expect) {
                    const spec = tools.find((t) => t.name === name);
                    expect(spec, `${q.q} → ${name}`).toBeDefined();
                    if (q.args) {
                        const base = name === "search_lead" ? { query: "x y" } : name === "get_lead_details" ? { lead_id: "DL-1" } : {};
                        expect(spec!.schema.safeParse({ ...base, ...q.args }).success, `${q.q} args`).toBe(true);
                    }
                }
            }
        });
    });
}
