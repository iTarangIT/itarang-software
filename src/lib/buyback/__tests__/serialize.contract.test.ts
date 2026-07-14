/**
 * RELEASE-BLOCKING CONTRACT TEST (BRD M23 — "contract tests release-blocking").
 *
 * The dealer must never receive margin or vendor data. Not nulled — ABSENT.
 * A `null` still tells a dealer that a margin field exists and that iTarang is
 * tracking one; the AC is explicit that the key must not be in the payload.
 *
 * The deep walk below is the important part: it recurses through the whole
 * serialized object, so a secret cannot hide inside a nested line, a future
 * `meta` blob, or an array element.
 */

import { describe, expect, it } from "vitest";

import {
  DEALER_FORBIDDEN_KEYS,
  VENDOR_FORBIDDEN_KEYS,
  toDealerDeal,
  toDealerLine,
  toVendorLine,
  toVendorQuotation,
  visibleActivityForDealer,
  type AdminDealView,
} from "../serialize";
import { NOTIFICATION_FOR } from "../transition";
import { DEAL_ACTIONS } from "../state-machine";

/** A deal with every secret populated — nothing is null, so a leak cannot hide. */
const ADMIN_DEAL: AdminDealView = {
  request_id: "req-1",
  request_no: "BB-1024",
  deal_id: "deal-1",
  status: "MARGIN_SET",
  offer_version: 2,
  source_channel: "WEB",
  created_at: "2026-07-11T00:00:00Z",
  submitted_at: "2026-07-11T01:00:00Z",
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
    {
      id: "line-2",
      variant_id: "var-2",
      variant_type: "58V 110Ah Li-ion",
      voltage: 58,
      ah: 110,
      quantity: 2,
      condition: "DEAD",
      measured_voltage: 0,
      expected_price_per_unit: 3200,
      photo_count: 5,
      dealer_price: 3100,
      margin_value: 800,
      margin_mode: "FLAT",
      vendor_ask: 3900,
      vendor_price: 3850,
    },
  ],
};

/** Every key appearing anywhere in the structure, at any depth. */
function allKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, found);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      found.add(k);
      allKeys(v, found);
    }
  }
  return found;
}

/** Every primitive value appearing anywhere, so we can hunt for leaked numbers. */
function allValues(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) allValues(item, found);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) allValues(v, found);
  } else {
    found.push(value);
  }
  return found;
}

describe("dealer payload excludes margin and vendor data — ABSENT, not null", () => {
  const payload = toDealerDeal(ADMIN_DEAL);
  const keys = allKeys(payload);

  it.each(DEALER_FORBIDDEN_KEYS)("the key %s does not appear at any depth", (key) => {
    expect(keys.has(key)).toBe(false);
  });

  it("the keys are absent, not present-and-null (the AC's exact wording)", () => {
    const json = JSON.parse(JSON.stringify(payload));
    for (const key of DEALER_FORBIDDEN_KEYS) {
      expect(key in json).toBe(false);
    }
    // And nothing nested, either.
    for (const line of json.lines) {
      expect("margin_value" in line).toBe(false);
      expect("vendor_ask" in line).toBe(false);
    }
  });

  it("no secret VALUE leaks through under an innocent key name", () => {
    // Catches a rename that keeps the data, e.g. `uplift: 1300`.
    const values = allValues(payload);
    const secrets = [1300, 800, 6500, 6400, 3900, 3850, 99999];
    for (const secret of secrets) {
      expect(values).not.toContain(secret);
    }
  });

  it("still gives the dealer their OWN numbers", () => {
    expect(payload.lines[0].dealer_price).toBe(5200);
    expect(payload.lines[0].line_total).toBe(15600); // 3 × 5200
    expect(payload.dealer_quote_total).toBe(15600 + 6200); // + 2 × 3100
    expect(payload.status).toBe("MARGIN_SET");
    expect(payload.offer_version).toBe(2);
  });

  it("carries the shared formatter's label, so screens never re-template it", () => {
    expect(payload.lines[0].spec_label).toBe("60V 120Ah");
    expect(payload.lines[0].condition).toBe("Working");
    expect(payload.lines[1].condition).toBe("Dead");
  });

  it("a NEW secret column on the admin view does not ride along", () => {
    // The regression this whole design exists to prevent: someone adds a column,
    // and a spread-based serializer quietly ships it to dealers.
    const withNewSecret = {
      ...ADMIN_DEAL,
      lines: [{ ...ADMIN_DEAL.lines[0], secret_vendor_rebate: 4242 }],
    } as AdminDealView;

    const leaked = allValues(toDealerDeal(withNewSecret));
    expect(leaked).not.toContain(4242);
    expect(allKeys(toDealerDeal(withNewSecret)).has("secret_vendor_rebate")).toBe(false);
  });

  it("toDealerLine is safe on its own, not just via toDealerDeal", () => {
    const line = toDealerLine(ADMIN_DEAL.lines[0]);
    expect("margin_value" in line).toBe(false);
    expect("vendor_price" in line).toBe(false);
  });
});

describe("dealer activity log hides margin and vendor events server-side", () => {
  const entries = [
    { action: "submit", role: "dealer" },
    { action: "request_info", role: "admin" },
    { action: "set_margin", role: "admin" },
    { action: "start_review", role: "admin" },
    { action: "vendor_agreed", role: "vendor" },
    { action: "send_final_offer", role: "admin" },
    // Sprint 2A — the vendor leg.
    { action: "route_to_vendors", role: "admin" },
    { action: "record_vendor_counter", role: "admin" },
    { action: "record_vendor_agreement", role: "admin" },
    // ...but fulfilment IS the dealer's business: they have to hand the
    // batteries over, so they must see the PO and the pickup slot.
    { action: "exchange_pos", role: "admin" },
    { action: "schedule_pickup", role: "admin" },
    { action: "complete_pickup", role: "admin" },
  ];

  it("drops margin and vendor rows before they reach the wire", () => {
    const visible = visibleActivityForDealer(entries).map((e) => e.action);
    expect(visible).toEqual([
      "submit",
      "request_info",
      "send_final_offer",
      "exchange_pos",
      "schedule_pickup",
      "complete_pickup",
    ]);
    expect(visible).not.toContain("set_margin");
  });

  it("hides the whole vendor leg — routing, counters and the agreement", () => {
    const visible = visibleActivityForDealer(entries).map((e) => e.action);
    for (const hidden of [
      "route_to_vendors",
      "record_vendor_counter",
      "record_vendor_agreement",
    ]) {
      expect(visible, `${hidden} leaked to the dealer's activity tab`).not.toContain(hidden);
    }
  });

  it("still shows the dealer the fulfilment events they are a party to", () => {
    const visible = visibleActivityForDealer(entries).map((e) => e.action);
    expect(visible).toContain("schedule_pickup");
    expect(visible).toContain("complete_pickup");
  });
});

describe("no silent transitions (BRD M20 AC)", () => {
  it("every action declares a notification recipient and channel", () => {
    // Adding an action without deciding who hears about it is a compile-time
    // error via the Record type, and a test failure here too.
    for (const action of DEAL_ACTIONS) {
      expect(NOTIFICATION_FOR[action]).toBeDefined();
      expect(NOTIFICATION_FOR[action].party).toBeTruthy();
      expect(NOTIFICATION_FOR[action].channel).toBeTruthy();
    }
  });

  it("never tells the dealer about margin", () => {
    expect(NOTIFICATION_FOR.set_margin.party).not.toBe("DEALER");
  });

  it("never tells the dealer about the vendor leg", () => {
    // A dealer who learns we routed to vendors — and what they bid — can work
    // out our margin and our buyer list.
    expect(NOTIFICATION_FOR.route_to_vendors.party).not.toBe("DEALER");
    expect(NOTIFICATION_FOR.record_vendor_counter.party).not.toBe("DEALER");
    expect(NOTIFICATION_FOR.record_vendor_agreement.party).not.toBe("DEALER");
  });
});

// ===========================================================================
// RELEASE-BLOCKING (M09 AC): "PDF contains no dealer name/phone/GST."
//
// The mirror of the dealer contract above. iTarang is a back-to-back principal
// trader: if a vendor can identify the dealer, the vendor can go around us. This
// is the non-circumvention clause, enforced in a type rather than a template.
// ===========================================================================
describe("vendor payload excludes dealer identity — ABSENT, not null", () => {
  // Every dealer secret, populated with a value we can then hunt for.
  const quotation = toVendorQuotation({
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
      {
        line_id: "line-2",
        quantity: 2,
        condition: "DEAD",
        voltage: 58,
        ah: 110,
        ask_price: 3900,
      },
    ],
    issued_on: "2026-07-13T00:00:00Z",
  });

  const keys = allKeys(quotation);
  const values = allValues(quotation);

  it.each(VENDOR_FORBIDDEN_KEYS)("the key %s does not appear at any depth", (key) => {
    expect(keys.has(key)).toBe(false);
  });

  it("carries no dealer identity VALUE, under any key name", () => {
    // The M09 AC verbatim: no dealer name, phone or GST anywhere in the document.
    const identity = [
      "Shakti Battery House",
      "9820011111",
      "27AAAAA0000A1Z5",
      "ACC-1",
      "dealer@shakti.in",
    ];
    for (const secret of identity) {
      expect(values).not.toContain(secret);
    }
  });

  it("carries no margin or dealer-side price", () => {
    // dealer_price 5200/3100 and margin 1300/800 from ADMIN_DEAL. A vendor who
    // knows both our ask and what we paid knows our margin exactly.
    for (const secret of [5200, 3100, 1300, 800, 99999]) {
      expect(values).not.toContain(secret);
    }
  });

  it("reveals location no more precisely than city + state", () => {
    expect(quotation.pickup_city).toBe("Nashik");
    expect(quotation.pickup_state).toBe("Maharashtra");
    // Enough to price transport, not enough to find the shop.
    expect(keys.has("address_line1")).toBe(false);
    expect(keys.has("pincode")).toBe(false);
  });

  it("still gives the vendor what they need to quote", () => {
    expect(quotation.lines[0].spec_label).toBe("60V 120Ah");
    expect(quotation.lines[0].condition).toBe("Working");
    expect(quotation.lines[0].ask_price).toBe(6500);
    expect(quotation.total_units).toBe(5);
    expect(quotation.ask_total).toBe(3 * 6500 + 2 * 3900);
  });

  it("a NEW dealer column cannot ride along into a quotation", () => {
    const contaminated = toVendorQuotation({
      quotation_no: "QTN-1024-2",
      pickup_city: "Nashik",
      pickup_state: "Maharashtra",
      // A caller carelessly spreading a joined DB row into the line source.
      lines: [
        {
          line_id: "line-1",
          quantity: 3,
          condition: "WORKING",
          voltage: 60,
          ah: 120,
          ask_price: 6500,
          dealer_name: "Shakti Battery House",
          margin_value: 1300,
        } as never,
      ],
    });

    const leaked = allValues(contaminated);
    expect(leaked).not.toContain("Shakti Battery House");
    expect(leaked).not.toContain(1300);
    expect(allKeys(contaminated).has("dealer_name")).toBe(false);
    expect(allKeys(contaminated).has("margin_value")).toBe(false);
  });

  it("toVendorLine is safe on its own, not just via toVendorQuotation", () => {
    const line = toVendorLine({
      line_id: "line-1",
      quantity: 3,
      condition: "WORKING",
      voltage: 60,
      ah: 120,
      ask_price: 6500,
    });
    expect("dealer_price" in line).toBe(false);
    expect("margin_value" in line).toBe(false);
    expect("dealer_name" in line).toBe(false);
  });
});
