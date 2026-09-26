import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { execute: vi.fn() } }));
const { historyFromStored, toolsetStamp } = await import("../memory");

// A history is only valid for the tool set it was built with. When the user's
// tools change (a deploy adds transfer_to_asm, or they join the write pilot),
// replaying an old "I can't do that" makes the model repeat it without looking
// at its new tools — the Phase 2 "Main leads ko transfer nahi kar sakta" bug.

const MSG = [{ type: "human", data: { content: "hi" } }];

describe("toolsetStamp", () => {
    it("is order-independent", () => {
        expect(toolsetStamp(["search_lead", "my_queue"])).toBe(toolsetStamp(["my_queue", "search_lead"]));
    });
});

describe("historyFromStored", () => {
    const stamp = toolsetStamp(["my_queue", "transfer_to_asm"]);

    it("same tool set → the stored messages", () => {
        expect(historyFromStored({ toolset: stamp, messages: MSG }, stamp)).toEqual(MSG);
    });

    it("a different tool set → start fresh", () => {
        expect(historyFromStored({ toolset: toolsetStamp(["my_queue"]), messages: MSG }, stamp)).toBeNull();
    });

    it("an unstamped (pre-fix) history → start fresh", () => {
        expect(historyFromStored(MSG, stamp)).toBeNull();
    });

    it("anything unreadable → start fresh", () => {
        expect(historyFromStored(null, stamp)).toBeNull();
        expect(historyFromStored({ toolset: stamp }, stamp)).toBeNull();
    });
});
