/**
 * E-091 — DPDPA retention enforcer endpoint.
 *
 * POST /api/nbfc/dpdpa/retention/run
 *   Body: { dry_run?: boolean=false, as_of?: ISO datetime }
 *   Auth: admin role only (returns 403 otherwise).
 *
 * Reuses the dual-approval auth idiom (`resolveActor`) — same triple-guarded
 * test bypass that the rest of the NBFC self-coding loop uses, plus the
 * canonical `getCurrentTenant` + `requireNbfcAccess` path in production.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { runDpdpaRetention } from "@/lib/nbfc/dpdpa/retentionCron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  dry_run: z.boolean().default(false),
  as_of: z.string().datetime().optional(),
});

const ADMIN_ROLES = new Set(["admin", "nbfc_admin", "nbfc_compliance_officer"]);

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (!ADMIN_ROLES.has(actor.role)) {
      return NextResponse.json(
        { ok: false, error: "FORBIDDEN: admin role required" },
        { status: 403 },
      );
    }

    let raw: unknown = {};
    try {
      // Body is optional — empty bodies are allowed.
      const text = await req.text();
      raw = text ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await runDpdpaRetention({
      asOf: parsed.data.as_of ? new Date(parsed.data.as_of) : undefined,
      dryRun: parsed.data.dry_run,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
