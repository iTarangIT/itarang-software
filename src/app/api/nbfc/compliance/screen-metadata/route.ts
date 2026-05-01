/**
 * GET /api/nbfc/compliance/screen-metadata  (E-080 — BRD §6.4.2)
 *
 * Mandatory compliance metadata renderer for borrower-impacting screens.
 * Returns the authoritative compliance block (lender identity, LSP identity,
 * grievance channel, outstanding amount + restoration steps, reversibility
 * disclosure, DPDPA data-purpose, regulatory footer) so every screen renders
 * consistent server-driven copy.
 *
 * AuthN/Z: getCurrentTenant + requireNbfcAccess. The triple-guarded test
 * bypass (NODE_ENV != production AND NBFC_TEST_BYPASS_SECRET set on server AND
 * `x-nbfc-test-bypass` header on request) is reused from the dual-approval
 * route family for the self-coding loop's API tests.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  composeComplianceScreenMetadata,
  BadRequestError,
  type ComplianceScreenKey,
} from "@/lib/nbfc/compliance/screen-metadata";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  screen: z.enum([
    "immobilisation_confirm",
    "collection_sms",
    "telemetry_view",
    "portal_footer",
    "recovery_call",
    "sms_template",
  ]),
  lead_id: z.string().min(1).optional(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);

    const { searchParams } = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      screen: searchParams.get("screen") ?? undefined,
      lead_id: searchParams.get("lead_id") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: "VALIDATION",
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    const block = await composeComplianceScreenMetadata({
      tenant_id: actor.tenant_id,
      screen: parsed.data.screen as ComplianceScreenKey,
      lead_id: parsed.data.lead_id,
    });

    return NextResponse.json(block);
  } catch (e) {
    if (e instanceof BadRequestError) {
      return NextResponse.json(
        { ok: false, error: e.message },
        { status: 400 },
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
