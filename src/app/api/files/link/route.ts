/**
 * GET /api/files/link?u=<stored /api/files/... path>
 *
 * Tracker ID 166 (10 Oct): "Fresh link on each click, valid 15 minutes. A link
 * pasted into WhatsApp stops working after 15 minutes."
 *
 * The in-app View / Open buttons call this on every click (openFreshFile in
 * src/lib/storage/freshFileLink.ts). It checks the signed-in user against the
 * same file rule the files route uses (Admin, Sales Head, CEO, the owner of
 * the lead or account, the dealer for its own customers, an NBFC for
 * applications shared with it) and hands back the stored path with a
 * signature that expires in 15 minutes and names the user, so the open is
 * logged against them. The stored path itself never changes.
 *
 * Response: { url, expiresAt } — `url` stays relative. A URL that is not a
 * stored file (a provider link) comes back unchanged. Since 16 Oct NBFC store
 * paths (/nbfc-uploads/…) are signed too, against the same rule, and come
 * back as /api/nbfc-uploads/…?exp=&sig=&by=.
 */
import { NextRequest, NextResponse } from "next/server";

import { getAuthenticatedAppUser } from "@/lib/kyc/admin-workflow";
import {
    FILE_PROXY_BUCKETS,
    FRESH_LINK_TTL_SECONDS,
    filesProxyTarget,
    nbfcUploadsTarget,
    safeStorageKey,
    signedFilePath,
    signedNbfcPath,
} from "@/lib/storage/fileAccess";
import { canOpenStoredFile, logFileOpen } from "@/lib/storage/fileAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
    const raw = (req.nextUrl.searchParams.get("u") ?? "").trim();
    if (!raw) return NextResponse.json({ error: "Missing u" }, { status: 400, headers: NO_STORE });

    let user: Awaited<ReturnType<typeof getAuthenticatedAppUser>> = null;
    try {
        user = await getAuthenticatedAppUser();
    } catch {
        user = null;
    }
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

    // A /api/files path, or (16 Oct) an NBFC store path (/nbfc-uploads/…).
    const nbfc = filesProxyTarget(raw) ? null : nbfcUploadsTarget(raw);
    const target = nbfc ?? filesProxyTarget(raw);
    if (!target) {
        // Not one of our stored files: nothing to sign.
        return NextResponse.json({ url: raw, expiresAt: null }, { headers: NO_STORE });
    }

    const { bucket } = target;
    // Same path check as the files route: no `..` in any encoding.
    const key = safeStorageKey(target.key.split("/"));
    if (!key || !(nbfc || (FILE_PROXY_BUCKETS as readonly string[]).includes(bucket))) {
        return NextResponse.json({ error: "Invalid path" }, { status: 400, headers: NO_STORE });
    }

    const { allowed, file } = await canOpenStoredFile(user, bucket, key);
    if (!allowed) {
        // The open never reaches the files route, so the refusal is logged here.
        const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
        await logFileOpen({ file, bucket, key, userId: user.id, role: user.role, via: "session", allowed: false, ip });
        return NextResponse.json(
            {
                error:
                    "Files open only for Admin, the Sales Head, the CEO and the owner of the lead or account.",
            },
            { status: 403, headers: NO_STORE },
        );
    }

    const url = nbfc
        ? signedNbfcPath(target.path, FRESH_LINK_TTL_SECONDS, { by: user.id })
        : signedFilePath(target.path, FRESH_LINK_TTL_SECONDS, { by: user.id });
    return NextResponse.json(
        { url, expiresAt: new Date(Date.now() + FRESH_LINK_TTL_SECONDS * 1000).toISOString() },
        { headers: NO_STORE },
    );
}
