import { NextRequest, NextResponse } from "next/server";

import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";
import { runEntityVerification } from "@/lib/nbfc/admin/entity-kyc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ nbfcId: string }> },
) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  const { nbfcId } = await ctx.params;
  const id = Number.parseInt(nbfcId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { ok: false, error: "Invalid nbfcId" },
      { status: 400 },
    );
  }

  const result = await runEntityVerification({
    nbfcId: id,
    type: "cin",
    verifiedBy: auth.user.id ?? null,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status },
    );
  }

  return NextResponse.json({
    ok: true,
    verificationId: result.verificationId,
    status: result.status,
    providerReferenceId: result.providerReferenceId,
    raw: result.raw,
  });
}
