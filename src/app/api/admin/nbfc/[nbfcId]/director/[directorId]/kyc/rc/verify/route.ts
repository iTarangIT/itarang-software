import { NextRequest, NextResponse } from "next/server";

import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";
import { runDirectorVerification } from "@/lib/nbfc/admin/director-kyc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ nbfcId: string; directorId: string }> },
) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  const { directorId } = await ctx.params;
  const id = Number.parseInt(directorId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { ok: false, error: "Invalid directorId" },
      { status: 400 },
    );
  }

  let body: { rcNumber?: string } = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  const result = await runDirectorVerification({
    directorId: id,
    type: "rc",
    payload: { rcNumber: body.rcNumber },
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
