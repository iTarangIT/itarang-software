/**
 * GET /api/admin/kyc/[leadId]/verification/[verificationId]/liveness-image?row=<n>&kind=original|match
 *
 * Tracker ID 166 (5 Nov): the Active Video KYC card's face-match pictures are
 * Decentro's own links, stored as-is in kyc_verifications.api_response. They
 * were put straight into <img src>, so opening one skipped the file rule and
 * left no trace. The case review now points them here instead: the viewer is
 * checked against the same rule as the case (requireAdminAppUserForLead —
 * Business Head / Sales Manager / Sales Executive only for leads they own),
 * every open (allowed or refused) goes to file_access_log, and the picture is
 * served from this server. The Decentro link never reaches the browser.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { kycVerifications } from "@/lib/db/schema";
import { getAuthenticatedAppUser, requireAdminAppUserForLead } from "@/lib/kyc/admin-workflow";
import { logFileOpen } from "@/lib/storage/fileAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

type FaceRow = { originalImage?: unknown; finalMatchImage?: unknown };

/** The stored Decentro value for row/kind, or null. */
function storedImage(apiResponse: unknown, row: number, kind: "original" | "match"): string | null {
    const rows = (apiResponse as { results?: { videoFaceMatchResults?: FaceRow[] } } | null)?.results
        ?.videoFaceMatchResults;
    if (!Array.isArray(rows) || row < 0 || row >= rows.length) return null;
    const v = kind === "original" ? rows[row]?.originalImage : rows[row]?.finalMatchImage;
    return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function imageBytes(src: string): Promise<{ bytes: Buffer; type: string } | null> {
    // Decentro may hand back a data: URI or plain base64 rather than a link.
    const data = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(src);
    if (data) return { type: data[1].toLowerCase(), bytes: Buffer.from(data[2], "base64") };
    if (!/^https:\/\//i.test(src)) {
        if (/^[A-Za-z0-9+/=\s]+$/.test(src) && src.length > 100) {
            return { type: "image/jpeg", bytes: Buffer.from(src.replace(/\s+/g, ""), "base64") };
        }
        return null;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(src, { signal: ctrl.signal, redirect: "follow", cache: "no-store" });
        if (!res.ok) return null;
        const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!type.startsWith("image/")) return null;
        const bytes = Buffer.from(await res.arrayBuffer());
        return bytes.length > MAX_BYTES ? null : { bytes, type };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ leadId: string; verificationId: string }> },
) {
    const { leadId, verificationId } = await params;
    const row = Number(req.nextUrl.searchParams.get("row"));
    const kindParam = req.nextUrl.searchParams.get("kind");
    if (!Number.isInteger(row) || (kindParam !== "original" && kindParam !== "match")) {
        return NextResponse.json({ error: "Invalid picture" }, { status: 400, headers: NO_STORE });
    }
    const kind = kindParam;

    let viewer: Awaited<ReturnType<typeof getAuthenticatedAppUser>> = null;
    try {
        viewer = await getAuthenticatedAppUser();
    } catch {
        viewer = null;
    }
    if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    const log = (allowed: boolean) =>
        logFileOpen({
            file: { kind: "customer_lead", leadId, kyc: true },
            bucket: "decentro-liveness",
            key: `${leadId}/${verificationId}/${row}/${kind}`,
            userId: viewer!.id,
            role: viewer!.role ?? null,
            via: "session",
            allowed,
            ip,
        });

    const allowedUser = await requireAdminAppUserForLead(leadId);
    if (!allowedUser) {
        await log(false);
        return NextResponse.json(
            { error: "Files open only for Admin, the Sales Head, the CEO and the owner of the lead or account." },
            { status: 403, headers: NO_STORE },
        );
    }

    const [v] = await db
        .select({ api_response: kycVerifications.api_response })
        .from(kycVerifications)
        .where(
            and(
                eq(kycVerifications.id, verificationId),
                eq(kycVerifications.lead_id, leadId),
                eq(kycVerifications.verification_type, "active_video_kyc"),
            ),
        )
        .limit(1);
    const src = v ? storedImage(v.api_response, row, kind) : null;
    if (!src) return NextResponse.json({ error: "Picture not found" }, { status: 404, headers: NO_STORE });

    await log(true);
    const img = await imageBytes(src);
    if (!img) {
        return NextResponse.json(
            { error: "The picture could not be loaded from Decentro (the link may have expired)." },
            { status: 502, headers: NO_STORE },
        );
    }
    return new NextResponse(new Uint8Array(img.bytes), {
        status: 200,
        headers: { ...NO_STORE, "Content-Type": img.type, "X-Content-Type-Options": "nosniff" },
    });
}
