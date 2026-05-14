/**
 * /api/region-groups/[id]
 *
 *   PATCH  → update name, description, or regions.
 *   DELETE → remove a group. The two seed groups (`rg_delhi_ncr`,
 *           `rg_mumbai_zone`) can be deleted too — they're seeded as
 *           examples, not pinned defaults.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { regionGroups } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

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

export async function PATCH(req: NextRequest, { params }: any) {
  try {
    const { id } = await params;
    const body = await req.json();
    const patch: Record<string, any> = {};

    if (typeof body?.name === "string" && body.name.trim()) {
      patch.name = body.name.trim();
    }
    if (typeof body?.description === "string") {
      patch.description = body.description.trim() || null;
    }
    if (body?.regions !== undefined) {
      const regions = sanitizeRegions(body.regions);
      if (regions.length === 0) {
        return NextResponse.json(
          { success: false, error: "regions must include at least one {state, cities} entry" },
          { status: 400 },
        );
      }
      patch.regions = regions;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { success: false, error: "Nothing to update" },
        { status: 400 },
      );
    }

    patch.updated_at = new Date();

    const updated = await db
      .update(regionGroups)
      .set(patch)
      .where(eq(regionGroups.id, id))
      .returning({ id: regionGroups.id });

    if (updated.length === 0) {
      return NextResponse.json(
        { success: false, error: "Region group not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("[region-groups] update error:", err);
    return NextResponse.json(
      { success: false, error: err.message ?? "Failed to update region group" },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: NextRequest, { params }: any) {
  try {
    const { id } = await params;
    const deleted = await db
      .delete(regionGroups)
      .where(eq(regionGroups.id, id))
      .returning({ id: regionGroups.id });
    if (deleted.length === 0) {
      return NextResponse.json(
        { success: false, error: "Region group not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("[region-groups] delete error:", err);
    return NextResponse.json(
      { success: false, error: err.message ?? "Failed to delete region group" },
      { status: 500 },
    );
  }
}
