// Fixed replies — sent with NO model call. Texts for UC-13 and UC-14 are the
// BRD's own (§6); keep them word for word.

import { ROLE_LABEL, type AssistantRole } from "@/lib/assistant/types";

export const REPLY = {
    /** UC-13: unlinked number, inactive user, or a role other than ASM/ISR. */
    unlinked: "This number is for iTarang staff. Link your WhatsApp from CRM → Settings.",
    /** UC-14: voice note, photo, document, sticker, … (voice notes only when voice is switched off). */
    media: "I can read typed messages only for now. Please type it.",
    /** A photo, document, sticker, … while voice notes are on. */
    mediaNotVoice: "I can read typed messages and voice notes only. Please type it or send a voice note.",
    /** A voice note with no speech in it, or nothing that could be made out. */
    voiceNoSpeech: "I couldn't hear anything in that voice note. Please send it again or type it.",
    /** Over MAX_VOICE_BYTES (about 3 minutes). */
    voiceTooLong: "That voice note is too long for me. Please keep it under 2 minutes, or type it.",
    /** Download or transcription failed. Nothing was changed. */
    voiceFailed: "I couldn't process that voice note, nothing was changed. Please send it again or type it.",
    linkInvalid:
        "That code is not valid or has expired. Get a new code from CRM → Settings → Link WhatsApp and send LINK followed by the 6 digits.",
    notReady: "The assistant is being set up. For now you can only link your number.",
    genericError: "Something went wrong, nothing was changed. Please try again.",
    /** ASSISTANT_DISABLED=true — the global kill switch. */
    disabled: "The iTarang Sales Assistant is paused right now. Please use the CRM for now.",
    /** A typed "yes" / "haan" while a preview is waiting: typing never saves. */
    tapConfirm: "Please tap *Confirm* on the preview to save it. Typing yes doesn't save anything.",
    /** The previous message from this user is still being worked on. */
    busy: "I'm still working on your last message. Please wait a moment and send this again.",
} as const;

/** Sent before the answer to a voice note, so the rep can see what was heard. */
export function heardReply(transcript: string): string {
    return `🎙️ "${transcript}"`;
}

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
