// Client-safe (no server deps) — do NOT fold into ./index.ts, which pulls in
// the server-only provider adapters.

// The company WABA number behind the Meta onboarding bot (phone-number ID
// 1228047873718306, "iTarang Technologies LLP"). Public — every visitor sees
// it in the chat link — so hardcoding is safe, and necessary as a fallback:
// static routes bake env at build time, and deploy builds run on the GitHub
// runner where the box's shared/.env is not available.
export const DEFAULT_ONBOARDING_WABA_NUMBER = "918796339460";

const ONBOARDING_TEXT = "Hi"; // keyword that starts the WhatsApp onboarding bot

/**
 * Chat link to the onboarding bot. api.whatsapp.com/send deep-links into the
 * app on mobile and shows the "Open app / Continue to WhatsApp Web" chooser
 * on desktop.
 */
export function whatsappOnboardingChatUrl(number?: string): string {
    const digits = (number || DEFAULT_ONBOARDING_WABA_NUMBER).replace(/[^0-9]/g, "");
    return `https://api.whatsapp.com/send/?phone=${digits}&text=${encodeURIComponent(
        ONBOARDING_TEXT,
    )}&type=phone_number&app_absent=0`;
}
