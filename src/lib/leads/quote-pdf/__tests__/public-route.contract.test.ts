/**
 * E-243 — the structural guard on the one route a DEALER can reach without a
 * session.
 *
 * Modelled on src/lib/buyback/__tests__/permissions.contract.test.ts, and for
 * the same reason it gives: the payload we remembered to build is easy to test,
 * and it is the next endpoint somebody adds that leaks. `/api/public/quotations`
 * is the only unauthenticated, dealer-facing surface in the quotation flow, so
 * what it may name is pinned here rather than left to review.
 *
 * A dealer may see their own name, the quote number, the total and the document
 * already sent to them. They may NOT see the OEM reference prices their quote
 * was judged against, the margin, who owns the lead, the internal approval
 * trail, or the lead id.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTE = join(
  process.cwd(),
  "src",
  "app",
  "api",
  "public",
  "quotations",
  "[token]",
  "route.ts",
);

/**
 * Comments are stripped before matching: the route is allowed to EXPLAIN that
 * it must not expose the margin. It is not allowed to select it.
 */
function code(): string {
  return readFileSync(ROUTE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const FORBIDDEN = [
  // The price book and the auto-approval verdict — this is our cost basis and
  // the margin on the deal. A dealer holding it can negotiate against it.
  "oem_evaluation",
  "oem_price",
  "oem_reference_prices",
  "shortfall",
  "approval_mode",
  "rejection_reason",
  "approved_by",
  "quote_snapshot",
  // Internal people and routing.
  "current_owner_id",
  "created_by",
  "asm_id",
  // Other dealers' data has no business in a single-quotation endpoint.
  "dealerLeads",
  "product_master",
];

describe("the public quotation route exposes nothing internal", () => {
  it("exists — a moved file would make this vacuously pass", () => {
    expect(code().length).toBeGreaterThan(500);
  });

  it.each(FORBIDDEN)("never references %s", (secret) => {
    expect(
      code().includes(secret),
      `The public quotation route references "${secret}" outside a comment. ` +
        `A dealer-facing, unauthenticated endpoint must not touch the price ` +
        `book, the margin, the internal approval trail or lead ownership.`,
    ).toBe(false);
  });

  it("takes the quotation id from the SIGNED TOKEN, never from the body", () => {
    const src = code();
    // If the body could name a commercial_id, the signature would be
    // decorative — anyone could POST an approval for any quotation.
    expect(src).toContain("readQuoteToken");
    expect(src).not.toMatch(/body\.(commercialId|commercial_id)/);
  });

  it("verifies the token's version against the row it loaded", () => {
    // A revision is a new row with a new id, so this should be unreachable —
    // which is exactly why it must fail closed rather than be assumed.
    expect(code()).toContain("version_no !== claims.versionNo");
  });

  it("answers a bad signature and an unknown quotation identically", () => {
    // Distinguishing them lets someone probe which commercial ids exist by
    // watching the status code change.
    const src = code();
    expect(src).toContain("NOT_FOUND");
    // Exactly one 404 shape, reused everywhere.
    expect(src.match(/status: 404/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
