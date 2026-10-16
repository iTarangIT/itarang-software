import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// ID 130 — every shared secret is compared in constant time (safeEqual), and
// no gate falls back to a default secret when its env var is unset. A plain
// `!==` leaks how many leading characters matched; a default like
// `|| "test-bypass"` opens the gate on any server that forgot the env var.

const ROOTS = [join(process.cwd(), "src/app/api"), join(process.cwd(), "src/lib")];

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return name === "__tests__" ? [] : walk(p);
        return /\.(ts|tsx)$/.test(name) ? [p] : [];
    });
}

/** Source without comments, so a comment quoting a bad pattern does not trip the test. */
function code(file: string): string {
    return readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = ROOTS.flatMap(walk).map((f) => ({ f: relative(process.cwd(), f), src: code(f) }));

describe("secret comparisons (ID 130)", () => {
    it("scans the API and lib code", () => {
        expect(files.length).toBeGreaterThan(500);
    });

    it("no gate falls back to a default bypass secret", () => {
        const bad = files.filter((x) => /\|\|\s*["'`]test-bypass["'`]/.test(x.src)).map((x) => x.f);
        expect(bad).toEqual([]);
    });

    it("no request header is compared to a secret with === / !==", () => {
        const bad = files
            .flatMap((x) =>
                x.src
                    .split(/\r?\n/)
                    .filter(
                        (l) =>
                            /headers\.get\(\s*["'][^"']+["']\s*\)\s*[!=]==/.test(l) &&
                            /secret|bypass|token|signature|checksum/i.test(l),
                    )
                    .map((l) => `${x.f}: ${l.trim()}`),
            );
        expect(bad).toEqual([]);
    });

    it("no value is compared to a *SECRET / *TOKEN env var with === / !==", () => {
        const bad = files
            .flatMap((x) =>
                x.src
                    .split(/\r?\n/)
                    .filter((l) => /[!=]==\s*\(?\s*process\.env\.[A-Z0-9_]*(SECRET|TOKEN)\b/.test(l))
                    .map((l) => `${x.f}: ${l.trim()}`),
            );
        expect(bad).toEqual([]);
    });
});
