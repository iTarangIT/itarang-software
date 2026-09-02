import { describe, expect, it } from "vitest";
import { isTerminalModelFailure } from "@/lib/sales/terminalModelFailure";

describe("isTerminalModelFailure", () => {
  it("aborts on the exhausted-balance error the live run actually hit", () => {
    expect(
      isTerminalModelFailure(
        "429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
      ),
    ).toBe(true);
  });

  it("aborts on the other billing and auth failures", () => {
    expect(isTerminalModelFailure("429 insufficient_quota")).toBe(true);
    expect(
      isTerminalModelFailure("You exceeded your current quota, please check your plan"),
    ).toBe(true);
    expect(isTerminalModelFailure("Incorrect API key provided: sk-abc***")).toBe(true);
    expect(isTerminalModelFailure("invalid_api_key")).toBe(true);
    expect(isTerminalModelFailure("401 Unauthorized")).toBe(true);
  });

  it("does NOT abort on a rate-limit 429", () => {
    // The whole reason this matches wording rather than the status code. A
    // per-minute limit is transient; aborting would strand a scan that only
    // needed to go slower.
    expect(
      isTerminalModelFailure(
        "429 Rate limit reached for gpt-4o in organization org-x on requests per min (RPM): Limit 500, Used 500. Please try again in 120ms.",
      ),
    ).toBe(false);
    expect(isTerminalModelFailure("429 Too Many Requests")).toBe(false);
  });

  it("does not abort on failures that belong to one file", () => {
    expect(isTerminalModelFailure("Unsupported file type for extraction: text/html")).toBe(
      false,
    );
    expect(isTerminalModelFailure("Model returned non-JSON extraction output")).toBe(false);
    expect(isTerminalModelFailure("Empty extraction response from model")).toBe(false);
    expect(isTerminalModelFailure("socket hang up")).toBe(false);
    expect(isTerminalModelFailure("500 Internal Server Error")).toBe(false);
  });

  it("does not fire on a number that merely contains 401", () => {
    // A false positive aborts a healthy scan, so this is the regression an
    // earlier bare /401/ pattern would have caused.
    expect(isTerminalModelFailure("Total read as 1401.00 which cannot be an invoice amount")).toBe(
      false,
    );
    expect(isTerminalModelFailure("Invoice ITG/202627/401 is already recorded.")).toBe(false);
  });

  it("treats an absent message as non-terminal", () => {
    expect(isTerminalModelFailure(null)).toBe(false);
    expect(isTerminalModelFailure(undefined)).toBe(false);
    expect(isTerminalModelFailure("")).toBe(false);
  });
});
