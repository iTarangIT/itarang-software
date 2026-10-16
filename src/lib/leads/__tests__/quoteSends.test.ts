import { describe, expect, it } from "vitest";
import {
    displayRecipient,
    failedLines,
    failedSendTimelineEntries,
    formatSendTime,
    mergeNewestFirst,
    quoteSentRemark,
    sentLine,
    type QuoteSend,
} from "@/lib/leads/quoteSends";

// 9 Sep 14:10 IST = 08:40 UTC.
const AT = "2026-09-09T08:40:00Z";
const send = (over: Partial<QuoteSend>): QuoteSend => ({
    dispatch_id: "d1",
    commercial_id: "c1",
    quote_number: "ITQ/2026/0042",
    channel: "whatsapp",
    recipient: "98xxxxx210",
    status: "sent",
    error: null,
    sent_by_name: "Ravi",
    sent_at: AT,
    ...over,
});

describe("quote sends on the lead page (ID 191)", () => {
    it("masks a WhatsApp number the way the downloads do, keeps an email whole", () => {
        expect(displayRecipient("whatsapp", "+919876543210")).toBe("98xxxxx210");
        expect(displayRecipient("email", "dealer@example.com")).toBe("dealer@example.com");
        expect(displayRecipient("email", "")).toBe("—");
    });

    it("prints the time in IST as '9 Sep 14:10'", () => {
        expect(formatSendTime(AT)).toBe("9 Sep 14:10");
        expect(formatSendTime("not a date")).toBe("—");
    });

    it("lists each successful send, oldest first, on one 'Sent:' line", () => {
        const line = sentLine([
            send({ dispatch_id: "d2", channel: "email", recipient: "x@y.com", sent_at: "2026-09-09T08:41:00Z" }),
            send({}),
        ]);
        expect(line).toBe("Sent: WhatsApp to 98xxxxx210 on 9 Sep 14:10 · Email to x@y.com on 9 Sep 14:11");
        expect(sentLine([send({ status: "failed" })])).toBeNull();
    });

    it("gives a failed send its reason", () => {
        expect(failedLines([send({ channel: "email", recipient: "x@y.com", status: "failed", error: "Mailbox full" })])).toEqual([
            "Email to x@y.com on 9 Sep 14:10 failed — Mailbox full",
        ]);
        expect(failedLines([send({ status: "failed" })])[0]).toMatch(/no reason recorded$/);
    });

    it("turns only failed sends into red timeline entries", () => {
        const entries = failedSendTimelineEntries([
            send({}),
            send({ dispatch_id: "d9", channel: "email", recipient: "x@y.com", status: "failed", error: "Bounced" }),
        ]);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            touchpoint_id: "dispatch:d9",
            display_label: "Quote send failed",
            tone: "failed",
            performed_by_name: "Ravi",
            remarks: "Quote ITQ/2026/0042 not sent on Email to x@y.com — Bounced",
        });
    });

    it("merges entries into a newest-first timeline", () => {
        const rows = [{ performed_at: "2026-09-10T00:00:00Z", id: "a" }, { performed_at: "2026-09-08T00:00:00Z", id: "b" }];
        const merged = mergeNewestFirst(rows, [{ performed_at: AT, id: "x" }]);
        expect(merged.map((r) => r.id)).toEqual(["a", "x", "b"]);
        expect(mergeNewestFirst(rows, [])).toBe(rows);
    });

    it("writes the touchpoint remark as 'Quote <number> sent on <channel>'", () => {
        expect(
            quoteSentRemark(
                "ITQ/2026/0042",
                [{ channel: "whatsapp", recipient: "+919876543210" }, { channel: "email", recipient: "x@y.com" }],
                [],
            ),
        ).toBe("Quote ITQ/2026/0042 sent on WhatsApp to 98xxxxx210 · Email to x@y.com");
        expect(
            quoteSentRemark("ITQ/2026/0042", [{ channel: "whatsapp", recipient: "9876543210" }], [{ channel: "email", error: "Bounced" }]),
        ).toBe("Quote ITQ/2026/0042 sent on WhatsApp to 98xxxxx210 — not sent on Email (Bounced)");
    });
});
