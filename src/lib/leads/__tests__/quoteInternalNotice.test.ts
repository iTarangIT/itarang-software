import { describe, expect, it } from "vitest";

import { buildQuoteInternalNotice } from "@/lib/leads/quoteInternalNotice";

const base = {
  quoteNumber: "Q-1042",
  dealerName: "Sharma Batteries",
  total: 125000,
  phone: "919876543210",
  senderName: "Asha",
  note: null,
};

describe("buildQuoteInternalNotice", () => {
  it("puts dealer, channel and amount in the subject", () => {
    const n = buildQuoteInternalNotice(base);
    expect(n.subject).toBe("Quote Q-1042 sent to Sharma Batteries on WhatsApp, ₹1,25,000");
  });

  it("drops the amount clause when there is no total", () => {
    const n = buildQuoteInternalNotice({ ...base, total: null });
    expect(n.subject).toBe("Quote Q-1042 sent to Sharma Batteries on WhatsApp");
    expect(n.text).not.toContain("Amount");
  });

  it("falls back when the dealer has no name", () => {
    const n = buildQuoteInternalNotice({ ...base, dealerName: "  " });
    expect(n.subject).toContain("sent to the dealer on WhatsApp");
  });

  it("shows the number with a leading + and the sender", () => {
    const n = buildQuoteInternalNotice(base);
    expect(n.text).toContain("WhatsApp: +919876543210");
    expect(n.text).toContain("Sent by: Asha");
  });

  it("includes the covering note, HTML-escaped", () => {
    const n = buildQuoteInternalNotice({ ...base, note: "<b>10% off</b> & free delivery" });
    expect(n.text).toContain("<b>10% off</b> & free delivery");
    expect(n.html).toContain("&lt;b&gt;10% off&lt;/b&gt; &amp; free delivery");
    expect(n.html).not.toContain("<b>10% off</b>");
  });

  it("never carries an approval link", () => {
    const n = buildQuoteInternalNotice(base);
    expect(n.text).not.toMatch(/https?:\/\//);
    expect(n.html).not.toMatch(/href=/);
  });
});
