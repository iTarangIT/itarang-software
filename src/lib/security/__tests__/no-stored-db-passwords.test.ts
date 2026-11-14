// ID 225 guard: no database or login password is written into the code.
//
// Found 3 Nov: the live database's admin password sat in two audit scripts, an
// old RDS password in five migration scripts, and real people's login
// passwords in two seed scripts. They now come from the environment; this
// test keeps a new one from creeping back in. It reads source text only.
//
// 13 Nov (225): seed-test-data.ts held one shared password for three test
// logins as `const PASSWORD = '…'`, which the first version missed (it only
// knew `password: '…'` and never read tests/ or the top folder). Any
// password-named constant, key or assignment now counts, in scripts/, tests/,
// e2e/ and every top-level file.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const SCAN_DIRS = ["scripts", "src", "docs", "n8n-workflows", "tests", "e2e"];
/** Where a password-named literal is looked for (src/ holds form field names, so it is left out). */
const LITERAL_DIRS = ["scripts/", "tests/", "e2e/"];
const SKIP_DIRS = new Set(["node_modules", ".next", "reports", "__snapshots__", "test-results", "playwright-report"]);
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
/**
 * A password-named key, constant or variable given a quoted literal:
 * `password: '…'`, `const PASSWORD = '…'`, `dbPwd = "…"`, `"password": "…"`.
 * "password" itself is the test-login convention and stays allowed.
 */
const LITERAL_PASSWORD = /\b\w*(?:password|passwd|pwd)\w*["'`]?\s*[:=]\s*["'`]([^"'`\s]{4,})["'`]/gi;
const LITERAL_ALLOW = new Set(["password", "Password"]);

function topLevelFiles(): string[] {
    return readdirSync(ROOT)
        .map((n) => path.join(ROOT, n))
        .filter((f) => statSync(f).isFile() && EXTENSIONS.test(f) && statSync(f).size < 2_000_000);
}

/** Password literals in one file's text. */
function literalPasswords(text: string): string[] {
    return [...text.matchAll(LITERAL_PASSWORD)]
        .map((m) => m[1]!)
        .filter((v) => !LITERAL_ALLOW.has(v) && !isPlaceholderPassword(v));
}

function findings(): string[] {
    const files = [...SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d), [])), ...topLevelFiles()];
    const out: string[] = [];
    for (const file of files) {
        const rel = path.relative(ROOT, file).replace(/\\/g, "/");
        if (rel === "src/lib/security/__tests__/no-stored-db-passwords.test.ts") continue;
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(URL_WITH_PASSWORD)) {
            if (!isPlaceholderPassword(m[1]!) && !FAKE_HOST.test(m[2]!)) out.push(`${rel}: connection string with a password`);
        }
        if (LITERAL_DIRS.some((d) => rel.startsWith(d)) || !rel.includes("/")) {
            if (literalPasswords(text).length) out.push(`${rel}: password written in the file`);
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

    it("a password written as a constant, key or assignment is caught", () => {
        expect(literalPasswords(`const PASSWORD = 'Test@1234';`)).toEqual(["Test@1234"]);
        expect(literalPasswords(`password: "Sample2026pw"`)).toEqual(["Sample2026pw"]);
        expect(literalPasswords(`let dbPwd = "hunter22x"`)).toEqual(["hunter22x"]);
        expect(literalPasswords(`{"admin_password": "Abc12345"}`)).toEqual(["Abc12345"]);
        expect(literalPasswords(`const TEMP_PASSWORD = process.env.X ?? randomPw();`)).toEqual([]);
        expect(literalPasswords(`password: "password"`)).toEqual([]);
        expect(literalPasswords(`password: "<sample-password>"`)).toEqual([]);
    });

    it("the code holds no database or login password", () => {
        expect(findings()).toEqual([]);
    });
});
