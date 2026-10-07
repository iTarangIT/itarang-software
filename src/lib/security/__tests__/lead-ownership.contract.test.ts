/**
 * A dealer may only act on their own leads. The routes under /api/kyc/[leadId]
 * establish that in one of two ways: requireLeadAccess(), or a hand-written
 * comparison of the lead's creator against the caller.
 *
 * The hand-written one had a hole, and must not come back. It read
 *
 *     if (ownerUserId && ownerUserId !== user.id) → 403
 *
 * so a lead with NO recorded creator (created_by and uploader_id both null —
 * WhatsApp- and bulk-created leads are the candidates) skips the check and any
 * dealer may proceed. It also never looks at the lead's dealer_id.
 *
 * Source-text contract, like api-auth.contract.test.ts: the routes import the
 * database and cannot be loaded here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const API_DIR = join(process.cwd(), "src", "app", "api");

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
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const routes = walk(API_DIR).map((file) => ({
  url: "/api/" + relative(API_DIR, file).split(sep).slice(0, -1).join("/"),
  src: code(file),
}));

/** `x && x !== user.id` — an ownership check that a null owner walks through. */
const FAIL_OPEN_OWNER = /\b(\w*[oO]wner\w*)\s*&&\s*\1\s*!==\s*\w+\.id\b/;

describe("lead ownership checks do not fail open", () => {
  it("finds the routes", () => {
    expect(routes.length).toBeGreaterThan(900);
    expect(routes.some((r) => r.url === "/api/kyc/[leadId]/submit-verification")).toBe(true);
  });

  it("the sibling routes show the right shape: requireLeadAccess()", () => {
    const sibling = routes.find((r) => r.url === "/api/kyc/[leadId]/submit-verification")!;
    expect(sibling.src).toMatch(/\brequireLeadAccess\s*\(/);
    expect(FAIL_OPEN_OWNER.test(sibling.src)).toBe(false);
  });

  it("no route uses the fail-open comparison", () => {
    // Three KYC routes did until Oct 2026. Use requireLeadAccess() instead.
    const failOpen = routes
      .filter((r) => FAIL_OPEN_OWNER.test(r.src))
      .map((r) => r.url)
      .sort();

    expect(failOpen).toEqual([]);
  });

  it("the three routes that had it now check the dealership, and stay dealer-only", () => {
    // requireLeadAccess() alone would also admit back-office roles; these
    // three are dealer wizard steps, so the requireRole stays in front.
    for (const url of [
      "/api/kyc/[leadId]/borrower-details",
      "/api/kyc/[leadId]/complete-step2",
      "/api/kyc/[leadId]/complete-step3",
    ]) {
      const r = routes.find((x) => x.url === url)!;
      expect(r.src, url).toMatch(/\brequireLeadAccess\s*\(\s*leadId\s*\)/);
      expect(r.src, url).toMatch(/if\s*\(\s*!leadGate\.ok\s*\)\s*return\s+leadGate\.response/);
      expect(r.src, url).toMatch(/requireRole\(\s*\[\s*"dealer"\s*\]\s*\)/);
      expect(r.src.indexOf("requireRole("), url).toBeLessThan(r.src.indexOf("requireLeadAccess("));
    }
  });
});

describe("Edit Lead checks who owns the lead (ID 132)", () => {
  it("the save and the page both go through canEditLead", () => {
    const save = routes.find((r) => r.url === "/api/dealer-leads/[id]")!;
    expect(save, "PATCH /api/dealer-leads/[id]").toBeDefined();
    const patch = save.src.slice(save.src.search(/export const PATCH/));
    const checkAt = patch.search(/canEditLead\s*\(/);
    const writeAt = patch.search(/\.update\(dealerLeads\)|UPDATE dealer_leads/);
    expect(checkAt, "PATCH must call canEditLead").toBeGreaterThan(-1);
    expect(writeAt, "PATCH writes the lead").toBeGreaterThan(-1);
    expect(checkAt, "the check must come before the write").toBeLessThan(writeAt);

    const page = code(join(process.cwd(), "src", "app", "(dashboard)", "leads", "[id]", "edit", "page.tsx"));
    expect(page).toMatch(/canEditLead\s*\(/);
  });

  it("the list hands the Edit link to the server's verdict, not to the role alone", () => {
    const list = routes.find((r) => r.url === "/api/dealer-leads")!;
    expect(list.src).toMatch(/can_edit:\s*canEditLead\s*\(/);
    const table = code(join(process.cwd(), "src", "app", "(dashboard)", "leads", "_components", "LeadsTable.tsx"));
    expect(table).toMatch(/row\.can_edit\s*&&/);
  });
});
