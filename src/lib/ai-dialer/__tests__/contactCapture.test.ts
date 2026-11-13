import { describe, expect, it } from "vitest";
import { contactsFromSignals, normaliseIndianMobile, pickDialableContact } from "@/lib/ai-dialer/contactCapture";

describe("normaliseIndianMobile (AI dialer list item 6)", () => {
    it.each([
        ["9811022422", "9811022422"],
        ["+91 98110 22422", "9811022422"],
        ["098110-22422", "9811022422"],
        ["९८११०२२४२२", "9811022422"],
    ])("%s → %s", (raw, want) => expect(normaliseIndianMobile(raw)).toBe(want));

    it.each(["", "12345", "1234567890", "0112345678", "9999999999", "98110224221", "abc"])("rejects %s", (raw) =>
        expect(normaliseIndianMobile(raw)).toBeNull(),
    );
});

describe("contactsFromSignals", () => {
    const own = { leadPhone: "+917000123456", dialledPhone: "7000123456" };

    it("keeps the owner's mobile with his name, and an alternate", () => {
        expect(
            contactsFromSignals({ owner_name: " Rakesh  ji ", owner_mobile: "98110 22422", alternate_number: "9000012345" }, own),
        ).toEqual([
            { kind: "owner_mobile", phone: "9811022422", name: "Rakesh ji" },
            { kind: "alternate", phone: "9000012345", name: null },
        ]);
    });

    it("never stores the number we dialled or the lead's own", () => {
        expect(contactsFromSignals({ owner_mobile: "7000123456", alternate_number: "+91 70001 23456" }, own)).toEqual([]);
    });

    it("the same number twice is the owner's only", () => {
        expect(contactsFromSignals({ owner_mobile: "9811022422", alternate_number: "9811022422" }, own)).toHaveLength(1);
    });

    it("nothing said, nothing kept", () => {
        expect(contactsFromSignals({ owner_name: "", owner_mobile: "", alternate_number: "" }, own)).toEqual([]);
        expect(contactsFromSignals(null, own)).toEqual([]);
    });
});

describe("pickDialableContact", () => {
    const at = (s: string) => new Date(s);
    it("owner mobile before alternate; skips blocked and inactive numbers", () => {
        const contacts = [
            { kind: "alternate" as const, phone: "9000012345", status: "active", capturedAt: at("2026-11-13") },
            { kind: "owner_mobile" as const, phone: "9811022422", status: "active", capturedAt: at("2026-11-01") },
            { kind: "owner_mobile" as const, phone: "9811099999", status: "wrong", capturedAt: at("2026-11-12") },
        ];
        expect(pickDialableContact(contacts, new Set())).toEqual({ kind: "owner_mobile", phone: "9811022422" });
        expect(pickDialableContact(contacts, new Set(["9811022422"]))).toEqual({ kind: "alternate", phone: "9000012345" });
        expect(pickDialableContact(contacts, new Set(["9811022422", "9000012345"]))).toBeNull();
    });
});
