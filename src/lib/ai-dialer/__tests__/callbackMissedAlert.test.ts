// ID 212 — the 30-minute missed-callback WhatsApp: who gets it, what it says.
import { describe, expect, it } from "vitest";

import { missedCallbackMessage, missedCallbackRecipients } from "@/lib/ai-dialer/callbackMissedAlert";

describe("missedCallbackRecipients", () => {
    const heads = [
        { user_id: "sh1", phone: "98765 43210" },
        { user_id: "sh2", phone: null },
    ];
    it("Sales Heads and the owner's manager, each number once, never the owner", () => {
        expect(missedCallbackRecipients(heads, { user_id: "m1", phone: "+91 91234 56789" }, "isr1")).toEqual([
            "919876543210",
            "919123456789",
        ]);
        expect(missedCallbackRecipients(heads, { user_id: "sh1", phone: "9876543210" }, "isr1")).toEqual(["919876543210"]);
        expect(missedCallbackRecipients([{ user_id: "isr1", phone: "9000000001" }], null, "isr1")).toEqual([]);
    });
});

describe("missedCallbackMessage", () => {
    it("names the dealer, the agreed time in IST, the owner and the lead link", () => {
        const text = missedCallbackMessage(
            { lead_id: "DL-1", name: "GR Enterprise", phone: "98xxxxx210", due_at: "2026-11-04T10:30:00Z", assigned_user_id: "isr1", owner_name: "Nidhi" },
            "https://crm.itarang.com/",
        );
        expect(text).toContain("GR Enterprise (98xxxxx210)");
        expect(text).toContain("4 Nov");
        expect(text).toMatch(/4:00\s?pm/i);
        expect(text).toContain("Owner: Nidhi");
        expect(text).toContain("https://crm.itarang.com/leads?lead=DL-1");
    });
});
