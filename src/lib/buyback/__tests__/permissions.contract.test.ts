/**
 * RELEASE-BLOCKING (BRD M23: "contract tests release-blocking").
 *
 * The whole peakAmp business model rests on two facts staying secret in two
 * directions:
 *
 *   · A DEALER must never learn the margin, or that a vendor exists.
 *   · A VENDOR must never learn who the dealer is.
 *
 * iTarang is a back-to-back principal. If either side can see through us, they can
 * go around us — and the non-circumvention clause in the agreement becomes the
 * only thing standing between the company and being disintermediated out of its
 * own market.
 *
 * The individual serializers already have their own contract tests. THIS file is
 * the belt-and-braces one: it asserts the properties that must hold across the
 * WHOLE module, so that a leak cannot be introduced by adding a new field to a new
 * serializer that nobody thought to test.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEALER_FORBIDDEN_KEYS,
  VENDOR_FORBIDDEN_KEYS,
  toDealerDeal,
  toVendorQuotation,
  visibleActivityForDealer,
  type AdminDealView,
} from "../serialize";
import { DEAL_ACTIONS } from "../state-machine";
import { NOTIFICATION_FOR } from "../transition";

const ADMIN_DEAL: AdminDealView = {
  request_id: "req-1",
  request_no: "BB-1024",
  deal_id: "deal-1",
  status: "SETTLED",
  offer_version: 2,
  source_channel: "WEB",
  created_at: "2026-07-13T00:00:00Z",
  submitted_at: "2026-07-13T01:00:00Z",
  dealer_entity_id: "ACC-1",
  dealer_name: "Shakti Battery House",
  dealer_city: "Nashik",
  floor_total: 99999,
  lines: [
    {
      id: "line-1",
      variant_id: "var-1",
      variant_type: "60V 120Ah Li-ion",
      voltage: 60,
      ah: 120,
      quantity: 3,
      condition: "WORKING",
      measured_voltage: 60.6,
      expected_price_per_unit: 5500,
      photo_count: 6,
      dealer_price: 5200,
      margin_value: 1300,
      margin_mode: "FLAT",
      vendor_ask: 6500,
      vendor_price: 6400,
    },
  ],
};

function allKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, found);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      found.add(k);
      allKeys(v, found);
    }
  }
  return found;
}

describe("the two directions of secrecy", () => {
  it("a dealer payload leaks no margin and no vendor, at any depth", () => {
    const keys = allKeys(toDealerDeal(ADMIN_DEAL));
    for (const forbidden of DEALER_FORBIDDEN_KEYS) {
      expect(keys.has(forbidden), `dealer payload leaks ${forbidden}`).toBe(false);
    }
  });

  it("a vendor payload leaks no dealer identity and no margin, at any depth", () => {
    const keys = allKeys(
      toVendorQuotation({
        quotation_no: "QTN-1024-1",
        pickup_city: "Nashik",
        pickup_state: "Maharashtra",
        lines: [
          {
            line_id: "line-1",
            quantity: 3,
            condition: "WORKING",
            voltage: 60,
            ah: 120,
            ask_price: 6500,
          },
        ],
      }),
    );

    for (const forbidden of VENDOR_FORBIDDEN_KEYS) {
      expect(keys.has(forbidden), `vendor payload leaks ${forbidden}`).toBe(false);
    }
  });
});

describe("no notification tells the wrong party a secret", () => {
  it("nothing about margin or the vendor leg is ever addressed to a DEALER", () => {
    // The subtle leak: a payload can be redacted perfectly and then the notification
    // for that same action can cheerfully WhatsApp the dealer about it.
    const dealerMustNotHear = [
      "set_margin",
      "route_to_vendors",
      "record_vendor_counter",
      "record_vendor_agreement",
    ] as const;

    for (const action of dealerMustNotHear) {
      expect(NOTIFICATION_FOR[action].party, `${action} notifies the DEALER`).not.toBe("DEALER");
    }
  });

  it("every action has a decided recipient — adding one without deciding is a failure", () => {
    for (const action of DEAL_ACTIONS) {
      expect(NOTIFICATION_FOR[action], `${action} has no notification target`).toBeDefined();
      expect(NOTIFICATION_FOR[action].party).toBeTruthy();
      expect(NOTIFICATION_FOR[action].channel).toBeTruthy();
    }
  });
});

describe("the dealer's activity log hides the vendor leg server-side", () => {
  it("drops margin and vendor rows before they reach the wire", () => {
    const visible = visibleActivityForDealer([
      { action: "submit", role: "dealer" },
      { action: "set_margin", role: "admin" },
      { action: "route_to_vendors", role: "admin" },
      { action: "record_vendor_agreement", role: "admin" },
      { action: "schedule_pickup", role: "admin" },
    ]).map((e) => e.action);

    expect(visible).toEqual(["submit", "schedule_pickup"]);
  });
});

/**
 * THE STRUCTURAL GUARD.
 *
 * Every test above checks a payload we remembered to build. This one checks the
 * ones we didn't: it reads the dealer-facing route files and asserts that none of
 * them mention a secret column at all.
 *
 * Why bother, when the serializers are already tested? Because the next engineer
 * to add a dealer endpoint will not necessarily use a serializer. They will write
 * `SELECT * FROM deal_line_locks`, ship it, and every test above will still pass.
 * This one will not.
 */
describe("no dealer-facing route so much as MENTIONS a secret column", () => {
  const DEALER_ROUTES = join(process.cwd(), "src", "app", "api", "buyback");

  const SECRETS = [
    "margin_value",
    "margin_mode",
    "vendor_price",
    "vendor_ask",
    "floor_total",
    "vendor_threads",
    "scrap_vendors",
    "deal_line_locks",
  ];

  /** Every route.ts under the dealer-facing API tree. */
  function routeFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) routeFiles(full, acc);
      else if (entry === "route.ts") acc.push(full);
    }
    return acc;
  }

  const files = routeFiles(DEALER_ROUTES);

  it("finds the dealer routes at all (a broken glob would vacuously pass)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)("%s", (file) => {
    // Strip comments: this very file's own explanations name the secrets, and so do
    // the routes' — a route is allowed to EXPLAIN that it must not select the
    // margin. It is not allowed to select it.
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    for (const secret of SECRETS) {
      expect(
        code.includes(secret),
        `${file} references "${secret}" outside a comment. A dealer-facing route must ` +
          `not touch the margin, the vendor, or the locks — build the payload from a ` +
          `serializer instead.`,
      ).toBe(false);
    }
  });
});
