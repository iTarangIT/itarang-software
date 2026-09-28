import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/db", () => ({ db: {} }));

const { toolsFor } = await import("../registry");

// Gemini's function declarations accept only an OpenAPI subset. One tool
// schema it cannot read 400s the WHOLE turn for every message — typed or voice
// — for every user that tool is bound for (create_quote's .positive() did
// exactly that on sandbox, 2026-09-28). Zod emits these keys for
// .positive() / .negative() / .gt() / .lt(); use .min(1) / .max() instead.
const REJECTED_BY_GEMINI = ["exclusiveMinimum", "exclusiveMaximum"];

function badKeys(node: unknown, path: string, out: string[]) {
    if (Array.isArray(node)) {
        node.forEach((v, i) => badKeys(v, `${path}[${i}]`, out));
    } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
            if (REJECTED_BY_GEMINI.includes(k)) out.push(`${path}.${k}`);
            badKeys(v, `${path}.${k}`, out);
        }
    }
}

describe("every tool schema is one Gemini accepts", () => {
    for (const role of ["asm", "inside_sales_rep"] as const) {
        it(`${role}, writes on: no exclusiveMinimum / exclusiveMaximum anywhere`, () => {
            const tools = toolsFor(role, true);
            expect(tools.length).toBeGreaterThan(10);
            const found: string[] = [];
            for (const t of tools) badKeys(z.toJSONSchema(t.schema as z.ZodType), t.name, found);
            expect(found).toEqual([]);
        });
    }
});
