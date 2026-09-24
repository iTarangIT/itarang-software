// Fixed replies — sent with NO model call. Texts for UC-13 and UC-14 are the
// BRD's own (§6); keep them word for word.

import { ROLE_LABEL, type AssistantRole } from "@/lib/assistant/types";

export const REPLY = {
    /** UC-13: unlinked number, inactive user, or a role other than ASM/ISR. */
    unlinked: "This number is for iTarang staff. Link your WhatsApp from CRM → Settings.",
    /** UC-14: voice note, photo, document, sticker, … */
    media: "I can read typed messages only for now. Please type it.",
    linkInvalid:
        "That code is not valid or has expired. Get a new code from CRM → Settings → Link WhatsApp and send LINK followed by the 6 digits.",
    notReady: "The assistant is being set up. For now you can only link your number.",
    genericError: "Something went wrong, nothing was changed. Please try again.",
} as const;

export function linkedReply(name: string, role: AssistantRole): string {
    return `Linked: ${name} (${ROLE_LABEL[role]})`;
}

export function linkLockedReply(until: Date): string {
    const at = until.toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
    });
    return `Too many wrong codes from this number. Try again after ${at}.`;
}
