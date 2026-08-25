import { describe, expect, it, vi } from "vitest";

import { TranslatingWhatsAppAdapter } from "../translating-adapter";
import type { TranslationItem } from "../translate-core";
import type { SendResult, WhatsAppAdapter } from "../types";

const ok: SendResult = { ok: true, providerMessageId: "m1" } as SendResult;

function fakeInner() {
  const inner = {
    provider: "meta",
    verifyInbound: vi.fn(() => true),
    verifyChallenge: vi.fn(() => null),
    parseInbound: vi.fn(() => []),
    downloadMedia: vi.fn(),
    sendText: vi.fn(async () => ok),
    sendTemplate: vi.fn(async () => ok),
    sendTemplateWithImageHeader: vi.fn(async () => ok),
    sendDocument: vi.fn(async () => ok),
    sendDocumentBytes: vi.fn(async () => ok),
    sendInteractive: vi.fn(async () => ok),
    sendList: vi.fn(async () => ok),
  };
  return inner as unknown as WhatsAppAdapter & typeof inner;
}

/** Marks every string so we can see which slots were translated. */
const marker = vi.fn(async (items: TranslationItem[]) =>
  items.map((i) => `[${i.kind}]${i.text}`),
);

describe("TranslatingWhatsAppAdapter", () => {
  it("english is a pure pass-through — translator never called", async () => {
    const inner = fakeInner();
    const t = vi.fn(async (items: TranslationItem[]) => items.map((i) => i.text));
    const a = new TranslatingWhatsAppAdapter(inner, async () => "english", t);

    await a.sendText("91", "Hello");
    await a.sendInteractive("91", "Pick", [{ id: "yes", title: "Yes" }]);
    await a.sendList("91", "Menu", "Open", [{ id: "r1", title: "Row" }]);

    expect(t).not.toHaveBeenCalled();
    expect(inner.sendText).toHaveBeenCalledWith("91", "Hello");
    expect(inner.sendInteractive).toHaveBeenCalledWith("91", "Pick", [
      { id: "yes", title: "Yes" },
    ]);
  });

  it("translates body + button titles but never ids", async () => {
    const inner = fakeInner();
    marker.mockClear();
    const a = new TranslatingWhatsAppAdapter(inner, async () => "hindi", marker);

    await a.sendInteractive("91", "Confirm?", [
      { id: "confirm", title: "Confirm" },
      { id: "change", title: "Change" },
    ]);

    expect(marker).toHaveBeenCalledTimes(1);
    expect(inner.sendInteractive).toHaveBeenCalledWith("91", "[body]Confirm?", [
      { id: "confirm", title: "[button]Confirm" },
      { id: "change", title: "[button]Change" },
    ]);
  });

  it("translates list body, opener, row titles and descriptions in one batch", async () => {
    const inner = fakeInner();
    marker.mockClear();
    const a = new TranslatingWhatsAppAdapter(inner, async () => "hinglish", marker);

    await a.sendList("91", "Menu", "Open", [
      { id: "a", title: "New lead", description: "Start a lead" },
      { id: "b", title: "Drafts" },
    ]);

    expect(marker).toHaveBeenCalledTimes(1);
    expect(inner.sendList).toHaveBeenCalledWith(
      "91",
      "[body]Menu",
      "[list_button]Open",
      [
        { id: "a", title: "[row_title]New lead", description: "[row_desc]Start a lead" },
        { id: "b", title: "[row_title]Drafts" },
      ],
    );
  });

  it("falls back to English when the translator throws", async () => {
    const inner = fakeInner();
    const boom = vi.fn(async () => {
      throw new Error("gemini down");
    });
    const a = new TranslatingWhatsAppAdapter(inner, async () => "hindi", boom);

    await a.sendText("91", "Hello");
    expect(inner.sendText).toHaveBeenCalledWith("91", "Hello");
  });

  it("falls back to English when the language lookup throws", async () => {
    const inner = fakeInner();
    const a = new TranslatingWhatsAppAdapter(
      inner,
      async () => {
        throw new Error("db down");
      },
      marker,
    );
    await a.sendText("91", "Hello");
    expect(inner.sendText).toHaveBeenCalledWith("91", "Hello");
  });

  it("leaves templates untouched", async () => {
    const inner = fakeInner();
    marker.mockClear();
    const a = new TranslatingWhatsAppAdapter(inner, async () => "hindi", marker);
    await a.sendTemplate("91", "tpl", "en", ["x"]);
    expect(marker).not.toHaveBeenCalled();
    expect(inner.sendTemplate).toHaveBeenCalledWith("91", "tpl", "en", ["x"]);
  });

  it("translates a document caption only when one is given", async () => {
    const inner = fakeInner();
    marker.mockClear();
    const a = new TranslatingWhatsAppAdapter(inner, async () => "hindi", marker);
    await a.sendDocument("91", "http://x/a.pdf", "a.pdf");
    expect(marker).not.toHaveBeenCalled();
    await a.sendDocument("91", "http://x/a.pdf", "a.pdf", "Your quote");
    expect(inner.sendDocument).toHaveBeenLastCalledWith(
      "91",
      "http://x/a.pdf",
      "a.pdf",
      "[caption]Your quote",
    );
  });
});
