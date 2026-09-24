import { describe, expect, it } from "vitest";
import { isForPhoneNumber, MetaWhatsAppAdapter } from "../meta";

// BRD §2.3-8 / §8.6: the Sales Assistant runs on a second number in the same
// WABA. Its events must never reach the dealer bot, so the dealer webhook drops
// anything addressed to a phone_number_id other than META_WA_PHONE_NUMBER_ID.

const DEALER_NUMBER = "111111111111111";
const ASSISTANT_NUMBER = "222222222222222";

function change(phoneNumberId: string, value: Record<string, unknown>) {
    return {
        field: "messages",
        value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "919000000000", phone_number_id: phoneNumberId },
            ...value,
        },
    };
}

const mixedPayload = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
        {
            id: "WABA",
            changes: [
                change(DEALER_NUMBER, {
                    messages: [{ id: "wamid.dealer", from: "919812345678", type: "text", text: { body: "hi" } }],
                }),
                change(ASSISTANT_NUMBER, {
                    messages: [{ id: "wamid.assist", from: "919876543210", type: "text", text: { body: "LINK 482913" } }],
                    statuses: [{ id: "wamid.out", status: "delivered", recipient_id: "919876543210" }],
                }),
            ],
        },
    ],
});

describe("dealer webhook phone_number_id guard", () => {
    const events = new MetaWhatsAppAdapter().parseInbound(mixedPayload);

    it("stamps each event with the phone_number_id it was addressed to", () => {
        expect(events.map((e) => [e.providerMessageId, e.phoneNumberId])).toEqual([
            ["wamid.dealer", DEALER_NUMBER],
            ["wamid.out", ASSISTANT_NUMBER],
            ["wamid.assist", ASSISTANT_NUMBER],
        ]);
    });

    it("keeps only the dealer number's events, statuses included", () => {
        const kept = events.filter((e) => isForPhoneNumber(e, DEALER_NUMBER));
        expect(kept.map((e) => e.providerMessageId)).toEqual(["wamid.dealer"]);
    });

    it("passes everything through when the dealer number is not configured", () => {
        expect(events.every((e) => isForPhoneNumber(e, undefined))).toBe(true);
        expect(events.every((e) => isForPhoneNumber(e, ""))).toBe(true);
    });

    it("passes an event with no phone_number_id (dry-run adapter, pre-metadata payloads)", () => {
        expect(isForPhoneNumber({}, DEALER_NUMBER)).toBe(true);
    });
});
