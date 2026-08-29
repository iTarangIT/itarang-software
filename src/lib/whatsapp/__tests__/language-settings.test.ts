import { describe, expect, it } from "vitest";

import {
  isWhatsAppLanguage,
  normalizeWhatsAppLanguageSettings,
  WHATSAPP_LANGUAGES,
} from "../language";
import { fitToKind, translationHash } from "../translate-core";

describe("normalizeWhatsAppLanguageSettings", () => {
  it("defaults to english", () => {
    expect(normalizeWhatsAppLanguageSettings(undefined)).toEqual({ language: "english" });
    expect(normalizeWhatsAppLanguageSettings(null)).toEqual({ language: "english" });
    expect(normalizeWhatsAppLanguageSettings({})).toEqual({ language: "english" });
  });

  it("accepts exactly the three languages, case-insensitively", () => {
    for (const l of WHATSAPP_LANGUAGES) {
      expect(normalizeWhatsAppLanguageSettings({ language: l }).language).toBe(l);
    }
    expect(normalizeWhatsAppLanguageSettings({ language: "Hindi" }).language).toBe("hindi");
  });

  it("keeps the base value on an unknown language", () => {
    expect(
      normalizeWhatsAppLanguageSettings({ language: "marathi" }, { language: "hinglish" }),
    ).toEqual({ language: "hinglish" });
    expect(isWhatsAppLanguage("marathi")).toBe(false);
    expect(isWhatsAppLanguage(42)).toBe(false);
  });
});

describe("translate helpers", () => {
  it("hash depends on kind and text", () => {
    expect(translationHash("body", "Yes")).not.toBe(translationHash("button", "Yes"));
    expect(translationHash("body", "Yes")).toBe(translationHash("body", "Yes"));
  });

  it("fitToKind enforces Meta caps and leaves body alone", () => {
    const long = "क".repeat(40);
    expect([...fitToKind(long, "button")].length).toBe(20);
    expect(fitToKind(long, "button").endsWith("…")).toBe(true);
    expect([...fitToKind(long, "row_title")].length).toBe(24);
    expect(fitToKind(long, "body")).toBe(long);
    expect(fitToKind("short", "button")).toBe("short");
  });
});
