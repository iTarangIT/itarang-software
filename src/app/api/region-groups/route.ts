/**
 * /api/region-groups
 *
 *   GET  → list every saved region group (org-wide; no owner filter).
 *   POST → create a new group.
 *
 * Groups are visible to every sales user — the user picked org-wide in
 * the design phase, so we don't filter on created_by. A future PR could
 * add a visibility column without breaking this endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { regionGroups } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { LEADS_BULK_ROLES, LEADS_PAGE_ROLES } from "@/lib/leads/access";
import { guardApi } from "@/lib/auth/apiGuard";

type RegionEntry = { state: string; cities?: string[] };

function sanitizeRegions(input: unknown): RegionEntry[] {
  if (!Array.isArray(input)) return [];
  const out: RegionEntry[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const state = typeof (entry as any).state === "string" ? (entry as any).state.trim() : "";
    if (!state) continue;
    const rawCities = (entry as any).cities;
    const cities = Array.isArray(rawCities)
      ? rawCities
          .filter((c) => typeof c === "string" && c.trim())
          .map((c: string) => c.trim())
      : [];
    out.push({ state, cities });
  }
  return out;
}

export async function GET() {
  // ID 118: signed in, with a role that reaches this screen.
  const authGate = await guardApi([...LEADS_PAGE_ROLES]);
  if (!authGate.ok) return authGate.response;
  try {
    const rows = await db
      .select()
      .from(regionGroups)
      .orderBy(desc(regionGroups.updated_at));
    return NextResponse.json({ success: true, data: rows });
  } catch (err: any) {
    console.error("[region-groups] list error:", err);
    return NextResponse.json(
      { success: false, error: err.message ?? "Failed to list region groups" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  // ID 118 item 5: reading groups is any leads-page role; changing the
  // org-wide set is the managers' bulk list (same as the Manage groups button).
  const authGate = await guardApi([...LEADS_BULK_ROLES]);
  if (!authGate.ok) return authGate.response;
  try {
    const body = await req.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const description =
      typeof body?.description === "string" ? body.description.trim() : null;
    const regions = sanitizeRegions(body?.regions);
    // Who created it comes from the session, never from the body.
    const createdBy = authGate.user.id;

    if (!name) {
      return NextResponse.json(
        { success: false, error: "name is required" },
        { status: 400 },
      );
    }
    if (regions.length === 0) {
      return NextResponse.json(
        { success: false, error: "regions must include at least one {state, cities} entry" },
        { status: 400 },
      );
    }

    const id = `rg_${nanoid(10)}`;
    await db.insert(regionGroups).values({
      id,
      name,
      description,
      regions,
      created_by: createdBy,
      created_at: new Date(),
      updated_at: new Date(),
    });

    return NextResponse.json({ success: true, id });
  } catch (err: any) {
    console.error("[region-groups] create error:", err);
    return NextResponse.json(
      { success: false, error: err.message ?? "Failed to create region group" },
      { status: 500 },
    );
  }
}
