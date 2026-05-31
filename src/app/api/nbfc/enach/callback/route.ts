/**
 * Public, UN-authenticated callback for the E-NACH B2-B contract (§9.5).
 *
 * The NBFC's app posts the result here after mandate registration. We match by
 * the opaque `itarang_enach_ref` we issued at trigger time and update the latest
 * attempt for that ref. The NBFC maps its provider's status into iTarang's
 * CANONICAL values before posting (§9.3); we also retain the provider raw layer
 * for display/audit only.
 *
 * Mirrors the Decentro active-liveness callback: match-by-ref, always 200 so the
 * caller never retries endlessly, log anything unmatched.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { enachMandates } from "@/lib/db/schema";
import { ENACH_STATES, type EnachState } from "@/lib/nbfc/enach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pickStr(body: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const url = new URL(req.url);
    const ref =
      pickStr(body, "itarang_enach_ref", "enach_ref", "ref") ||
      url.searchParams.get("ref") ||
      url.searchParams.get("itarang_enach_ref");
    if (!ref) {
      return new NextResponse("Missing itarang_enach_ref", { status: 400 });
    }

    const [row] = await db
      .select()
      .from(enachMandates)
      .where(eq(enachMandates.enach_ref, ref))
      .limit(1);
    if (!row) {
      console.warn("[E-NACH callback] No mandate for ref:", ref);
      return new NextResponse("No matching mandate", { status: 200 });
    }

    const rawStatus = pickStr(body, "status", "canonical_status");
    const canonical = (rawStatus ?? "").toLowerCase();
    // Only accept canonical values into `status`; anything else stays as raw.
    const isCanonical = (ENACH_STATES as readonly string[]).includes(canonical);
    const nextStatus: EnachState = isCanonical ? (canonical as EnachState) : "in_progress";

    const now = new Date();
    const validFrom = pickStr(body, "valid_from");
    const validTo = pickStr(body, "valid_to");

    await db
      .update(enachMandates)
      .set({
        status: nextStatus,
        umrn: pickStr(body, "umrn") ?? row.umrn,
        bank_name: pickStr(body, "bank_name") ?? row.bank_name,
        account_masked: pickStr(body, "account_masked") ?? row.account_masked,
        max_amount: pickStr(body, "max_amount") ?? row.max_amount,
        valid_from: validFrom ?? row.valid_from,
        valid_to: validTo ?? row.valid_to,
        provider_name: pickStr(body, "provider_name") ?? row.provider_name,
        provider_raw_status: pickStr(body, "provider_raw_status", "raw_status") ?? rawStatus ?? row.provider_raw_status,
        provider_raw_payload: body as unknown as Record<string, unknown>,
        registration_method: "callback",
        proof_url: pickStr(body, "proof_url", "proof") ?? row.proof_url,
        failure_reason: pickStr(body, "failure_reason") ?? (nextStatus === "failed" ? "Reported failed by NBFC" : row.failure_reason),
        registered_at: nextStatus === "registered" ? now : row.registered_at,
        updated_at: now,
      })
      .where(eq(enachMandates.id, row.id));

    return new NextResponse("Accepted", { status: 200 });
  } catch (error) {
    console.error("[E-NACH callback] Error:", error);
    // Still 200 so the NBFC integration doesn't retry endlessly.
    return new NextResponse("Internal error logged", { status: 200 });
  }
}

export async function GET(req: NextRequest) {
  const ref = new URL(req.url).searchParams.get("ref");
  return new NextResponse(ref ? `E-NACH callback ready for ${ref}` : "E-NACH callback endpoint", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
