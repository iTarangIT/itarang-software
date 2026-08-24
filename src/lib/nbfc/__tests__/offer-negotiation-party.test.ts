import { describe, expect, it } from "vitest";

import {
  NEGOTIATION_PARTIES,
  NEGOTIATION_STATUSES,
} from "../offer-negotiation";

// E-265. These two constants are load-bearing against COLUMN WIDTHS that no
// CHECK constraint defends (E-238 chose route-layer enforcement), so a value
// that is too long fails at INSERT time in production rather than here.

describe("negotiation vocabulary vs column widths", () => {
  it("admits the customer as a third party", () => {
    expect(NEGOTIATION_PARTIES).toContain("customer");
    expect(NEGOTIATION_PARTIES).toContain("dealer");
    expect(NEGOTIATION_PARTIES).toContain("nbfc");
  });

  it("keeps every party inside nbfc_offer_negotiations.party varchar(8)", () => {
    // 'customer' is exactly 8 — this is why no migration was needed, and why a
    // future 'coborrower' (10) would need one.
    for (const p of NEGOTIATION_PARTIES) {
      expect(p.length, `party '${p}'`).toBeLessThanOrEqual(8);
    }
  });

  it("keeps every status inside nbfc_financing_offers.negotiation_status varchar(16)", () => {
    for (const s of NEGOTIATION_STATUSES) {
      expect(s.length, `status '${s}'`).toBeLessThanOrEqual(16);
    }
  });

  it("has no 'customer_countered' status — it would not fit", () => {
    // The distinction lives on the round's `party`, not the status. See E-265:
    // the status says whose TURN it is, `party` says who typed. If someone adds
    // this value the insert fails silently in production, not in review.
    expect("customer_countered".length).toBeGreaterThan(16);
    expect(NEGOTIATION_STATUSES).not.toContain(
      "customer_countered" as unknown as (typeof NEGOTIATION_STATUSES)[number],
    );
  });
});
