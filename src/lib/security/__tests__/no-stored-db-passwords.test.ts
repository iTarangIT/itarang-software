// ID 225 guard: no database or login password is written into the code.
//
// Found 3 Nov: the live database's admin password sat in two audit scripts, an
// old RDS password in five migration scripts, and real people's login
// passwords in two seed scripts. They now come from the environment; this
// test keeps a new one from creeping back in. It reads source text only.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const SCAN_DIRS = ["scripts", "src", "docs", "n8n-workflows"];
const SKIP_DIRS = new Set(["node_modules", ".next", "reports", "__snapshots__"]);
const EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|md|sh|py|sql|json|ya?ml)$/;

function walk(dir: string, out: string[]): string[] {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of names) {
        if (SKIP_DIRS.has(name)) continue;
        const full = path.join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (EXTENSIONS.test(name) && st.size < 2_000_000) out.push(full);
    }
    return out;
}

/** A password in a connection string that is clearly a placeholder, not a secret. */
function isPlaceholderPassword(pw: string): boolean {
    if (/^[<[{]/.test(pw) || pw.includes("${") || pw.includes("...") || /^\*+$/.test(pw)) return true;
    if (/^(x+|stub|pass|password|secret|changeme|your[-_]?password)$/i.test(pw)) return true;
    return /^[A-Z][A-Z0-9_]*$/.test(pw); // an env-var name such as DB_PASSWORD
}

const URL_WITH_PASSWORD = /postgres(?:ql)?:\/\/[^:\s'"`/@]+:([^@\s'"`]+)@([^/:\s'"`]+)/g;
/** Hosts only a test or an example uses. */
const FAKE_HOST = /^(localhost|127\.0\.0\.1|[a-z]|(.+\.)?example\.(com|org))$/;
/** `password: '…'` written in a script; "password" itself is the test-login convention. */
const LITERAL_PASSWORD = /\bpassword\s*:\s*['"]([^'"]+)['"]/g;
const LITERAL_ALLOW = new Set(["password", "Password"]);

function findings(): string[] {
    const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d), []));
    const out: string[] = [];
    for (const file of files) {
        const rel = path.relative(ROOT, file).replace(/\\/g, "/");
        if (rel === "src/lib/security/__tests__/no-stored-db-passwords.test.ts") continue;
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(URL_WITH_PASSWORD)) {
            if (!isPlaceholderPassword(m[1]!) && !FAKE_HOST.test(m[2]!)) out.push(`${rel}: connection string with a password`);
        }
        if (rel.startsWith("scripts/")) {
            for (const m of text.matchAll(LITERAL_PASSWORD)) {
                if (!LITERAL_ALLOW.has(m[1]!)) out.push(`${rel}: password written in the script`);
            }
        }
    }
    return [...new Set(out)].sort();
}

describe("ID 225: no stored passwords", () => {
    it("placeholders are not secrets; real-looking values are", () => {
        expect(isPlaceholderPassword("<password>")).toBe(true);
        expect(isPlaceholderPassword("[YOUR-PASSWORD]")).toBe(true);
        expect(isPlaceholderPassword("${PGPASSWORD}")).toBe(true);
        expect(isPlaceholderPassword("***")).toBe(true);
        expect(isPlaceholderPassword("DB_PASSWORD")).toBe(true);
        expect(isPlaceholderPassword("...")).toBe(true);
        expect(isPlaceholderPassword("Sample2026pw")).toBe(false);
    });

    it("the code holds no database or login password", () => {
        expect(findings()).toEqual([]);
    });
});
