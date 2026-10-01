// Link WhatsApp — the CRM half of number linking (BRD §8.5, UC-12).
//
//   GET     the caller's binding: linked number, outstanding code expiry.
//   POST    issue a fresh 6-digit code (replaces any outstanding one). The
//           plaintext is returned ONCE and never stored.
//   DELETE  unlink: revoke the active binding and any outstanding code.
//
// Session auth; asm and inside_sales_rep only. requireRole() does not check
// is_active, so it is checked here: a deactivated user cannot mint a code.

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ASSISTANT_ROLES } from "@/lib/assistant/types";
import { readWaAssistEnv } from "@/lib/wa-assistant/env";
import { getLinkState, issueLinkCode, revokeForUser } from "@/lib/wa-assistant/link";

export const dynamic = "force-dynamic";

async function activeCaller() {
    const user = await requireRole([...ASSISTANT_ROLES]);
    return user.is_active ? user : null;
}

export const GET = withErrorHandler(async () => {
    const user = await activeCaller();
    if (!user) return errorResponse("Your account is inactive.", 403);
    const cfg = readWaAssistEnv();
    // Not switched on here: say so without touching the assistant tables, which
    // may not exist yet on this host (E-309 is applied before WA_ASSIST_* is set).
    if (!cfg.ok) {
        return successResponse({ linked: null, pendingExpiresAt: null, assistant_number: null, configured: false });
    }
    const state = await getLinkState(user.id);
    return successResponse({
        ...state,
        assistant_number: cfg.ok ? (cfg.env.WA_ASSIST_DISPLAY_NUMBER ?? null) : null,
        configured: cfg.ok,
    });
});

export const POST = withErrorHandler(async () => {
    const user = await activeCaller();
    if (!user) return errorResponse("Your account is inactive.", 403);
    const cfg = readWaAssistEnv();
    if (!cfg.ok) return errorResponse("WhatsApp linking is not available yet.", 503);

    const { code, expiresAt } = await issueLinkCode(user.id, cfg.env.WA_ASSIST_APP_SECRET);
    return successResponse({
        code,
        expires_at: expiresAt.toISOString(),
        message_to_send: `LINK ${code}`,
        assistant_number: cfg.env.WA_ASSIST_DISPLAY_NUMBER ?? null,
    });
});

export const DELETE = withErrorHandler(async () => {
    const user = await activeCaller();
    if (!user) return errorResponse("Your account is inactive.", 403);
    const revoked = await revokeForUser(user.id, "unlinked_by_user");
    return successResponse({ revoked });
});
