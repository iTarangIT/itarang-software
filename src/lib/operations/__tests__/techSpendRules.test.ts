import { describe, expect, it } from "vitest";

import { classifyTechSpend } from "../techSpendRules";

/**
 * Every case below is a REAL row from expense_submissions with
 * `bucket = 'tech' AND status = 'approved'` — the population /operations/spend
 * calls Tech Spend. The out-of-repo classifier that writes `bucket` put all of
 * them there; roughly ₹6.8L of the ₹11.0L had no business being in a technology
 * run-rate.
 *
 * Both directions are asserted. A rule set that only ever excludes is as broken
 * as one that only ever includes, and the exclusion rules here are aggressive
 * enough that guarding the genuine vendors matters more than guarding the
 * exclusions.
 */

const verdict = (vendor: string | null, description: string | null) =>
  classifyTechSpend({ vendor, description });

describe("exclusions — why Tech Spend was ₹6.8L too high", () => {
  it("drops invoices from our own entity, in every spelling in the data", () => {
    // The headline defect. The out-of-repo rule keys on the vendor's legal
    // name, and ours contains "TECHNOLOGIES".
    for (const name of [
      "ITARANG TECHNOLOGIES LLP",
      "iTarang Technologies LLP",
      "Itarang Technologies Llp",
    ]) {
      const v = verdict(name, "GST Payment");
      expect(v.include, name).toBe(false);
      expect(v.reason, name).toBe("own-entity");
    }
  });

  it("drops a gift hamper billed by our own entity", () => {
    // ₹24,072, filed as technology spend.
    expect(
      verdict("Itarang Technologies Llp", "5 Sets of Forrest Essential Gift Hamper")
        .include,
    ).toBe(false);
  });

  it("drops statutory payments whoever the counterparty is", () => {
    expect(verdict("Some Vendor Pvt Ltd", "GST Payment").reason).toBe("statutory");
    expect(
      verdict("Some Vendor Pvt Ltd", "TDS/TCS Payable by Taxpayer").reason,
    ).toBe("statutory");
  });

  it("drops recruitment spend", () => {
    // Naukri. Belongs to HR; arrived as tech because Info Edge is a "Ltd".
    const v = verdict(
      "Info Edge (India) Ltd",
      "Naukri Sourcing Solution - 1 Hot Vacancy Job Posting",
    );
    expect(v.include).toBe(false);
    expect(v.reason).toBe("recruitment");
  });

  it("drops retail hardware, which is capex rather than a run-rate", () => {
    expect(verdict("Vijay Sales (India) Pvt. Ltd.", "Laptop purchase").reason).toBe(
      "hardware-retail",
    );
    expect(
      verdict("Samsung India Electronics Pvt. Ltd.", "Mobile Phone").reason,
    ).toBe("hardware-retail");
    expect(
      verdict("PROVIDENCE TECHNO SERVICES", "Purchase of EliteBook 840 G3").reason,
    ).toBe("hardware-retail");
    expect(
      verdict(
        "DAWNTECH ELECTRONICS PRIVATE LIMITED",
        "VW 80 cm (32 inches) Frameless Series HD Ready Android Smart LED TV",
      ).reason,
    ).toBe("hardware-retail");
  });

  it("blames the DESCRIPTION, not the vendor, when the two disagree", () => {
    // ₹1,34,900 of iPhones bought from a telecom company. Both readings
    // exclude it; only one of them tells the operator what it actually was.
    const v = verdict("Maruti Nandan Telecomm LLP", "Purchase of iPhone and accessories");
    expect(v.include).toBe(false);
    expect(v.reason).toBe("hardware-retail");
  });

  it("drops telecom lines", () => {
    expect(
      verdict("ILAIMITADO PRIVATE LIMITED", "Telecommunication - Voice Call Services")
        .reason,
    ).toBe("telecom");
  });

  it("drops training even when its description is full of software words", () => {
    // Matched the include term "cloud" before TRAINING_TERMS was ordered ahead
    // of the software rules, and entered Tech Spend as a cloud subscription.
    const v = verdict(
      "KRISHAI Technologies Private Limited",
      "Agentic AI AgentOps Specialization Bootcamp 3.0 with Cloud",
    );
    expect(v.include).toBe(false);
    expect(v.reason).toBe("training");
  });

  it("drops consulting and support labour billed by a company", () => {
    expect(
      verdict("BHARATNXT WAVE SERVICES PRIVATE LIMITED", "Consulting Service").reason,
    ).toBe("professional-services");
    expect(
      verdict(
        "ILAIMITADO PRIVATE LIMITED",
        "Information Technology Consulting and Support Services",
      ).reason,
    ).toBe("professional-services");
  });

  it("drops an individual consultant — labour, not a subscription", () => {
    // ₹1,95,390 across four invoices, the single largest line in Tech Spend.
    const v = verdict("Kartik Aggarwal", "Consultation services");
    expect(v.include).toBe(false);
    expect(v.reason).toBe("individual-consultant");
  });
});

describe("inclusions — the spend that must survive", () => {
  it("keeps every vendor this codebase integrates against", () => {
    const kept: Array<[string, string]> = [
      ["Anthropic, PBC", "Max plan - 20x Aug 7–Sep 7, 2026"],
      ["Hostinger PTE", "KVM 2 (billed every month)"],
      ["Eleven Labs Inc.", "Creator subscription for Jun 1–Jul 1, 2026"],
      ["Decentro Tech Private Limited", "KYC and Accounts services"],
      ["Jio Haptik Technologies Limited", "Wallet Recharge for Conversation Charges"],
      ["OpenRouter, Inc", "OpenRouter Credits"],
      ["Fireflies.ai Corp", "Pro Fireflies Plan (per seat)"],
    ];
    for (const [vendor, description] of kept) {
      expect(verdict(vendor, description).include, vendor).toBe(true);
    }
  });

  it("keeps OpenAI despite its name looking like three plain words", () => {
    // "openai opco llc" is three alphabetic tokens, so the individual-name
    // heuristic classified ₹476.35 of API spend as a freelancer. A guess about
    // the SHAPE of a name must not overrule a vendor we can actually name.
    const v = verdict("OpenAI OpCo, LLC", "OpenAI API usage credit");
    expect(v.include).toBe(true);
    expect(v.reason).toBe("known-software-vendor");
  });

  it("keeps a SaaS subscription from a vendor VENDORS does not list", () => {
    expect(verdict("Canva Pty. Ltd.", "Canva Pro Subscription").reason).toBe(
      "software-description",
    );
    expect(
      verdict("Delovita Services Private Limited", "Platform & Software Fee").reason,
    ).toBe("software-description");
  });

  it("keeps a vendor that trades as a software company", () => {
    expect(
      verdict("Snowebs Software Technologies P Ltd", "dayTrack Service and Setup Charges")
        .include,
    ).toBe(true);
    expect(verdict("Avifa Infotech Pvt Ltd", "Godial Monthly With Rec").include).toBe(
      true,
    );
  });

  it("does NOT treat 'technologies' as a software signal", () => {
    // That token is exactly what the out-of-repo rule keys on, and it is what
    // files our own GST payment as tech. Half the companies in India carry it.
    const v = verdict("Mindsbeam Technologies Pvt Ltd", "Enterprise - Quarterly Charges");
    expect(v.include).toBe(false);
    expect(v.reason).toBe("unclassified");
  });
});

describe("the unclassified residual", () => {
  it("excludes what it cannot recognise, but names it as unreviewed", () => {
    // Excluded from the headline AND itemised on the page. Silently keeping it
    // puts unverified money in the total; silently dropping it makes the total
    // unexplainable.
    const v = verdict("AIENERZY SYSTEMS PRIVATE LIMITED", "Griot IOT");
    expect(v.include).toBe(false);
    expect(v.reason).toBe("unclassified");
    expect(v.explanation).toContain("review");
  });

  it("handles a row with no vendor and no description without throwing", () => {
    const v = verdict(null, null);
    expect(v.include).toBe(false);
    expect(v.reason).toBe("unclassified");
  });
});

describe("the rules generalise", () => {
  it("keys on vendor and description only — never on amount or date", () => {
    // Hardcoding "exclude invoice #4471" would fix this month and rot silently.
    // The same inputs must always give the same verdict.
    const a = verdict("Kartik Aggarwal", "Consultation services");
    const b = verdict("Kartik Aggarwal", "Consultation services");
    expect(a).toEqual(b);
  });

  it("can only ever narrow — every verdict is a decision about one row", () => {
    // The SQL scope (bucket='tech' AND status='approved') stays the outer
    // filter, so no rule here can introduce an invoice that was not already in.
    for (const v of [
      verdict("Anthropic, PBC", "Max plan"),
      verdict("Kartik Aggarwal", "Consultation services"),
      verdict(null, null),
    ]) {
      expect(typeof v.include).toBe("boolean");
      expect(v.explanation.length).toBeGreaterThan(0);
    }
  });
});
