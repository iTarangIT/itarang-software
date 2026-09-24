import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// INV7 — the Assistant is a separate flow from the dealer WhatsApp bot (BRD
// §8.6). It must not import the dealer bot's code, read or write its tables, or
// use its env. And the channel-agnostic core must not import the WhatsApp
// channel (BRD §8.7), so an in-CRM panel can reuse it unchanged.

const ROOT = process.cwd();

function files(dir: string): string[] {
    const abs = join(ROOT, dir);
    let out: string[] = [];
    let entries: string[];
    try {
        entries = readdirSync(abs);
    } catch {
        return [];
    }
    for (const name of entries) {
        const p = join(abs, name);
        if (statSync(p).isDirectory()) out = out.concat(files(relative(ROOT, p)));
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
    return out;
}

const code = (p: string) =>
    readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ASSISTANT_FILES = [
    ...files("src/lib/assistant"),
    ...files("src/lib/wa-assistant"),
    ...files("src/app/api/assistant"),
    ...files("src/app/(dashboard)/settings/whatsapp-link"),
];

describe("INV7_separate_from_dealer_flow", () => {
    it("finds the assistant sources", () => {
        expect(ASSISTANT_FILES.length).toBeGreaterThan(5);
    });

    it("imports nothing from src/lib/whatsapp/**", () => {
        for (const f of ASSISTANT_FILES) {
            expect(code(f), relative(ROOT, f)).not.toMatch(/from\s+["']@\/lib\/whatsapp(\/|["'])/);
            expect(code(f), relative(ROOT, f)).not.toMatch(/import\(\s*["']@\/lib\/whatsapp/);
        }
    });

    it("never touches the dealer bot's tables or META_WA_* env", () => {
        for (const f of ASSISTANT_FILES) {
            const c = code(f);
            for (const forbidden of [
                "whatsapp_messages",
                "whatsappMessages",
                "whatsapp_dealer_sessions",
                "whatsappDealerSessions",
                "META_WA_",
                "runTurn",
                "recordInbound",
            ]) {
                expect(c, `${relative(ROOT, f)} mentions ${forbidden}`).not.toContain(forbidden);
            }
        }
    });

    it("the channel-agnostic core imports no channel code", () => {
        for (const f of files("src/lib/assistant")) {
            expect(code(f), relative(ROOT, f)).not.toMatch(/@\/lib\/wa-assistant/);
        }
    });
});
