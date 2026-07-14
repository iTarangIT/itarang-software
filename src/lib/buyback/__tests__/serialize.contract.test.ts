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
  toDealerNegotiation,
  toDealerPo,
  toVendorLine,
  toVendorQuotation,
  visibleActivityForDealer,
  type AdminDealView,
  type DealerNegRoundSource,
  type DealerPoSource,
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

  it("gives the dealer their OWN firm name, but never the entity id", () => {
    // dealer_firm is the dealer's own registered name — theirs to see. The
    // internal account id (dealer_entity_id) stays structurally absent.
    expect(payload.dealer_firm).toBe("Shakti Battery House");
    expect("dealer_entity_id" in JSON.parse(JSON.stringify(payload))).toBe(false);
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

// ===========================================================================
// EXT-1 — the dealer-leg negotiation. Same rule, new surface: the dealer sees
// their own prices, but never the internal actor id behind an offer, never the
// vendor-leg counterparty, and never a margin/vendor number a careless join
// hangs on a line. The uuids below are the leak we hunt for.
// ===========================================================================
describe("dealer negotiation payload (Ext-1) excludes internal ids and margin/vendor", () => {
  const OFFERED_BY_UUID = "usr-admin-77";
  const COUNTERPARTY_UUID = "vendor-entity-88";

  const rounds: DealerNegRoundSource[] = [
    {
      round_no: 1,
      offered_by_role: "dealer",
      offered_by: "usr-dealer-01",
      note: "Our ask.",
      created_at: "2026-07-11T02:00:00Z",
      lines: [{ line_id: "line-1", label: "60V 120Ah · Working", price_per_unit: 5300 }],
    },
    {
      round_no: 2,
      offered_by_role: "admin",
      // The two internal ids that must be stripped, plus a stray margin/vendor
      // number smuggled onto a line by a careless join.
      offered_by: OFFERED_BY_UUID,
      counterparty_id: COUNTERPARTY_UUID,
      note: "Our counter.",
      created_at: "2026-07-11T03:00:00Z",
      lines: [
        {
          line_id: "line-1",
          label: "60V 120Ah · Working",
          price_per_unit: 5100,
          margin_value: 1300,
          vendor_price: 6400,
        } as never,
      ],
      is_final: true,
      is_accept: true,
    },
  ];

  const payload = toDealerNegotiation(rounds);
  const keys = allKeys(payload);
  const values = allValues(payload);

  it.each(DEALER_FORBIDDEN_KEYS)("the key %s does not appear at any depth", (key) => {
    expect(keys.has(key)).toBe(false);
  });

  it("maps offered_by to a ROLE, never the internal user id", () => {
    expect(payload[0].offered_by).toBe("dealer");
    expect(payload[1].offered_by).toBe("admin");
    // The uuid the source carried must be nowhere in the output.
    expect(values).not.toContain(OFFERED_BY_UUID);
    expect(values).not.toContain(COUNTERPARTY_UUID);
    expect(keys.has("counterparty_id")).toBe(false);
  });

  it("labels the dealer's own rounds 'You' and iTarang's 'iTarang'", () => {
    expect(payload[0].actor_label).toBe("You");
    expect(payload[1].actor_label).toBe("iTarang");
  });

  it("no margin or vendor VALUE rides along on a line", () => {
    for (const secret of [1300, 6400]) {
      expect(values).not.toContain(secret);
    }
  });

  it("still gives the dealer their own per-SKU prices and the final/accept flags", () => {
    expect(payload[0].lines[0].price_per_unit).toBe(5300);
    expect(payload[1].lines[0].price_per_unit).toBe(5100);
    expect(payload[1].is_final).toBe(true);
    expect(payload[1].is_accept).toBe(true);
    expect(payload[0].is_final).toBe(false);
  });
});

// ===========================================================================
// EXT-2 — the dealer PO summary. Number/status/date are the dealer's to see;
// the S3 key (pdf_s3) and the internal counterparty account id are not.
// ===========================================================================
describe("dealer PO summary (Ext-2) excludes the S3 key and counterparty id", () => {
  const source: DealerPoSource = {
    number: "PO-1024-D",
    status: "SENT",
    issued_at: "2026-07-13T00:00:00Z",
    pdf_s3: "buyback/req-1/po/PO-1024-D.pdf",
    counterparty_entity_id: "ACC-1",
  };

  const po = toDealerPo(source)!;
  const keys = allKeys(po);
  const values = allValues(po);

  it.each(DEALER_FORBIDDEN_KEYS)("the key %s does not appear at any depth", (key) => {
    expect(keys.has(key)).toBe(false);
  });

  it("emits number, status and issue date, but pdf_available stays false", () => {
    expect(po.number).toBe("PO-1024-D");
    expect(po.status).toBe("SENT");
    expect(po.issued_at).toBe("2026-07-13T00:00:00Z");
    expect(po.pdf_available).toBe(false);
  });

  it("carries neither the S3 key nor the counterparty account id", () => {
    expect(values).not.toContain("buyback/req-1/po/PO-1024-D.pdf");
    expect(values).not.toContain("ACC-1");
    expect(keys.has("pdf_s3")).toBe(false);
    expect(keys.has("counterparty_entity_id")).toBe(false);
  });

  it("returns null when no PO has been issued to the dealer yet", () => {
    expect(toDealerPo(null)).toBe(null);
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
