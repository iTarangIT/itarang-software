// ID 223 — a download the server gave up on says so in plain words.
import { describe, expect, it } from "vitest";

import { TOOK_TOO_LONG, downloadFailureMessage } from "@/lib/exports/datasets/downloadClient";

describe("downloadFailureMessage", () => {
    it("keeps the API's own message", () => {
        expect(downloadFailureMessage(400, { error: { message: "Too big for Excel at once." } })).toBe("Too big for Excel at once.");
    });
    it("a proxy time-out or a non-JSON page means it took too long", () => {
        expect(downloadFailureMessage(524, null)).toBe(TOOK_TOO_LONG);
        expect(downloadFailureMessage(502, { error: {} })).toBe(TOOK_TOO_LONG);
        expect(downloadFailureMessage(500, null)).toBe(TOOK_TOO_LONG);
    });
    it("otherwise a plain failure", () => {
        expect(downloadFailureMessage(500, { success: false })).toBe("The download failed.");
    });
});
