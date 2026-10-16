// ID 166 — the Recording (Calls) and Bill link (Expenses) cells never carry a
// working file link, only a CRM address that checks whoever clicks it.

import { describe, expect, it } from "vitest";

import {
    BILL_OUTSIDE_STORAGE,
    RECORDING_NOT_COPIED,
    billCell,
    exportOrigin,
    recordingCell,
} from "@/lib/exports/fileLinks";

const O = "https://crm.test";

describe("recordingCell", () => {
    it("a recording in iTarang storage goes through the checked open route", () => {
        const cell = recordingCell("/api/files/call-recordings/bolna/c-1.mp3", null, O);
        expect(cell).toBe(`${O}/api/files/open?u=${encodeURIComponent("/api/files/call-recordings/bolna/c-1.mp3")}`);
    });

    it("an AI call still on the provider's link goes through the recording route, never the provider link", () => {
        const cell = recordingCell("https://bolna.example/rec/abc.mp3?token=x", "call-42", O);
        expect(cell).toBe(`${O}/api/ai-dialer/recording/call-42`);
        expect(cell).not.toContain("bolna.example");
    });

    it("a NeoDove link not yet copied is replaced by a note", () => {
        expect(recordingCell("https://neodove.example/r/1.mp3", null, O)).toBe(RECORDING_NOT_COPIED);
    });

    it("no recording → blank", () => {
        expect(recordingCell(null, "call-42", O)).toBeNull();
        expect(recordingCell("  ", null, O)).toBeNull();
    });
});

describe("billCell", () => {
    it("a stored bill goes through the checked open route", () => {
        expect(billCell("/api/files/documents/expenses/u-1/b.jpg", `${O}/`)).toBe(
            `${O}/api/files/open?u=${encodeURIComponent("/api/files/documents/expenses/u-1/b.jpg")}`,
        );
    });

    it("an outside link is never written into the file", () => {
        expect(billCell("https://old-store.example/public/b.jpg", O)).toBe(BILL_OUTSIDE_STORAGE);
        expect(billCell(null, O)).toBeNull();
    });
});

describe("exportOrigin", () => {
    it("prefers APP_URL, trims the trailing slash, falls back to the CRM", () => {
        expect(exportOrigin({ APP_URL: "https://a.test/", NEXT_PUBLIC_APP_URL: "https://b.test" })).toBe("https://a.test");
        expect(exportOrigin({ NEXT_PUBLIC_APP_URL: "https://b.test" })).toBe("https://b.test");
        expect(exportOrigin({})).toBe("https://crm.itarang.com");
    });
});
