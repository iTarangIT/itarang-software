/**
 * E-101 — Canonical toPaymentMode() utility tests.
 *
 * Sync Audit G-02 / G-07.
 *
 * The audit rejected the original surface plan (warranty.create / after-sales.create
 * REST endpoints) because no `warranty` table exists in this codebase. Per the
 * loop's audited verdict, E-101 collapses to a "pure code" utility shipped under
 * `src/lib/sales/payment-mode.ts` and consumed by the existing finalizeSale
 * pipeline (which already writes after_sales_records.payment_mode).
 *
 * The acceptance criteria therefore exercise the utility itself plus its two
 * call sites (confirm-cash-sale, confirm-dispatch). The mapping behaviour is
 * the load-bearing contract — if the utility is correct and both call sites
 * route through it, after_sales_records.payment_mode and the sibling
 * deployedAssets.payment_type are guaranteed consistent with leads.payment_method.
 *
 * AC-mapping:
 *   AC1  'Cash'            → 'cash'   (utility)
 *   AC2  'Other finance'   → 'finance'(utility)
 *   AC3  'Dealer finance'  → 'finance'(utility)
 *   AC4  call sites use the utility (static check)
 *   AC5  unknown input throws a typed error (no silent fallback)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";

import {
  toPaymentMode,
  tryToPaymentMode,
  PaymentModeMappingError,
} from "../../../src/lib/sales/payment-mode";

const REPO_ROOT = path.resolve(__dirname, "../../..");

test.describe("E-101 — toPaymentMode() canonical mapping", () => {
  test("AC1: 'Cash' collapses to 'cash'", () => {
    expect(toPaymentMode("Cash")).toBe("cash");
  });

  test("AC2: 'Other finance' collapses to 'finance'", () => {
    expect(toPaymentMode("Other finance")).toBe("finance");
  });

  test("AC3: 'Dealer finance' collapses to 'finance'", () => {
    expect(toPaymentMode("Dealer finance")).toBe("finance");
  });

  test("legacy variants collapse the same way", () => {
    // Lowercase / underscore / synonym variants observed in this codebase
    // must not silently drift. Keeping them in the mapping table preserves
    // backwards compatibility while still routing through the utility.
    expect(toPaymentMode("cash")).toBe("cash");
    expect(toPaymentMode("upfront")).toBe("cash");
    expect(toPaymentMode("finance")).toBe("finance");
    expect(toPaymentMode("other_finance")).toBe("finance");
    expect(toPaymentMode("dealer_finance")).toBe("finance");
    expect(toPaymentMode("OTHER FINANCE")).toBe("finance");
    expect(toPaymentMode("  Dealer Finance  ")).toBe("finance");
  });

  test("AC5: unknown input throws PaymentModeMappingError (no silent default)", () => {
    expect(() => toPaymentMode("loan")).toThrow(PaymentModeMappingError);
    expect(() => toPaymentMode("")).toThrow(PaymentModeMappingError);
    expect(() => toPaymentMode(null)).toThrow(PaymentModeMappingError);
    expect(() => toPaymentMode(undefined)).toThrow(PaymentModeMappingError);
    // Non-strings fail too — defends against accidental cross-type drift.
    // @ts-expect-error — deliberate bad input for the test
    expect(() => toPaymentMode(42)).toThrow(PaymentModeMappingError);
  });

  test("tryToPaymentMode returns null on bad input (no throw)", () => {
    expect(tryToPaymentMode("loan")).toBeNull();
    expect(tryToPaymentMode("Cash")).toBe("cash");
  });
});

test.describe("E-101 — call sites route through the utility (static)", () => {
  test("AC4: confirm-cash-sale and confirm-dispatch both import toPaymentMode", () => {
    // Static-text check: the BRD requires the mapping to "be implemented as
    // a named utility function applied at both warranty creation and
    // after-sales creation. Never map inline — always call the utility."
    // We assert that both finalizeSale call sites import the utility and
    // that no inline `payment_method`-to-mode string juggling remains.
    const cashRoute = readFileSync(
      path.join(REPO_ROOT, "src/app/api/lead/[id]/confirm-cash-sale/route.ts"),
      "utf8",
    );
    expect(cashRoute).toContain('from "@/lib/sales/payment-mode"');
    expect(cashRoute).toContain("toPaymentMode(lead.payment_method)");
    // Must NOT pass a hard-coded string LITERAL into finalizeSale or the
    // notification helper. We allow type annotations like `: "cash" | "finance"`
    // (declaration position) by requiring the literal to be followed by a
    // comma / closing brace — i.e. it appears as a value in an object.
    expect(cashRoute).not.toMatch(/paymentMode:\s*"cash"\s*[,}]/);
    expect(cashRoute).not.toMatch(/paymentMode:\s*"finance"\s*[,}]/);

    const dispatchRoute = readFileSync(
      path.join(
        REPO_ROOT,
        "src/app/api/lead/[id]/step-5/confirm-dispatch/route.ts",
      ),
      "utf8",
    );
    expect(dispatchRoute).toContain('from "@/lib/sales/payment-mode"');
    expect(dispatchRoute).toContain("toPaymentMode(lead.payment_method)");
    expect(dispatchRoute).not.toMatch(/paymentMode:\s*"cash"\s*[,}]/);
    expect(dispatchRoute).not.toMatch(/paymentMode:\s*"finance"\s*[,}]/);
  });

  test("utility is the single source — no other inline collapse logic exists", () => {
    // Regression guard: every place that writes a 2-value payment_mode (warranty
    // / after_sales / product_selection) should ultimately go through the
    // utility. We pin sale-finalization.ts as the only writer for the
    // warranty + after-sales rows and verify it accepts a typed
    // 'cash' | 'finance' rather than recomputing one.
    const finalization = readFileSync(
      path.join(REPO_ROOT, "src/lib/sales/sale-finalization.ts"),
      "utf8",
    );
    expect(finalization).toContain('paymentMode: "cash" | "finance"');
    // The transform must NOT happen here — it must come from a call site
    // that already canonicalised via toPaymentMode().
    expect(finalization).not.toMatch(/payment_method.*?\.toLowerCase/);
  });
});
