/**
 * The Discord bot API (/api/bot/*) has no session: it is on the public list,
 * and `Bearer BOT_API_KEY` is its only credential. Two halves are pinned here:
 *
 *   - checkBotKey() itself — called directly, it is pure apart from one env read;
 *   - the routes — read as source text, never imported (they pull in the
 *     database), the same technique as security/__tests__/api-auth.contract.test.ts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isPublicApiPath } from "@/lib/security/publicApi";

import { checkBotKey } from "../auth";
import { BOT_CAMPAIGN_SOURCE, DISCORD_BOT_USER_EMAIL, DISCORD_BOT_USER_ID } from "../constants";

const BOT_DIR = join(process.cwd(), "src", "app", "api", "bot");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/** Comments stripped: a route may EXPLAIN a check without making it. */
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const routes = walk(BOT_DIR).map((file) => ({
  url: "/api/bot/" + relative(BOT_DIR, file).split(sep).slice(0, -1).join("/"),
  src: code(file),
}));

const call = (authorization?: string) =>
  checkBotKey(new Request("http://localhost/api/bot/campaigns", { headers: authorization ? { authorization } : {} }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("checkBotKey", () => {
  it("refuses everything when BOT_API_KEY is not configured — no dev bypass", () => {
    vi.stubEnv("BOT_API_KEY", undefined);
    expect(call("Bearer anything")?.status).toBe(503);

    // An empty secret must not be matched by an empty token.
    vi.stubEnv("BOT_API_KEY", "");
    expect(call("Bearer ")?.status).toBe(503);
    expect(call()?.status).toBe(503);

    vi.stubEnv("NODE_ENV", "development");
    expect(call("Bearer anything")?.status).toBe(503);
  });

  it("refuses a missing, malformed or wrong key", () => {
    vi.stubEnv("BOT_API_KEY", "correct-horse-battery");
    for (const header of [
      undefined,
      "",
      "correct-horse-battery", // no scheme
      "Basic correct-horse-battery",
      "Bearer",
      "Bearer wrong",
      "Bearer correct-horse-batter", // prefix of the key
      "Bearer correct-horse-battery-and-more",
    ]) {
      expect(call(header)?.status, String(header)).toBe(401);
    }
  });

  it("admits the exact key", () => {
    vi.stubEnv("BOT_API_KEY", "correct-horse-battery");
    expect(call("Bearer correct-horse-battery")).toBeNull();
    expect(call("bearer correct-horse-battery")).toBeNull();
  });
});

describe("every /api/bot route goes through the key check", () => {
  it("finds the routes — a moved folder would make this vacuously pass", () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
  });

  it("the namespace is public to middleware, so the routes are all that guards it", () => {
    expect(isPublicApiPath("/api/bot/campaigns")).toBe(true);
    expect(isPublicApiPath("/api/bot/campaigns/x/start")).toBe(true);
  });

  it("exports nothing but withBotAuth-wrapped handlers", () => {
    // One wrapped handler beside a bare `export async function POST` would
    // still satisfy a file-level grep; this checks each export.
    const bare = routes.flatMap((r) =>
      [...r.src.matchAll(/^export\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b[^\n]*/gm)]
        .filter((m) => !/=\s*withBotAuth\s*\(/.test(m[0]))
        .map((m) => `${m[1]} ${r.url}`),
    );
    expect(bare).toEqual([]);

    const none = routes.filter((r) => !/=\s*withBotAuth\s*\(/.test(r.src)).map((r) => r.url);
    expect(none).toEqual([]);
  });

  it("never takes the acting user from the request — it is always the bot service user", () => {
    const wrong = routes.flatMap((r) =>
      [...r.src.matchAll(/\b(triggeredBy|actorId)\s*:\s*([^,\n}]+)/g)]
        .filter((m) => m[2].trim() !== "DISCORD_BOT_USER_ID")
        .map((m) => `${r.url}: ${m[0].trim()}`),
    );
    expect(wrong).toEqual([]);
  });
});

describe("the bot service user", () => {
  it("is the row E-170 inserts — the id and email here must not drift from the migration", () => {
    const sql = readFileSync(join(process.cwd(), "drizzle", "E-170_discord_bot_service_user.sql"), "utf8");
    expect(DISCORD_BOT_USER_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sql).toContain(`'${DISCORD_BOT_USER_ID}'`);
    expect(sql).toContain(`'${DISCORD_BOT_USER_EMAIL}'`);
  });

  it("holds a role that no staff allow-list names", () => {
    // 'system' opens nothing gated by requireRole / guardApi. If the row ever
    // becomes 'admin', a Supabase account with the bot's email would inherit it
    // through requireAuth()'s email fallback.
    const sql = readFileSync(join(process.cwd(), "drizzle", "E-170_discord_bot_service_user.sql"), "utf8");
    expect(sql).toMatch(/'system'/);
    expect(sql).not.toMatch(/'(admin|ceo|sales_head|business_head)'/);
  });
});

describe("KNOWN GAP: the bot key reaches campaigns the bot did not create", () => {
  it("no per-campaign route checks that the campaign is bot-origin", () => {
    // Each handler loads the campaign by id alone. Whoever holds BOT_API_KEY
    // can therefore start, stop, resume or re-dial a campaign a person built
    // in the CRM, and read its dealers' names and phones. The marker to scope
    // by already exists — region_filter.source = BOT_CAMPAIGN_SOURCE, which the
    // list route filters on when asked. When a route gains that check, this
    // list shrinks; a NEW unscoped route also fails here.
    expect(BOT_CAMPAIGN_SOURCE).toBe("discord-bot");

    const scoped = /region_filter\}?\s*->>\s*'source'/;
    const unscoped = routes
      .filter((r) => r.url.includes("/[id]"))
      .filter((r) => !scoped.test(r.src))
      .map((r) => r.url)
      .sort();

    expect(unscoped).toEqual([
      "/api/bot/campaigns/[id]/live-calls",
      "/api/bot/campaigns/[id]/pause",
      "/api/bot/campaigns/[id]/progress",
      "/api/bot/campaigns/[id]/qualified",
      "/api/bot/campaigns/[id]/resume",
      "/api/bot/campaigns/[id]/retry-failed",
      "/api/bot/campaigns/[id]/start",
      "/api/bot/campaigns/[id]/status",
    ]);
  });
});
