/**
 * POST /api/nbfc/settings/esign-credentials/test — test the SAVED credentials for
 * a provider against its API (E-166). Body: { provider_type }. nbfc_admin only.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getEsignProvider, isKnownEsignProvider } from "@/lib/nbfc/esign/registry";
import { loadProviderCredentials } from "@/lib/nbfc/esign/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ provider_type: z.string().min(1).max(24) });

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (actor.role !== "nbfc_admin") {
      return NextResponse.json({ ok: false, error: "FORBIDDEN: nbfc_admin required" }, { status: 403 });
    }
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success || !isKnownEsignProvider(parsed.data.provider_type)) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: unknown provider" }, { status: 400 });
    }
    const creds = await loadProviderCredentials(actor.tenant_id, parsed.data.provider_type);
    if (!creds) {
      return NextResponse.json({ ok: true, test: { ok: false, detail: "No credentials configured" } });
    }
    const provider = await getEsignProvider(parsed.data.provider_type);
    const result = await provider.testConnection(creds);
    return NextResponse.json({ ok: true, test: result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("FORBIDDEN") ? 403 : msg.startsWith("UNAUTHORIZED") ? 401 : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status });
  }
}
