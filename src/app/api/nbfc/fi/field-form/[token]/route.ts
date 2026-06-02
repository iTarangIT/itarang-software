/**
 * GET /api/nbfc/fi/field-form/[token] — PUBLIC, token-gated (§10.6/§10.7).
 *
 * The single-use link the FI agent opens on their phone. NO auth — the signed
 * token IS the credential. Returns MINIMAL context only (customer name +
 * address + city), protecting privacy if the link is misdirected, plus the
 * NBFC's FI form parameters (required photos, GPS-denied behaviour, camera-only).
 * 410 Gone if the token is invalid / expired / already consumed.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, nbfcServiceConfig } from "@/lib/db/schema";
import { resolveFiByToken } from "@/lib/nbfc/fi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_REQUIRED = ["exterior", "customer_at_residence", "corroborator", "agent_selfie"];

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const fi = await resolveFiByToken(token);
  if (!fi) {
    return NextResponse.json(
      { ok: false, error: "This link is invalid, expired, or already used." },
      { status: 410 },
    );
  }

  const [lead] = await db
    .select({
      full_name: leads.full_name,
      owner_name: leads.owner_name,
      current_address: leads.current_address,
      permanent_address: leads.permanent_address,
      local_address: leads.local_address,
      city: leads.city,
    })
    .from(leads)
    .where(eq(leads.id, fi.lead_id))
    .limit(1);

  const [cfg] = await db
    .select({ fiConfig: nbfcServiceConfig.fi_config })
    .from(nbfcServiceConfig)
    .where(eq(nbfcServiceConfig.tenant_id, fi.tenant_id))
    .limit(1);
  const fiConfig = (cfg?.fiConfig as { required_photos?: string[]; gps_denied_block?: boolean; camera_only?: boolean } | undefined) ?? {};

  return NextResponse.json({
    ok: true,
    customer_name: lead?.full_name || lead?.owner_name || "Customer",
    address: lead?.current_address || lead?.permanent_address || lead?.local_address || null,
    city: lead?.city ?? null,
    required_photos: fiConfig.required_photos ?? DEFAULT_REQUIRED,
    gps_denied_block: fiConfig.gps_denied_block ?? true,
    camera_only: fiConfig.camera_only ?? true,
    expires_at: fi.link_expires_at,
  });
}
