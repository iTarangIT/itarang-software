import { describe, it, expect } from "vitest";
import { parseTurns } from "../CallTranscript";

// Splitting a provider transcript into speaker turns.
//
// The asymmetry that matters: mislabelling a turn is worse than not labelling
// it. A reviewer reads this to decide whether the AI misread the call, so a
// dealer's line shown as the AI's (or vice versa) actively inverts the thing
// they are checking. When the format is not clearly present, fall back to one
// untagged block rather than guessing.

describe("parseTurns — tagged transcripts", () => {
  it("splits agent/user lines and maps them to AI/Dealer", () => {
    const turns = parseTurns(
      [
        "agent: नमस्ते sir, Priya बोल रही हूँ iTarang से।",
        "user: हाँ, बोलिए।",
        "agent: क्या आप lithium batteries में deal करते हैं?",
        "user: 60V 100Ah pe kaam karta hoon.",
      ].join("\n"),
    );

    expect(turns).toHaveLength(4);
    expect(turns[0].speaker).toBe("agent");
    expect(turns[1].speaker).toBe("dealer");
    expect(turns[1].text).toBe("हाँ, बोलिए।");
    expect(turns[3].text).toBe("60V 100Ah pe kaam karta hoon.");
  });

  it("treats `assistant` as the AI and `human` as the dealer", () => {
    const turns = parseTurns("assistant: hello\nhuman: haan bhai\nassistant: ok");
    expect(turns.map((t) => t.speaker)).toEqual(["agent", "dealer", "agent"]);
  });

  it("strips the prefix from the rendered text", () => {
    const turns = parseTurns("agent: one\nuser: two");
    expect(turns[0].text).toBe("one");
    expect(turns[1].text).toBe("two");
  });

  it("drops blank lines rather than rendering empty turns", () => {
    const turns = parseTurns("agent: one\n\n\nuser: two\n");
    expect(turns).toHaveLength(2);
  });

  it("keeps a colon inside the dealer's own words", () => {
    const turns = parseTurns("agent: kitne?\nuser: rate: 5000 rupees");
    expect(turns[1].speaker).toBe("dealer");
    expect(turns[1].text).toBe("rate: 5000 rupees");
  });
});

describe("parseTurns — untagged transcripts must NOT be guessed", () => {
  it("returns one untagged block for plain prose", () => {
    const raw = "The dealer confirmed he sells 60V batteries and wants a callback.";
    const turns = parseTurns(raw);
    expect(turns).toHaveLength(1);
    expect(turns[0].speaker).toBeNull();
    expect(turns[0].text).toBe(raw);
  });

  it("does not switch on turn parsing for one stray colon-prefixed line", () => {
    // Older rows and non-Bolna providers store prose. A single "note:" must not
    // make the whole transcript render as one giant AI turn, which would
    // attribute every word the dealer said to the bot.
    const raw = [
      "note: call was noisy",
      "He said he works on lithium and asked us to call back.",
      "Nothing else was discussed.",
    ].join("\n");
    const turns = parseTurns(raw);
    expect(turns).toHaveLength(1);
    expect(turns[0].speaker).toBeNull();
  });

  it("still parses when a minority of lines lack a prefix", () => {
    const turns = parseTurns(
      ["agent: one", "user: two", "agent: three", "trailing noise"].join("\n"),
    );
    expect(turns).toHaveLength(4);
    expect(turns[0].speaker).toBe("agent");
    expect(turns[3].speaker).toBeNull();
  });

  it("handles an empty transcript without throwing", () => {
    expect(parseTurns("")).toEqual([{ speaker: null, text: "" }]);
  });
});
