import { describe, expect, it } from "vitest";
import {
    MAX_VISIT_ACCURACY_M,
    checkCaptureUse,
    checkVisitLocation,
    checkVisitPhoto,
    istDay,
    mayLogAccountVisit,
} from "@/lib/visits/verifiedCapture";

describe("checkVisitLocation (ID 196)", () => {
    it("refuses no location", () => {
        const r = checkVisitLocation(null, null, null);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toMatch(/Turn on location/);
    });
    it("refuses 0,0 and out-of-range points", () => {
        expect(checkVisitLocation(0, 0, 10).ok).toBe(false);
        expect(checkVisitLocation(91, 77, 10).ok).toBe(false);
    });
    it("refuses a location with no accuracy", () => {
        expect(checkVisitLocation(19.07, 72.87, null).ok).toBe(false);
    });
    it("accepts 100 m, refuses worse", () => {
        expect(checkVisitLocation(19.07, 72.87, MAX_VISIT_ACCURACY_M).ok).toBe(true);
        expect(checkVisitLocation(19.07, 72.87, MAX_VISIT_ACCURACY_M + 1).ok).toBe(false);
    });
});

describe("checkVisitPhoto", () => {
    it("needs a photo", () => {
        expect(checkVisitPhoto(null).ok).toBe(false);
        expect(checkVisitPhoto({ type: "image/jpeg", size: 0 }).ok).toBe(false);
    });
    it("accepts camera image types, refuses others and huge files", () => {
        expect(checkVisitPhoto({ type: "image/jpeg", size: 1000 }).ok).toBe(true);
        expect(checkVisitPhoto({ type: "image/HEIC", size: 1000 }).ok).toBe(true);
        expect(checkVisitPhoto({ type: "application/pdf", size: 1000 }).ok).toBe(false);
        expect(checkVisitPhoto({ type: "image/jpeg", size: 16 * 1024 * 1024 }).ok).toBe(false);
    });
});

describe("istDay", () => {
    it("is the IST calendar day", () => {
        expect(istDay(new Date("2026-10-28T18:29:00Z"))).toBe("2026-10-28");
        expect(istDay(new Date("2026-10-28T18:31:00Z"))).toBe("2026-10-29");
    });
});

describe("checkCaptureUse", () => {
    const cap = {
        user_id: "u1",
        dealer_lead_id: "DL-1",
        account_id: null,
        captured_at: "2026-10-29T05:00:00Z",
        visit_id: null,
    };
    const now = new Date("2026-10-29T10:00:00Z");
    it("accepts the taker, same lead, same IST day, unused", () => {
        expect(checkCaptureUse(cap, { userId: "u1", leadId: "DL-1", now }).ok).toBe(true);
    });
    it("refuses someone else, another lead, a used photo, another day", () => {
        expect(checkCaptureUse(cap, { userId: "u2", leadId: "DL-1", now }).ok).toBe(false);
        expect(checkCaptureUse(cap, { userId: "u1", leadId: "DL-2", now }).ok).toBe(false);
        expect(checkCaptureUse({ ...cap, visit_id: "v1" }, { userId: "u1", leadId: "DL-1", now }).ok).toBe(false);
        expect(checkCaptureUse(cap, { userId: "u1", leadId: "DL-1", now: new Date("2026-10-30T05:00:00Z") }).ok).toBe(false);
    });
    it("checks the account for a counter visit", () => {
        const acc = { ...cap, dealer_lead_id: null, account_id: "A1" };
        expect(checkCaptureUse(acc, { userId: "u1", accountId: "A1", now }).ok).toBe(true);
        expect(checkCaptureUse(acc, { userId: "u1", accountId: "A2", now }).ok).toBe(false);
    });
});

describe("mayLogAccountVisit", () => {
    it("owner or the owner's manager only", () => {
        expect(mayLogAccountVisit({ userId: "u1", ownerId: "u1", teamIds: [] })).toBe(true);
        expect(mayLogAccountVisit({ userId: "m1", ownerId: "u1", teamIds: ["u1"] })).toBe(true);
        expect(mayLogAccountVisit({ userId: "x", ownerId: "u1", teamIds: [] })).toBe(false);
        expect(mayLogAccountVisit({ userId: "u1", ownerId: null, teamIds: [] })).toBe(false);
    });
});
