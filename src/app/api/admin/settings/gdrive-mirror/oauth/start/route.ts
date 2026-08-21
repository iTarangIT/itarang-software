/**
 * E-255 — "Connect Google account": send the admin to Google's consent screen.
 * The callback (../callback) stores the refresh token. See
 * src/lib/storage/drive-mirror-oauth.ts for why this path exists.
 */

import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth-utils";
import { driveOAuthAuthUrl, isDriveOAuthClientConfigured } from "@/lib/storage/drive-mirror-oauth";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "sales_head"];

export async function GET(req: Request) {
    const user = await requireRole(EDITOR_ROLES);
    const back = new URL("/admin/settings/gdrive-mirror", req.url);
    if (!isDriveOAuthClientConfigured()) {
        back.searchParams.set("oauth", "not_configured");
        return NextResponse.redirect(back);
    }
    return NextResponse.redirect(driveOAuthAuthUrl(user.id));
}
