import { NextRequest, NextResponse } from "next/server";
import { eq, asc } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  nbfc,
  nbfcDirectors,
  nbfcDirectorKycVerifications,
  nbfcEntityKycVerifications,
} from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
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

  const [nbfcRow] = await db
    .select({
      id: nbfc.id,
      legal_name: nbfc.legal_name,
      cin: nbfc.cin,
      pan_number: nbfc.pan_number,
      gst_number: nbfc.gst_number,
      status: nbfc.status,
    })
    .from(nbfc)
    .where(eq(nbfc.id, id))
    .limit(1);

  if (!nbfcRow) {
    return NextResponse.json(
      { ok: false, error: "NBFC not found" },
      { status: 404 },
    );
  }

  const entityVerifications = await db
    .select()
    .from(nbfcEntityKycVerifications)
    .where(eq(nbfcEntityKycVerifications.nbfc_id, id))
    .orderBy(asc(nbfcEntityKycVerifications.verified_at));

  const directors = await db
    .select()
    .from(nbfcDirectors)
    .where(eq(nbfcDirectors.nbfc_id, id))
    .orderBy(asc(nbfcDirectors.id));

  const directorIds = directors.map((d) => d.id);
  const directorVerifications = directorIds.length
    ? await db
        .select()
        .from(nbfcDirectorKycVerifications)
        .orderBy(asc(nbfcDirectorKycVerifications.verified_at))
    : [];

  const directorVerifMap = new Map<number, typeof directorVerifications>();
  for (const v of directorVerifications) {
    if (!directorIds.includes(v.director_id)) continue;
    const list = directorVerifMap.get(v.director_id) ?? [];
    list.push(v);
    directorVerifMap.set(v.director_id, list);
  }

  return NextResponse.json({
    ok: true,
    nbfc: nbfcRow,
    entityVerifications,
    directors: directors.map((d) => ({
      ...d,
      verifications: directorVerifMap.get(d.id) ?? [],
    })),
  });
}
