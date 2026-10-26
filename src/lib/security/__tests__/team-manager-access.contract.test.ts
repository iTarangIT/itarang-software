/**
 * Tracker ID 155 (decided 12 Oct): a manager SEES their team's leads and may
 * REASSIGN them within the team with a reason — they may NOT edit them.
 *
 * Source-text contract (the routes import the database and cannot be loaded
 * here), like lead-ownership.contract.test.ts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry !== "__tests__" && entry !== "node_modules") walk(full, out);
        } else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
}

const code = (file: string) =>
    readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

/** Every `canEditLead({ ... })` argument object in the source tree. */
function canEditCalls(): Array<{ file: string; arg: string }> {
    const out: Array<{ file: string; arg: string }> = [];
    for (const file of walk(SRC)) {
        const src = code(file);
        const re = /canEditLead\s*\(\s*\{/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
            let depth = 1;
            let i = m.index + m[0].length;
            for (; i < src.length && depth > 0; i++) {
                if (src[i] === "{") depth++;
                else if (src[i] === "}") depth--;
            }
            out.push({ file, arg: src.slice(m.index, i) });
        }
    }
    return out;
}

describe("a manager may not edit a team member's lead (ID 155)", () => {
    it("no canEditLead call passes a team", () => {
        const calls = canEditCalls();
        expect(calls.length, "expected the edit page, PATCH and the list to call canEditLead").toBeGreaterThanOrEqual(3);
        for (const c of calls) {
            expect(c.arg, c.file).not.toMatch(/team/i);
        }
    });

    it("canEditLead itself takes no team input", () => {
        const access = code(join(SRC, "lib", "leads", "access.ts"));
        const fn = access.slice(access.search(/export function canEditLead/));
        const sig = fn.slice(0, fn.indexOf("): boolean"));
        expect(sig.length).toBeGreaterThan(0);
        expect(sig).not.toMatch(/team/i);
    });
});

describe("reassign within the team needs a reason and logs like any owner change (ID 155)", () => {
    const route = code(join(SRC, "app", "api", "inside-sales", "lead", "[id]", "reassign", "route.ts"));
    const post = route.slice(route.search(/export const POST/), route.search(/export const GET/));

    it("checks the trimmed reason before any move", () => {
        const reasonAt = post.search(/checkReassignReason\s*\(/);
        const moveAt = post.search(/reassignLead\s*\(/);
        expect(reasonAt).toBeGreaterThan(-1);
        expect(moveAt).toBeGreaterThan(-1);
        expect(reasonAt).toBeLessThan(moveAt);
    });

    it("the manager path goes through checkTeamReassign and the shared reassignLead (ownership_transfer touchpoint)", () => {
        expect(post).toMatch(/checkTeamReassign\s*\(/);
        expect(post.match(/reassignLead\s*\(/g)?.length).toBe(2);
        expect(post).toMatch(/fromOwnerId:/);
        const lib = code(join(SRC, "lib", "leads", "reassign.ts"));
        expect(lib).toMatch(/touchpointType:\s*"ownership_transfer"/);
        expect(lib).toMatch(/remarks:\s*input\.reason/);
    });
});

describe("a manager's own-rows Data downloads carry his team (ID 155, 22 Oct)", () => {
    // Raw text: the registry holds strings with "/*" that the comment stripper would eat across.
    const reg = readFileSync(join(SRC, "lib", "exports", "datasets", "registry.ts"), "utf8");
    const route = code(join(SRC, "app", "api", "admin", "data-downloads", "[dataset]", "route.ts"));

    it("the route loads today's team for an own-rows role", () => {
        expect(route).toMatch(/access\.ownOnly \? await getTeamMemberIds\(user\.id\) : \[\]/);
        expect(route).toMatch(/ownOnly: access\.ownOnly, teamIds/);
    });

    it("calls, visits, quotes and targets use the team clause, not `= me`", () => {
        for (const col of ["t.performed_by", "v.asm_id", "c.created_by", "t.user_id"]) {
            expect(reg.includes("ownRows(ctx, sql`" + col + "`)"), col).toBe(true);
            expect(reg.includes("sql`" + col + " = ${ctx.user.id}`"), col).toBe(false);
        }
    });

    it("the Leads download passes the team to the list filters", () => {
        expect(reg).toMatch(/parseLeadListFilters\(leadParams\(ctx\), capabilitiesFor\(ctx\.user\.role\), \{ \.\.\.ctx\.user, teamMemberIds: ctx\.teamIds \}\)/);
    });
});
