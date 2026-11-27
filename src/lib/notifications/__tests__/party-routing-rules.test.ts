import { describe, expect, it } from "vitest";

import {
  buildPartyWhatsApp,
  channelsForPerson,
  emptyRule,
  isFileType,
  normalizePartyRouting,
  suggestedRule,
  type PartyKey,
} from "../party-routing-rules";

const set = (...p: PartyKey[]) => new Set<PartyKey>(p);

describe("party routing rules", () => {
  it("lead-file types are governed, others are not", () => {
    expect(isFileType("loan.sanctioned")).toBe(true);
    expect(isFileType("nbfc.cibil_approved")).toBe(true);
    expect(isFileType("auction.outbid")).toBe(false);
  });

  it("normalize drops unknown types, parties and channels and coerces to booleans", () => {
    const out = normalizePartyRouting({
      rules: {
        "loan.sanctioned": { dealer: { bell: true, email: "yes", whatsapp: true, sms: true }, bogus: { bell: true } },
        "auction.outbid": { dealer: { bell: true } },
      },
    });
    expect(Object.keys(out.rules)).toEqual(["loan.sanctioned"]);
    expect(out.rules["loan.sanctioned"].dealer).toEqual({ bell: true, email: false, whatsapp: true });
    expect(out.rules["loan.sanctioned"].sales_head).toEqual({ bell: false, email: false, whatsapp: false });
    expect(normalizePartyRouting(null)).toEqual({ rules: {} });
  });

  it("a person gets the union of their parties' ticks", () => {
    const r = emptyRule();
    r.dealer.whatsapp = true;
    r.sales_head.email = true;
    expect(channelsForPerson(r, set("dealer", "sales_head"))).toEqual({ bell: false, email: true, whatsapp: true });
    expect(channelsForPerson(r, set("nbfc_child"))).toEqual({ bell: false, email: false, whatsapp: false });
  });

  it("the action person is judged only by the Action person column", () => {
    const r = suggestedRule(); // actor: bell only; nbfc_partner: everything
    expect(channelsForPerson(r, set("actor", "nbfc_partner"))).toEqual({ bell: true, email: false, whatsapp: false });
    expect(channelsForPerson(r, set("nbfc_partner"))).toEqual({ bell: true, email: true, whatsapp: true });
  });

  it("WhatsApp body carries title, message, customer, ref and who did it", () => {
    const body = buildPartyWhatsApp({ title: "Loan sanctioned", message: "₹1,20,000", customer: "Ravi", reference: "REF1", actor: "R. Mehta" });
    expect(body).toBe("*Loan sanctioned*\n₹1,20,000\nCustomer: Ravi\nRef: REF1\nBy: R. Mehta");
  });
});
