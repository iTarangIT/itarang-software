/**
 * GET /api/nbfc/vkyc/capture/[token] — PUBLIC, token-gated (Addendum §11).
 *
 * The single-use link the CUSTOMER opens to record a passive video-KYC selfie.
 * NO auth — the token (vkyc_ref) IS the credential. Returns minimal context
 * (first name + expiry) so a misdirected link leaks nothing. 410 Gone if the
 * token is invalid / expired / already used.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { resolveVkycByToken } from "@/lib/nbfc/vkyc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const track = await resolveVkycByToken(token);
  if (!track) {
    return NextResponse.json(
      { ok: false, error: "This link is invalid, expired, or already used." },
      { status: 410 },
    );
  }

  const [lead] = await db
    .select({ full_name: leads.full_name, owner_name: leads.owner_name })
    .from(leads)
    .where(eq(leads.id, track.lead_id))
    .limit(1);

  const fullName = lead?.full_name || lead?.owner_name || "Customer";
  const firstName = fullName.trim().split(/\s+/)[0] || "Customer";

  return NextResponse.json({
    ok: true,
    customer_name: firstName,
    expires_at: track.link_expires_at,
  });
}
