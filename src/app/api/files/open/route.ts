/**
 * GET /api/files/open?u=<stored file path>
 *
 * Tracker ID 166 (report rows: Data downloads › Calls and Expenses, the AI
 * expense export): a link that can sit in a spreadsheet or an email and still
 * obey the file rule. Clicking it checks the person who clicked (Admin, Sales
 * Head, CEO, the owner of the lead or account, Finance for bills…) and sends
 * them on to a fresh link that expires in 15 minutes. The spreadsheet itself
 * never holds a working file link, so a forwarded export opens nothing.
 *
 * `u` is a stored path: /api/files/<bucket>/<key> or /nbfc-uploads/<key>
 * (relative or absolute). Signed out → the login page. Build the address with
 * fileOpenHref (src/lib/storage/fileAccess.ts).
 */
import { NextRequest, NextResponse } from "next/server";

import { getAuthenticatedAppUser } from "@/lib/kyc/admin-workflow";
import {
    FILE_PROXY_BUCKETS,
    FRESH_LINK_TTL_SECONDS,
    filesProxyTarget,
    nbfcUploadsTarget,
    signedFilePath,
    signedNbfcPath,
} from "@/lib/storage/fileAccess";
import { canOpenStoredFile, logFileOpen } from "@/lib/storage/fileAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

function page(status: number, title: string, body: string) {
    return new NextResponse(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
            `<div style="font:15px/1.6 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem;color:#0f172a">` +
            `<h1 style="font-size:1.25rem;margin:0 0 .75rem">${title}</h1>` +
            `<p style="margin:0;color:#475569">${body}</p></div>`,
        { status, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } },
    );
}

export async function GET(req: NextRequest) {
    const raw = (req.nextUrl.searchParams.get("u") ?? "").trim();
    const nbfc = filesProxyTarget(raw) ? null : nbfcUploadsTarget(raw);
    const target = nbfc ?? filesProxyTarget(raw);
    if (!target || (!nbfc && !(FILE_PROXY_BUCKETS as readonly string[]).includes(target.bucket))) {
        return page(400, "This is not a file link", "The link is incomplete. Open the file from the CRM screen instead.");
    }

    let user: Awaited<ReturnType<typeof getAuthenticatedAppUser>> = null;
    try {
        user = await getAuthenticatedAppUser();
    } catch {
        user = null;
    }
    if (!user) {
        // The login page has no "come back to" parameter; after logging in,
        // clicking the link again opens the file.
        return NextResponse.redirect(new URL("/login", req.nextUrl.origin), { status: 302, headers: NO_STORE });
    }

    const { allowed, file } = await canOpenStoredFile(user, target.bucket, target.key);
    if (!allowed) {
        const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
        await logFileOpen({ file, bucket: target.bucket, key: target.key, userId: user.id, role: user.role, via: "session", allowed: false, ip });
        return page(
            403,
            "You can't open this file",
            "Files open only for Admin, the Sales Head, the CEO and the owner of the lead or account. Ask one of them if you need it.",
        );
    }

    const fresh = nbfc
        ? signedNbfcPath(target.path, FRESH_LINK_TTL_SECONDS, { by: user.id })
        : signedFilePath(target.path, FRESH_LINK_TTL_SECONDS, { by: user.id });
    return NextResponse.redirect(new URL(fresh ?? target.path, req.nextUrl.origin), { status: 302, headers: NO_STORE });
}
