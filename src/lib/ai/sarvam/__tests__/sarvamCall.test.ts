import { describe, expect, it } from "vitest";
import {
  buildSarvamAgentVariables,
  SARVAM_SHOP_NAME_FALLBACK,
  sarvamCostPaise,
  sarvamErrorText,
} from "../callHelpers";
import { sarvamWebhookTokenValid } from "../webhookAuth";
import {
  assertNeverProvider,
  DIALER_PROVIDER_AI_OWNER,
  DIALER_PROVIDER_CALL_ENDPOINT,
  DIALER_PROVIDER_LABEL,
  DIALER_PROVIDERS,
  isDialerProvider,
  toDialerProvider,
} from "@/lib/ai/providers";

describe("agent variables", () => {
  it("passes shop, owner and location through, trimmed", () => {
    expect(
      buildSarvamAgentVariables({ shop_name: " Gupta Battery ", dealer_name: "Gupta ji", location: "Lucknow " }),
    ).toEqual({ shop_name: "Gupta Battery", owner_name: "Gupta ji", location: "Lucknow" });
  });

  it("never sends a blank shop_name: owner name, then a neutral phrase", () => {
    expect(buildSarvamAgentVariables({ shop_name: "  ", dealer_name: "Gupta ji" }).shop_name).toBe("Gupta ji");
    expect(buildSarvamAgentVariables({ shop_name: null, dealer_name: null }).shop_name).toBe(
      SARVAM_SHOP_NAME_FALLBACK,
    );
  });
});

describe("422 error text", () => {
  it("joins the detail list", () => {
    expect(
      sarvamErrorText(
        { detail: [{ loc: ["body", "user_config", "user_phone_number"], msg: "invalid phone" }] },
        422,
      ),
    ).toBe("body.user_config.user_phone_number: invalid phone");
  });
  it("falls back to the HTTP status", () => {
    expect(sarvamErrorText(null, 500)).toBe("Sarvam call failed (HTTP 500)");
    expect(sarvamErrorText({ detail: "Not authenticated" }, 401)).toBe("Not authenticated");
  });
});

describe("cost from duration × rate", () => {
  it("computes INR paise", () => {
    expect(sarvamCostPaise(60, 4.5)).toBe(450);
    expect(sarvamCostPaise(90, 4)).toBe(600);
    expect(sarvamCostPaise(0, 4)).toBe(0);
  });
  it("is null without a rate or a duration", () => {
    expect(sarvamCostPaise(60, null)).toBeNull();
    expect(sarvamCostPaise(null, 4)).toBeNull();
  });
});

describe("webhook token", () => {
  it("accepts only the exact token", () => {
    expect(sarvamWebhookTokenValid("abc123", "abc123")).toBe(true);
    expect(sarvamWebhookTokenValid("abc124", "abc123")).toBe(false);
    expect(sarvamWebhookTokenValid("abc", "abc123")).toBe(false);
  });
  it("an unset secret accepts nothing", () => {
    expect(sarvamWebhookTokenValid("", "")).toBe(false);
    expect(sarvamWebhookTokenValid("x", undefined)).toBe(false);
    expect(sarvamWebhookTokenValid(null, "abc")).toBe(false);
  });
});

describe("provider list", () => {
  it("has sarvam, and every map covers every provider", () => {
    expect(DIALER_PROVIDERS).toContain("sarvam");
    for (const p of DIALER_PROVIDERS) {
      expect(DIALER_PROVIDER_LABEL[p]).toBeTruthy();
      expect(DIALER_PROVIDER_AI_OWNER[p]).toBeTruthy();
      expect(DIALER_PROVIDER_CALL_ENDPOINT[p]).toMatch(/^\/api\//);
    }
    expect(DIALER_PROVIDER_CALL_ENDPOINT.sarvam).toBe("/api/sarvam/call");
  });

  it("a sarvam value stays sarvam — never falls back to bolna", () => {
    expect(toDialerProvider("sarvam")).toBe("sarvam");
    expect(toDialerProvider(" SARVAM ")).toBe("sarvam");
    expect(isDialerProvider("sarvam")).toBe(true);
  });

  it("unknown values fall back to the given default", () => {
    expect(toDialerProvider("neodove")).toBe("bolna");
    expect(toDialerProvider(null)).toBe("bolna");
    expect(toDialerProvider(undefined, "elevenlabs")).toBe("elevenlabs");
    expect(isDialerProvider("neodove")).toBe(false);
  });

  it("assertNeverProvider throws on a value the switch missed", () => {
    expect(() => assertNeverProvider("x" as never)).toThrow(/Unhandled dialer provider/);
  });
});
