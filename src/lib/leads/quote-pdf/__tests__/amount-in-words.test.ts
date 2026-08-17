import { describe, expect, it } from "vitest";
import { amountInWords } from "../amount-in-words";

describe("amountInWords — matches ITPI-35", () => {
  it("renders the reference document's total exactly as printed", () => {
    // docs/ITPI-35 (1).pdf, "Total In Words".
    expect(amountInWords(980_295)).toBe(
      "Indian Rupee Nine Lakh Eighty Thousand Two Hundred Ninety-Five Only",
    );
  });
});

describe("Indian grouping", () => {
  it.each([
    [0, "Indian Rupee Zero Only"],
    [1, "Indian Rupee One Only"],
    [15, "Indian Rupee Fifteen Only"],
    [20, "Indian Rupee Twenty Only"],
    [95, "Indian Rupee Ninety-Five Only"],
    [100, "Indian Rupee One Hundred Only"],
    [295, "Indian Rupee Two Hundred Ninety-Five Only"],
    [1_000, "Indian Rupee One Thousand Only"],
    [80_000, "Indian Rupee Eighty Thousand Only"],
    [100_000, "Indian Rupee One Lakh Only"],
    [841_500, "Indian Rupee Eight Lakh Forty-One Thousand Five Hundred Only"],
    [10_000_000, "Indian Rupee One Crore Only"],
    [12_34_56_789, "Indian Rupee Twelve Crore Thirty-Four Lakh Fifty-Six Thousand Seven Hundred Eighty-Nine Only"],
  ])("%d", (n, expected) => {
    expect(amountInWords(n)).toBe(expected);
  });

  it("groups after the first thousand in twos, not threes", () => {
    // The western reading would be "One Hundred Thousand"; the Indian one is
    // "One Lakh". This is the whole reason this module exists.
    expect(amountInWords(100_000)).toBe("Indian Rupee One Lakh Only");
  });
});

describe("paise", () => {
  it("omits paise entirely on a whole-rupee amount", () => {
    // ITPI-35 prints no "and Zero Paise", so neither do we.
    expect(amountInWords(500)).toBe("Indian Rupee Five Hundred Only");
  });

  it("spells paise when there are any", () => {
    expect(amountInWords(500.5)).toBe(
      "Indian Rupee Five Hundred and Fifty Paise Only",
    );
  });

  it("rounds to paise before spelling, so words match the printed total", () => {
    // Rounding carries into the rupees rather than spelling a truncated one.
    expect(amountInWords(2.999)).toBe("Indian Rupee Three Only");
    expect(amountInWords(2.994)).toBe(
      "Indian Rupee Two and Ninety-Nine Paise Only",
    );
  });
});

describe("edge cases", () => {
  it("labels a negative amount rather than dropping the sign", () => {
    expect(amountInWords(-100)).toBe("Minus Indian Rupee One Hundred Only");
  });

  it("returns an empty string for a non-finite amount", () => {
    expect(amountInWords(Number.NaN)).toBe("");
    expect(amountInWords(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("honours a custom currency label and suffix", () => {
    expect(amountInWords(5, { currencyLabel: "INR", suffix: "" })).toBe(
      "INR Five ",
    );
  });
});
