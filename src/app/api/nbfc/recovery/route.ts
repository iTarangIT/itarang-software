/**
 * E-036 — GET /api/nbfc/recovery
 *
 * Tenant-scoped, paginated recovery pipeline listing per BRD §6.1.7.
 * Optional ?stage filter narrows to a single stage.
 *
 * AuthN/Z: resolveActor() — production uses the canonical Supabase session +
 * nbfc_users role; non-production accepts the triple-guarded test bypass.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { listRecoveryPipeline } from "@/lib/nbfc/recovery/stages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  stage: z
    .enum([
      "needs_inspection",
      "refurbishable",
      "scrap",
      "ready_for_auction",
      "resold",
    ])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);

    const { searchParams } = new URL(req.url);
    const parsed = Query.safeParse({
      stage: searchParams.get("stage") ?? undefined,
      page: searchParams.get("page") ?? undefined,
      page_size: searchParams.get("page_size") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await listRecoveryPipeline({
      tenant_id: actor.tenant_id,
      stage: parsed.data.stage,
      page: parsed.data.page,
      page_size: parsed.data.page_size,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
