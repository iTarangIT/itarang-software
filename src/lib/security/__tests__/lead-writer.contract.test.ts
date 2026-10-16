/**
 * ID 183 (decided 16 Oct) — every step that CHANGES a customer file goes
 * through the one write check:
 *
 *   requireLeadWriter(leadId, req, user)           the KYC / co-borrower routes
 *   gateLeadActor(user, lead, { write: true, … })  the lender journey (what
 *                                                  requireLeadWriter wraps; the
 *                                                  ID 119 contract pins this
 *                                                  shape on /api/lead/[id])
 *   dealerMayDispatch(user, lead.dealer_id)        the dealer-only steps
 *
 * so the file's own dealer passes (and stamps his action), Admin / Sales Head
 * pass the act-for-dealer checks (permission, 30-minute note, "Done by"
 * record, dealer notice), and the CEO, other back-office roles and the house
 * login on a file it pushed to a dealer are refused. requireLeadAccess alone
 * is a READ check and is not enough for a write.
 *
 * Source-text contract, like api-auth.contract.test.ts: the routes import the
 * database and cannot be loaded here. Every non-GET handler under the three
 * trees must reach one of the three calls — in its own body or through a
 * helper function in the same file.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const API_DIR = join(process.cwd(), "src", "app", "api");
const TREES = [
  join(API_DIR, "kyc", "[leadId]"),
  join(API_DIR, "lead", "[id]"),
  join(API_DIR, "coborrower", "[leadId]"),
];

/** Writes that are not a step on the dealer's file, with the reason. */
const EXEMPT: Record<string, string> = {
  "kyc/[leadId]/consent/admin POST": "the iTarang KYC review's own consent verdict (admin review, not acting for the dealer)",
  "kyc/[leadId]/consent/sync POST":
    "pulls the consent status from Digio; changes nothing the dealer entered, and the page polls it (a dealer stamp per poll would break the idle rule)",
  "lead/[id]/close-offer POST": "410 — offer negotiation retired",
  "lead/[id]/negotiate-offer POST": "410 — offer negotiation retired",
};

const WRITE_CHECK = [
  /\brequireLeadWriter\s*\(/,
  /\bgateLeadActor\s*\(\s*user\s*,\s*lead\b[^;]*\bwrite:\s*true\b/,
  /\bdealerMayDispatch\s*\(\s*user\s*,\s*lead\.dealer_?[iI]d\s*\)/,
];
const hasWriteCheck = (src: string) => WRITE_CHECK.some((re) => re.test(src));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Top-level blocks: each starts at column 0 with export / function / const. */
function topLevelBlocks(src: string): string[] {
  const starts: number[] = [];
  const re = /^(export\s+|async\s+function|function|const\s)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) starts.push(m.index);
  return starts.map((s, i) => src.slice(s, starts[i + 1] ?? src.length));
}

interface Handler {
  key: string;
  ok: boolean;
}

function writeHandlers(file: string): Handler[] {
  const src = code(file);
  const route = relative(API_DIR, file).split(sep).slice(0, -1).join("/");
  const blocks = topLevelBlocks(src);
  // Local helpers that carry the check (e.g. a shared gate(leadId, write)).
  const helpers = blocks
    .map((b) => /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^const\s+(\w+)\s*=/.exec(b))
    .map((m, i) => ({ name: m?.[1] ?? m?.[2] ?? null, body: blocks[i] }))
    .filter((h): h is { name: string; body: string } => !!h.name && hasWriteCheck(h.body));
  const out: Handler[] = [];
  for (const b of blocks) {
    const m = /^export\s+(?:async\s+function\s+|const\s+)(POST|PUT|PATCH|DELETE)\b/.exec(b);
    if (!m) continue;
    const ok = hasWriteCheck(b) || helpers.some((h) => new RegExp(`\\b${h.name}\\s*\\(`).test(b));
    out.push({ key: `${route} ${m[1]}`, ok });
  }
  return out;
}

const handlers = TREES.flatMap((t) => walk(t)).flatMap(writeHandlers);

describe("ID 183: every write on a customer file goes through the one write check", () => {
  it("finds the write handlers", () => {
    expect(handlers.length).toBeGreaterThan(40);
    expect(handlers.some((h) => h.key === "kyc/[leadId]/upload-document POST")).toBe(true);
    expect(handlers.some((h) => h.key === "coborrower/[leadId] POST")).toBe(true);
  });

  it("no write handler relies on requireLeadAccess alone", () => {
    const missing = handlers
      .filter((h) => !h.ok && !(h.key in EXEMPT))
      .map((h) => h.key)
      .sort();
    expect(missing).toEqual([]);
  });

  it("the exemptions still exist and still have no write check (keep the list honest)", () => {
    for (const key of Object.keys(EXEMPT)) {
      const h = handlers.find((x) => x.key === key);
      expect(h, key).toBeDefined();
      expect(h!.ok, `${key} now has a write check — drop it from EXEMPT`).toBe(false);
    }
  });

  it("the KYC routes use the one helper, not a hand-rolled gate", () => {
    const hand = TREES.slice(0, 1)
      .flatMap((t) => walk(t))
      .filter((f) => /\bgateLeadActor\s*\(/.test(code(f)))
      .map((f) => relative(API_DIR, f));
    expect(hand).toEqual([]);
  });
});
