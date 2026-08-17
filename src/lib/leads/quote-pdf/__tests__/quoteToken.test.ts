/**
 * E-243 — the approval token is the only thing standing between a stranger and
 * approving somebody else's quotation, so its failure modes are pinned here.
 */
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mintQuoteToken,
  quoteApprovalUrl,
  readQuoteToken,
} from "../../quoteToken";

const CLAIMS = {
  commercialId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  versionNo: 2,
};

const ORIGINAL_SECRET = process.env.QUOTE_TOKEN_SECRET;
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

beforeAll(() => {
  process.env.QUOTE_TOKEN_SECRET = "test-secret-do-not-use-in-production";
  process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.com";
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.QUOTE_TOKEN_SECRET;
  else process.env.QUOTE_TOKEN_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

describe("round trip", () => {
  it("reads back exactly what was signed", () => {
    expect(readQuoteToken(mintQuoteToken(CLAIMS))).toEqual(CLAIMS);
  });

  it("is stable — the same claims mint the same token", () => {
    // Stateless by design: there is no row to look up, so the same quotation
    // must always produce the same link.
    expect(mintQuoteToken(CLAIMS)).toBe(mintQuoteToken(CLAIMS));
  });

  it("survives a URL and a base64url alphabet", () => {
    const token = mintQuoteToken(CLAIMS);
    expect(token).not.toMatch(/[+/=]/);
    expect(encodeURIComponent(token)).toBe(token);
  });
});

describe("rejects anything it did not mint", () => {
  it("rejects a tampered signature", () => {
    const token = mintQuoteToken(CLAIMS);
    const broken = `${token.slice(0, -1)}${token.at(-1) === "a" ? "b" : "a"}`;
    expect(readQuoteToken(broken)).toBeNull();
  });

  it("rejects a tampered payload — the whole point", () => {
    // Swap in a different commercial id, keeping the original signature.
    const token = mintQuoteToken(CLAIMS);
    const sig = token.slice(token.lastIndexOf(".") + 1);
    const forged = Buffer.from(
      "00000000-0000-0000-0000-000000000000.2",
      "utf8",
    ).toString("base64url");
    expect(readQuoteToken(`${forged}.${sig}`)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = mintQuoteToken(CLAIMS);
    process.env.QUOTE_TOKEN_SECRET = "a-completely-different-secret";
    try {
      expect(readQuoteToken(token)).toBeNull();
    } finally {
      process.env.QUOTE_TOKEN_SECRET = "test-secret-do-not-use-in-production";
    }
  });

  it.each([
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
    ["no separator", "abcdef"],
    ["leading separator", ".abc"],
    ["not base64", "!!!.abc"],
    ["signature only", ".x"],
  ])("rejects %s", (_label, input) => {
    expect(readQuoteToken(input as string)).toBeNull();
  });

  it("rejects a payload with a non-numeric version", () => {
    // Hand-built so the signature is genuinely valid over a bad payload — this
    // is the case a signature check alone would let through.
    const bad = "3f2504e0-4f89-11d3-9a0c-0305e82c3301.notanumber";
    const sig = createHmac("sha256", process.env.QUOTE_TOKEN_SECRET!)
      .update(bad, "utf8")
      .digest("hex")
      .slice(0, 32);
    const token = `${Buffer.from(bad, "utf8").toString("base64url")}.${sig}`;
    expect(readQuoteToken(token)).toBeNull();
  });
});

describe("version binding", () => {
  it("gives a different token per version, so a link cannot open a revision", () => {
    const v2 = mintQuoteToken({ ...CLAIMS, versionNo: 2 });
    const v3 = mintQuoteToken({ ...CLAIMS, versionNo: 3 });
    expect(v2).not.toBe(v3);
    expect(readQuoteToken(v3)?.versionNo).toBe(3);
  });
});

describe("quoteApprovalUrl", () => {
  it("is absolute — it goes into an email and a WhatsApp message", () => {
    const url = quoteApprovalUrl(CLAIMS);
    expect(url.startsWith("https://crm.example.com/quote/")).toBe(true);
    const token = url.split("/quote/")[1];
    expect(readQuoteToken(token)).toEqual(CLAIMS);
  });

  it("does not double up slashes when the base URL has a trailing one", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.com/";
    try {
      expect(quoteApprovalUrl(CLAIMS)).not.toContain("com//quote");
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = "https://crm.example.com";
    }
  });
});
