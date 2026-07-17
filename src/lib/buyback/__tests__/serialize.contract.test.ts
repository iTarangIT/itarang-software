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
  toDealerPayout,
  toDealerPickup,
  toDealerPo,
  toVendorLine,
  toVendorQuotation,
  toVendorThread,
  visibleActivityForDealer,
  type AdminDealView,
  type DealerNegRoundSource,
  type DealerPickupSource,
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
      // E-191 dealer-declared spec — the dealer typed these, so they must
      // survive INTO the dealer payload (asserted below). Values deliberately
      // avoid every number in the secret list.
      brand: "Exide",
      chemistry: "NMC",
      form_factor: "PRISMATIC",
      nominal_voltage: 60,
      nominal_ampere: 120,
      unit_weight_kg: 12.5,
      warranty_cycles: 900,
      functional_qty: 3,
      non_functional_qty: 0,
      iot_battery: true,
      iot_brand_name: "BoltIoT",
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
      brand: "Amaron",
      chemistry: "LFP",
      form_factor: "CELL",
      nominal_voltage: 58,
      nominal_ampere: 110,
      unit_weight_kg: 11,
      warranty_cycles: 700,
      functional_qty: 0,
      non_functional_qty: 2,
      iot_battery: false,
      iot_brand_name: null,
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

  it("emits number, status, issue date, and whether a PDF exists — never the key itself", () => {
    expect(po.number).toBe("PO-1024-D");
    expect(po.status).toBe("SENT");
    expect(po.issued_at).toBe("2026-07-13T00:00:00Z");
    // U1: pdf_available now mirrors whether pdf_s3 was populated on the source —
    // the boolean rides along, the S3 key itself never does (asserted below).
    expect(po.pdf_available).toBe(true);
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

// ===========================================================================
// EXT-8 — the dealer pickup summary on the list endpoint. The dealer is a
// party to the pickup, so schedule/address/contact/counts are theirs. The BWM
// compliance S3 keys and the scheduling admin's user id are not.
// ===========================================================================
describe("dealer pickup summary (Ext-8) excludes compliance S3 keys and internal ids", () => {
  const EWAY_S3 = "buyback/req-1/eway/EWB-4471.pdf";
  const WEIGHBRIDGE_S3 = "buyback/req-1/weighbridge/slip-88.jpg";
  const SCHEDULER_UUID = "usr-admin-77";

  const source: DealerPickupSource = {
    scheduled_at: "2026-07-14T09:00:00Z",
    completed_at: "2026-07-15T11:30:00Z",
    address: "Shakti Battery House, MIDC Ambad, Nashik 422010",
    contact_name: "Ramesh Kumar",
    contact_phone: "9820011111",
    submitted_units: "5",
    actual_units: 4,
    eway_bill_s3: EWAY_S3,
    weighbridge_slip_s3: WEIGHBRIDGE_S3,
    created_by: SCHEDULER_UUID,
  };

  const pickup = toDealerPickup(source)!;
  const keys = allKeys(pickup);
  const values = allValues(pickup);

  it.each(DEALER_FORBIDDEN_KEYS)("the key %s does not appear at any depth", (key) => {
    expect(keys.has(key)).toBe(false);
  });

  it("emits the schedule, address, one contact label, and numeric counts", () => {
    expect(pickup.scheduled_at).toBe("2026-07-14T09:00:00Z");
    expect(pickup.completed_at).toBe("2026-07-15T11:30:00Z");
    expect(pickup.address).toBe("Shakti Battery House, MIDC Ambad, Nashik 422010");
    expect(pickup.contact).toBe("Ramesh Kumar · 9820011111");
    // The string "5" off a numeric-ish column arrives as the number 5.
    expect(pickup.submitted_units).toBe(5);
    expect(pickup.actual_units).toBe(4);
  });

  it("carries neither compliance S3 key nor the scheduler's user id, under any name", () => {
    expect(values).not.toContain(EWAY_S3);
    expect(values).not.toContain(WEIGHBRIDGE_S3);
    expect(values).not.toContain(SCHEDULER_UUID);
    expect(keys.has("eway_bill_s3")).toBe(false);
    expect(keys.has("weighbridge_slip_s3")).toBe(false);
    expect(keys.has("created_by")).toBe(false);
  });

  it("counts stay null on a pickup that is scheduled but not yet collected", () => {
    const scheduled = toDealerPickup({
      scheduled_at: "2026-07-20T09:00:00Z",
      completed_at: null,
      address: null,
      submitted_units: null,
      actual_units: null,
    })!;
    expect(scheduled.submitted_units).toBe(null);
    expect(scheduled.actual_units).toBe(null);
    expect(scheduled.completed_at).toBe(null);
    expect(scheduled.contact).toBe(null);
  });

  it("returns null when no pickup exists yet", () => {
    expect(toDealerPickup(null)).toBe(null);
  });

  it("a NEW secret column on the source does not ride along", () => {
    const contaminated = toDealerPickup({
      ...source,
      collector_fee: 750,
    } as never)!;
    expect(allValues(contaminated)).not.toContain(750);
    expect(allKeys(contaminated).has("collector_fee")).toBe(false);
  });
});

// ===========================================================================
// EXT-9 — the dealer payout summary on the list endpoint. DEALER leg ONLY:
// the amount is the locked dealer total, `paid` means a -D settlement exists.
// A VENDOR-leg settlement row must contribute NOTHING — not paid, not its
// txn_ref, not its amount — the same exclusion visibleActivityForDealer
// applies to record_settlement events.
// ===========================================================================
describe("dealer payout summary (Ext-9) is DEALER-leg only", () => {
  const VENDOR_TXN_REF = "NEFT-AXIS-991144";
  const VENDOR_AMOUNT = 71500;
  const RECORDER_UUID = "usr-finance-12";

  it("is null until the deal reaches the money stage (no locked prices)", () => {
    expect(toDealerPayout({ locked_dealer_total: null, settlements: [] })).toBe(null);
  });

  it("before payment: amount from the locks, unpaid, no txn_ref", () => {
    const payout = toDealerPayout({ locked_dealer_total: 21800, settlements: [] })!;
    expect(payout.amount).toBe(21800);
    expect(payout.paid).toBe(false);
    expect(payout.txn_ref).toBe(null);
  });

  it("a VENDOR-leg settlement neither marks it paid nor leaks anything", () => {
    const payout = toDealerPayout({
      locked_dealer_total: 21800,
      settlements: [
        {
          leg: "VENDOR",
          txn_ref: VENDOR_TXN_REF,
          amount: VENDOR_AMOUNT,
          proof_s3: "buyback/req-1/proof/vendor-neft.png",
          recorded_by: RECORDER_UUID,
        },
      ],
    })!;

    // The vendor's receipt is the other half of the margin. It does not exist
    // as far as this payload is concerned.
    expect(payout.paid).toBe(false);
    expect(payout.txn_ref).toBe(null);

    const values = allValues(payout);
    expect(values).not.toContain(VENDOR_TXN_REF);
    expect(values).not.toContain(VENDOR_AMOUNT);
    expect(values).not.toContain(RECORDER_UUID);
    expect(values).not.toContain("buyback/req-1/proof/vendor-neft.png");
  });

  it("a DEALER-leg settlement marks it paid, with its txn_ref — locked amount, not typed amount", () => {
    const payout = toDealerPayout({
      locked_dealer_total: 21800,
      settlements: [
        { leg: "VENDOR", txn_ref: VENDOR_TXN_REF, amount: VENDOR_AMOUNT },
        {
          leg: "DEALER",
          txn_ref: "IMPS-HDFC-777001",
          // A typo'd amount on the settlement row must not restate the payout.
          amount: 999999,
          proof_s3: "buyback/req-1/proof/dealer-imps.png",
          recorded_by: RECORDER_UUID,
        },
      ],
    })!;

    expect(payout.paid).toBe(true);
    expect(payout.txn_ref).toBe("IMPS-HDFC-777001");
    expect(payout.amount).toBe(21800);

    const values = allValues(payout);
    expect(values).not.toContain(999999);
    expect(values).not.toContain(VENDOR_TXN_REF);
    expect(values).not.toContain(VENDOR_AMOUNT);
  });

  it.each(DEALER_FORBIDDEN_KEYS)("the key %s does not appear at any depth", (key) => {
    const payout = toDealerPayout({
      locked_dealer_total: 21800,
      settlements: [
        {
          leg: "DEALER",
          txn_ref: "IMPS-HDFC-777001",
          amount: 21800,
          proof_s3: "buyback/req-1/proof/dealer-imps.png",
          recorded_by: RECORDER_UUID,
        },
      ],
    })!;
    expect(allKeys(payout).has(key)).toBe(false);
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

// ===========================================================================
// Item 14 — the battery spec reaches the vendor, and the dealer still does not.
// Widening a masked type is the riskiest edit in this module: every field added
// here is a field that now leaves the building.
// ===========================================================================
// ===========================================================================
// E-195 fallout: the dealer's activity filter used to key off ROLE, which was
// only ever correct by coincidence. Giving vendors a login broke the
// coincidence — these pin the fix.
// ===========================================================================
describe("dealer activity is filtered by ACTION, never by who typed it", () => {
  it("shows the PO exchange whichever counterparty uploaded second", () => {
    // THE BUG THE OLD FILTER HAD. exchange_pos fires inside whichever
    // transaction completes the PO pair, so it carries role='admin' or
    // role='vendor' purely by race. A blanket `role === "vendor" -> hide` made
    // the dealer's sight of their OWN PO exchange depend on that race.
    const viaAdmin = visibleActivityForDealer([{ action: "exchange_pos", role: "admin" }]);
    const viaVendor = visibleActivityForDealer([{ action: "exchange_pos", role: "vendor" }]);
    expect(viaAdmin).toHaveLength(1);
    expect(viaVendor).toHaveLength(1);
  });

  it("hides a vendor's first-hand counter and agreement", () => {
    // What a vendor offered IS the margin. These hide for the same reason as
    // their record_* twins — not because a vendor typed them.
    const out = visibleActivityForDealer([
      { action: "vendor_counter", role: "vendor" },
      { action: "vendor_agree", role: "vendor" },
      { action: "vendor_declined", role: "vendor" },
    ]);
    expect(out).toEqual([]);
  });

  it("hides them even if an admin somehow performed them", () => {
    // Belt and braces: the hide-list is keyed on the action, so a
    // mis-attributed row still cannot leak the vendor leg.
    const out = visibleActivityForDealer([
      { action: "vendor_counter", role: "admin" },
      { action: "record_vendor_agreement", role: "admin" },
    ]);
    expect(out).toEqual([]);
  });

  it("still hides an unknown vendor action — new vendor actions fail SAFE", () => {
    // The allow-list is the point: a vendor-leg action added later is hidden by
    // omission rather than by somebody remembering to hide it.
    const out = visibleActivityForDealer([
      { action: "some_future_vendor_thing", role: "vendor" },
    ]);
    expect(out).toEqual([]);
  });

  it("still shows the dealer their own fulfilment events", () => {
    const out = visibleActivityForDealer([
      { action: "schedule_pickup", role: "vendor" },
      { action: "complete_pickup", role: "admin" },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("vendor line carries the battery spec (E-191) but never the dealer", () => {
  const SPEC = {
    line_id: "line-1",
    quantity: 10,
    condition: "WORKING" as const,
    voltage: 60,
    ah: 120,
    ask_price: 6500,
    variant_type: "LI_ION",
    brand: "Exide",
    chemistry: "LFP",
    form_factor: "PRISMATIC",
    nominal_voltage: 60,
    nominal_ampere: 120,
    unit_weight_kg: 12.5,
    warranty_cycles: 2000,
    functional_qty: 6,
    non_functional_qty: 3,
    iot_battery: true,
    iot_brand_name: null,
  };

  it("gives a scrap buyer what they actually price on: chemistry and kilograms", () => {
    const l = toVendorLine(SPEC);
    expect(l.chemistry).toBe("LFP");
    expect(l.unit_weight_kg).toBe(12.5);
    // 10 × 12.5 — the number the quotation never had.
    expect(l.line_weight_kg).toBe(125);
  });

  it("marks an assumed IOT brand as assumed, in the same string as the brand", () => {
    // Unstrippable on purpose: a template cannot render the brand and drop the
    // caveat, because there is no bare brand to render.
    expect(toVendorLine(SPEC).iot_brand_label).toBe("Intellicar (assumed)");
  });

  it("does not mark the dealer's own answer as assumed", () => {
    expect(toVendorLine({ ...SPEC, iot_brand_name: "BoltIoT" }).iot_brand_label).toBe("BoltIoT");
  });

  it("says nothing about IOT brand for a non-IOT pack", () => {
    expect(toVendorLine({ ...SPEC, iot_battery: false }).iot_brand_label).toBeNull();
  });

  it("counts the untested remainder rather than hiding it", () => {
    // 6 + 3 of 10. The gate allows a partial declaration, so the vendor must be
    // told about the 1 nobody tested — not left to infer it is working.
    expect(toVendorLine(SPEC).condition_split_label).toBe("6 working · 3 non-working · 1 untested");
  });

  it("omits the zero parts of the split", () => {
    expect(
      toVendorLine({ ...SPEC, functional_qty: 10, non_functional_qty: 0 }).condition_split_label,
    ).toBe("10 working");
  });

  it("says nothing when the dealer declared no split at all", () => {
    expect(
      toVendorLine({ ...SPEC, functional_qty: null, non_functional_qty: null })
        .condition_split_label,
    ).toBeNull();
  });

  it("a NEW dealer column still cannot ride in via the spec path", () => {
    // The contamination test, re-run now that the source type is much wider.
    const q = toVendorQuotation({
      quotation_no: "QTN-1",
      pickup_city: "Nashik",
      pickup_state: "Maharashtra",
      lines: [
        {
          ...SPEC,
          dealer_name: "Shakti Battery House",
          dealer_price: 5200,
          margin_value: 1300,
        } as never,
      ],
    });
    const leaked = allValues(q);
    expect(leaked).not.toContain("Shakti Battery House");
    expect(leaked).not.toContain(5200);
    expect(leaked).not.toContain(1300);
  });

  it.each(VENDOR_FORBIDDEN_KEYS)("%s still absent with every spec field populated", (key) => {
    const q = toVendorQuotation({
      quotation_no: "QTN-1",
      pickup_city: "Nashik",
      pickup_state: "Maharashtra",
      lines: [SPEC],
    });
    expect(allKeys(q).has(key)).toBe(false);
  });
});

describe("lot weight never overstates what was declared", () => {
  const line = (id: string, qty: number, w: number | null) => ({
    line_id: id,
    quantity: qty,
    condition: "WORKING" as const,
    voltage: 60,
    ah: 120,
    ask_price: 100,
    unit_weight_kg: w,
  });

  it("sums the declared weights", () => {
    const q = toVendorQuotation({
      quotation_no: "Q",
      pickup_city: null,
      pickup_state: null,
      lines: [line("a", 10, 12.5), line("b", 2, 5)],
    });
    expect(q.total_weight_kg).toBe(135);
    expect(q.weight_caveat).toBeNull();
  });

  it("carries a caveat when only some lines declared — never a silent partial total", () => {
    // The failure this module keeps repeating: a number true of a subset,
    // rendered as though true of the whole. 125kg over a 2-SKU lot reads as the
    // lot's weight; it is one SKU's.
    const q = toVendorQuotation({
      quotation_no: "Q",
      pickup_city: null,
      pickup_state: null,
      lines: [line("a", 10, 12.5), line("b", 2, null)],
    });
    expect(q.total_weight_kg).toBe(125);
    expect(q.weight_caveat).toBe("1 of 2 SKUs declared a weight");
  });

  it("is null — not zero — when nobody declared a weight", () => {
    // Zero would read as "these batteries weigh nothing".
    const q = toVendorQuotation({
      quotation_no: "Q",
      pickup_city: null,
      pickup_state: null,
      lines: [line("a", 10, null)],
    });
    expect(q.total_weight_kg).toBeNull();
  });

  it("treats a nonsensical declared weight as undeclared", () => {
    const q = toVendorQuotation({
      quotation_no: "Q",
      pickup_city: null,
      pickup_state: null,
      lines: [line("a", 10, 0)],
    });
    expect(q.total_weight_kg).toBeNull();
  });
});

// ===========================================================================
// E-195 — the vendor dashboard. Same clause as the quotation, new surface:
// a vendor with a login can now READ, not just receive a PDF. Everything the
// quotation must not say, the dashboard must not say either.
// ===========================================================================
describe("vendor thread payload (E-195) excludes dealer identity and our economics", () => {
  const thread = toVendorThread({
    thread_id: "thr-1",
    quotation_no: "QTN-1024-1",
    status: "COUNTERED",
    pickup_city: "Nashik",
    pickup_state: "Maharashtra",
    sent_at: "2026-07-13T00:00:00Z",
    responded_at: "2026-07-14T00:00:00Z",
    lines: [
      {
        line_id: "line-1",
        quantity: 3,
        condition: "WORKING",
        voltage: 60,
        ah: 120,
        ask_price: 6500,
        counter_price: 6000,
        agreed_price: null,
      },
      {
        line_id: "line-2",
        quantity: 2,
        condition: "DEAD",
        voltage: 58,
        ah: 110,
        ask_price: 3900,
        counter_price: 3500,
        agreed_price: null,
      },
    ],
  });

  const keys = allKeys(thread);

  it.each(VENDOR_FORBIDDEN_KEYS)("the key %s does not appear at any depth", (key) => {
    expect(keys.has(key)).toBe(false);
  });

  it("never carries the deal status — that is the dealer leg's narrative", () => {
    // DEALER_ACCEPTED/MARGIN_SET would tell a vendor we had already bought the
    // lot and roughly when. Their own thread status is all they are entitled to.
    expect(keys.has("status")).toBe(true);
    expect(thread.status).toBe("COUNTERED");
    expect(keys.has("deal_status")).toBe(false);
    expect(keys.has("offer_version")).toBe(false);
    expect(keys.has("deal_id")).toBe(false);
    expect(keys.has("request_id")).toBe(false);
  });

  it("gives the vendor their own numbers, both directions", () => {
    expect(thread.ask_total).toBe(3 * 6500 + 2 * 3900);
    expect(thread.counter_total).toBe(3 * 6000 + 2 * 3500);
    expect(thread.agreed_total).toBeNull();
    expect(thread.total_units).toBe(5);
  });

  it("closes the door on a struck or lost thread", () => {
    const base = {
      thread_id: "thr-1",
      quotation_no: "QTN-1024-1",
      pickup_city: null,
      pickup_state: null,
      sent_at: null,
      responded_at: null,
      lines: [],
    };
    expect(toVendorThread({ ...base, status: "SENT" }).can_respond).toBe(true);
    expect(toVendorThread({ ...base, status: "COUNTERED" }).can_respond).toBe(true);
    expect(toVendorThread({ ...base, status: "AGREED" }).can_respond).toBe(false);
    expect(toVendorThread({ ...base, status: "LOST" }).can_respond).toBe(false);
  });

  it("a NEW dealer column cannot ride along into a thread", () => {
    const contaminated = toVendorThread({
      thread_id: "thr-2",
      quotation_no: "QTN-1024-2",
      status: "SENT",
      pickup_city: "Nashik",
      pickup_state: "Maharashtra",
      sent_at: null,
      responded_at: null,
      lines: [
        {
          line_id: "line-1",
          quantity: 3,
          condition: "WORKING",
          voltage: 60,
          ah: 120,
          ask_price: 6500,
          dealer_name: "Shakti Battery House",
          dealer_price: 5200,
          margin_value: 1300,
        } as never,
      ],
    });

    const leaked = allValues(contaminated);
    expect(leaked).not.toContain("Shakti Battery House");
    expect(leaked).not.toContain(5200);
    expect(leaked).not.toContain(1300);
    expect(allKeys(contaminated).has("dealer_name")).toBe(false);
    expect(allKeys(contaminated).has("dealer_price")).toBe(false);
  });
});
