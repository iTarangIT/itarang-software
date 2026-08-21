/**
 * E-255 — Google OAuth callback for "Connect Google account". Verifies the
 * signed state, exchanges the code for a refresh token, stores it, and sends
 * the admin back to the settings page with a status flag in the query string.
 */

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth-utils";
import { invalidateDriveMirrorSettingsCache } from "@/lib/storage/drive-mirror";
import { completeDriveOAuth, verifyOAuthState } from "@/lib/storage/drive-mirror-oauth";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "sales_head"];

export async function GET(req: Request) {
    const user = await requireRole(EDITOR_ROLES);
    const url = new URL(req.url);
    const back = new URL("/admin/settings/gdrive-mirror", req.url);

    const googleError = url.searchParams.get("error");
    if (googleError) {
        back.searchParams.set("oauth", "denied");
        back.searchParams.set("reason", googleError);
        return NextResponse.redirect(back);
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const forUser = state ? verifyOAuthState(state) : null;
    if (!code || !forUser || forUser !== user.id) {
        back.searchParams.set("oauth", "bad_state");
        return NextResponse.redirect(back);
    }

    try {
        const grant = await completeDriveOAuth(code, user.id);
        invalidateDriveMirrorSettingsCache();
        back.searchParams.set("oauth", "connected");
        if (grant.email) back.searchParams.set("email", grant.email);
    } catch (err) {
        console.error("[gdrive-mirror:oauth] token exchange failed:", err);
        back.searchParams.set("oauth", "failed");
        back.searchParams.set("reason", err instanceof Error ? err.message.slice(0, 300) : "unknown");
    }
    return NextResponse.redirect(back);
}
