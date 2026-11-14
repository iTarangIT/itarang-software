// ID 241-3 / 241-4: the "Not visited in 30 days" rule and the photo link in Dealer visits.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { execute: vi.fn(async () => []) } }));
const { notVisitedIn30 } = await import("../myDealers");
const { photoCell, PHOTO_OUTSIDE_STORAGE } = await import("@/lib/exports/fileLinks");

describe("notVisitedIn30", () => {
    it("flags a dealer never visited or last visited over 30 days ago", () => {
        expect(notVisitedIn30(null, "2026-11-14")).toBe(true);
        expect(notVisitedIn30("2026-10-14", "2026-11-14")).toBe(true); // 31 days
        expect(notVisitedIn30("2026-10-15", "2026-11-14")).toBe(false); // 30 days
        expect(notVisitedIn30("2026-11-07", "2026-11-14")).toBe(false); // visited last week
    });
    it("never flags a closed dealer", () => {
        expect(notVisitedIn30(null, "2026-11-14", "closed")).toBe(false);
    });
});

describe("photoCell", () => {
    it("blank stays blank; an outside link is never written into the file", () => {
        expect(photoCell(null, "https://crm.example")).toBeNull();
        expect(photoCell("https://somewhere-else.example/x.jpg", "https://crm.example")).toBe(PHOTO_OUTSIDE_STORAGE);
    });
});
