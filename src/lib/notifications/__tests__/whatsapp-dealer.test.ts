// Pile B items 9–10 — the NBFC-status → dealer WhatsApp map. Pure; no db.

import { describe, expect, it } from "vitest";

import { CATEGORY_BY_TYPE, emailLockedTypes } from "@/lib/notifications/catalog";
import {
  DIRECT_PUSH_TYPES,
  WHATSAPP_DEALER_TYPES,
  buildDealerWhatsAppMessage,
  dealerWhatsAppDedupeKey,
  isDealerWhatsAppType,
} from "@/lib/notifications/whatsapp-dealer";
import { canRecordDealerPayment } from "@/lib/leads/dealer-payment-confirmation-rules";
import { leadStatusLabel } from "@/lib/whatsapp/labels";
import { parseLeadAction, leadActionId } from "@/lib/whatsapp/leadActionButton";
import { TYPE_LABELS } from "@/lib/notifications/registry";

const ctx = {
  greetName: "Acme Motors",
  customerName: "Ravi Kumar",
  referenceId: "LEAD-20260917-0001",
};

describe("WHATSAPP_DEALER_TYPES", () => {
  it("only maps real catalogued types", () => {
    for (const type of Object.keys(WHATSAPP_DEALER_TYPES)) {
      expect(CATEGORY_BY_TYPE[type], type).toBeDefined();
    }
  });

  it("covers every NBFC status change the plan names", () => {
    for (const t of [
      "fi.assigned",
      "fi.reviewed",
      "fi.reinspection",
      "vkyc.initiated",
      "vkyc.approved",
      "vkyc.rejected",
      "enach.confirmed",
      "enach.failed",
      "enach.waived",
      "agreement.initiated",
      "agreement.signed",
    ]) {
      expect(isDealerWhatsAppType(t), t).toBe(true);
    }
  });

  it("never maps a type whose flow already pushes (or that admin must gate)", () => {
    for (const t of DIRECT_PUSH_TYPES) {
      expect(isDealerWhatsAppType(t), t).toBe(false);
    }
  });

  it("builds a body and a one-line template param for every mapped type", () => {
    for (const type of Object.keys(WHATSAPP_DEALER_TYPES)) {
      const msg = buildDealerWhatsAppMessage(type, { ...ctx, data: {} })!;
      expect(msg.body).toContain("Ravi Kumar");
      expect(msg.body).toContain(ctx.referenceId);
      expect(msg.whatIsNeeded).not.toMatch(/\n/);
      expect(msg.whatIsNeeded.length).toBeLessThan(220);
    }
  });

  it("splits FI reviewed into passed / failed by outcome, with the reason", () => {
    const pass = buildDealerWhatsAppMessage("fi.reviewed", { ...ctx, data: { outcome: "Passed" } })!;
    const fail = buildDealerWhatsAppMessage("fi.reviewed", {
      ...ctx,
      data: { outcome: "Failed", notes: "Address not found" },
    })!;
    expect(pass.body).toMatch(/passed/i);
    expect(fail.body).toMatch(/failed/i);
    expect(fail.body).toContain("Address not found");
  });

  it("returns null for unmapped types", () => {
    expect(buildDealerWhatsAppMessage("loan.sanctioned", ctx)).toBeNull();
    expect(buildDealerWhatsAppMessage("toString", ctx)).toBeNull();
  });

  it("dedupes the same fact but not a new outcome", () => {
    const a = dealerWhatsAppDedupeKey("fi.reviewed", "L1", { outcome: "Failed" });
    const b = dealerWhatsAppDedupeKey("fi.reviewed", "L1", { outcome: "Failed" });
    const c = dealerWhatsAppDedupeKey("fi.reviewed", "L1", { outcome: "Passed" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("E-298 payment confirmation", () => {
  it("registers, labels and locks the new types", () => {
    for (const t of ["loan.payment_pending", "loan.payment_received", "loan.payment_not_received"]) {
      expect(CATEGORY_BY_TYPE[t], t).toBe("Loan & Sanction");
      expect(TYPE_LABELS[t], t).toBeTruthy();
    }
    expect(emailLockedTypes()).toContain("loan.payment_not_received");
  });

  it("accepts an answer only while pending / not_received", () => {
    expect(canRecordDealerPayment("pending")).toBe(true);
    expect(canRecordDealerPayment("not_received")).toBe(true);
    expect(canRecordDealerPayment("received")).toBe(false);
    expect(canRecordDealerPayment(null)).toBe(false);
  });

  it("round-trips pay_ok / pay_no button ids (typeable)", () => {
    const lead = "LEAD-20260917-0001";
    expect(parseLeadAction(leadActionId("pay_ok", lead))).toEqual({ action: "pay_ok", leadId: lead });
    expect(parseLeadAction(` pay_no:${lead} `)).toEqual({ action: "pay_no", leadId: lead });
  });
});

describe("leadStatusLabel", () => {
  it("humanises known and unknown statuses", () => {
    expect(leadStatusLabel("pending_final_approval")).toBe("Awaiting final approval");
    expect(leadStatusLabel(null)).toBe("Draft");
    expect(leadStatusLabel("some_new_state")).toBe("Some new state");
  });
});
