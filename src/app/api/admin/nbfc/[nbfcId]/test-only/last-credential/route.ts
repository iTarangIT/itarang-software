/**
 * Test-only endpoint — returns the most recent NBFC portal credential job
 * pushed into the in-memory recorder for the given nbfcId.
 *
 * Only available when:
 *   1. NODE_ENV !== 'production'
 *   2. NBFC_PORTAL_EMAIL_INMEMORY = '1'
 *   3. NBFC_TEST_BYPASS_SECRET is set and matches `x-nbfc-test-bypass`.
 *
 * Without all three, returns 404 so production never exposes credentials.
 */
import { NextRequest, NextResponse } from "next/server";

import { __inMemoryNbfcCredentialJobs } from "@/lib/queue/jobs/sendNbfcPortalCredentialsJob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ nbfcId: string }> },
) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.NBFC_PORTAL_EMAIL_INMEMORY !== "1"
  ) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  const secret = process.env.NBFC_TEST_BYPASS_SECRET;
  const provided = req.headers.get("x-nbfc-test-bypass");
  if (!secret || provided !== secret) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  const { nbfcId } = await ctx.params;
  const id = Number.parseInt(nbfcId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { ok: false, error: "Invalid nbfcId" },
      { status: 400 },
    );
  }

  const matching = __inMemoryNbfcCredentialJobs
    .filter((j) => j.nbfcId === id)
    .slice(-1)[0];

  if (!matching) {
    return NextResponse.json(
      { ok: false, error: "No credential job recorded" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    ok: true,
    nbfcId: matching.nbfcId,
    credentialId: matching.credentialId,
    toEmail: matching.toEmail,
    password: matching.password,
    supabaseUserId: matching.supabaseUserId,
  });
}
