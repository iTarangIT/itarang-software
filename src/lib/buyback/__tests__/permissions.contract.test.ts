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
  const PORTAL_ROUTES = join(process.cwd(), "src", "app", "api", "buyback");

  /**
   * Never legitimate anywhere under /api/buyback — the margin, the vendor's
   * prices, the floor, and the line locks are admin-leg concepts. Admin
   * endpoints live under /api/admin/buyback, which this scan does not cover, so
   * a reference to any of these here is a leak or a mistake either way.
   */
  const ADMIN_ONLY_SECRETS = [
    "margin_value",
    "margin_mode",
    "vendor_price",
    "vendor_ask",
    "floor_total",
    "deal_line_locks",
  ];

  /**
   * The vendor-leg TABLES, which need a different rule.
   *
   * `vendor_threads` is in DEALER_FORBIDDEN_KEYS as a payload key a dealer must
   * never receive — and that still holds. But it is also the name of the table a
   * VENDOR's own endpoints have to query, and /api/buyback is no longer a
   * dealer-only tree: /api/buyback/notifications/summary is one role-aware
   * endpoint serving dealer, vendor and admin from a single file. A flat
   * file-level ban on the identifier therefore fails legitimate vendor code,
   * which is precisely what it started doing.
   *
   * So these get the STRONGER structural check below instead: not "is the name
   * absent" but "is every function that touches it reachable only from a
   * vendor-gated branch". That still fails if somebody moves the vendor query
   * into the dealer path, which is the leak this guard exists to catch.
   */
  const VENDOR_LEG_TABLES = ["vendor_threads", "scrap_vendors"];

  /** Every route.ts under the dealer-facing API tree. */
  function routeFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) routeFiles(full, acc);
      else if (entry === "route.ts") acc.push(full);
    }
    return acc;
  }

  const files = routeFiles(PORTAL_ROUTES);

  /** Strip comments: a route is allowed to EXPLAIN that it must not select the
   *  margin — this very file's prose names every secret. It is not allowed to
   *  select it. */
  const stripComments = (file: string) =>
    readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("finds the portal routes at all (a broken glob would vacuously pass)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)("%s", (file) => {
    const code = stripComments(file);

    for (const secret of ADMIN_ONLY_SECRETS) {
      expect(
        code.includes(secret),
        `${file} references "${secret}" outside a comment. No portal route — dealer or ` +
          `vendor — may touch the margin, the vendor's prices, the floor or the locks. ` +
          `Build the payload from a serializer instead.`,
      ).toBe(false);
    }
  });

  /**
   * The vendor-leg tables, checked structurally rather than by absence.
   *
   * For each helper that queries one, every call site must sit on a line that
   * gates on the vendor role. A query pulled up into the dealer branch, or into
   * an ungated helper the dealer branch can reach, fails here — which is the
   * property the flat identifier ban was really trying to express.
   */
  it.each(files)("%s — vendor-leg tables stay behind a vendor-role gate", (file) => {
    const code = stripComments(file);
    const touches = VENDOR_LEG_TABLES.filter((t) => code.includes(t));
    if (touches.length === 0) return;

    // Split on function declarations, keeping the name with its body.
    const fns = [...code.matchAll(/(?:async\s+)?function\s+(\w+)\s*\([\s\S]*?\n\}/g)];
    const guilty = fns.filter((m) => touches.some((t) => m[0].includes(t)));

    expect(
      guilty.length,
      `${file} references ${touches.join("/")} but not inside any named function, so ` +
        `its reachability cannot be established. Move the query into a helper called ` +
        `only from the vendor branch.`,
    ).toBeGreaterThan(0);

    for (const fn of guilty) {
      const name = fn[1]!;
      const callSites = code
        .split(/\r?\n/)
        .filter((line) => new RegExp(`\\b${name}\\s*\\(`).test(line))
        .filter((line) => !/(?:async\s+)?function\s+/.test(line));

      expect(
        callSites.length,
        `${file}: ${name}() queries a vendor-leg table but is never called — dead code ` +
          `touching a secret is still a liability.`,
      ).toBeGreaterThan(0);

      for (const site of callSites) {
        expect(
          /role\s*===\s*"vendor"/.test(site),
          `${file}: ${name}() queries ${touches.join("/")} but is called from an ` +
            `ungated line:\n    ${site.trim()}\nA dealer must not be able to reach it. ` +
            `Gate the call on role === "vendor".`,
        ).toBe(true);
      }
    }
  });
});
