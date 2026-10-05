import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deployedAssets, deploymentHistory, serviceTickets } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { guardApi } from "@/lib/auth/apiGuard";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
) {
  // ID 118: a dealer, and only that dealer's own assets — the row carries the
  // customer's name, phone and GPS. Same rule as /api/dealer/assets.
  const authGate = await guardApi(["dealer"]);
  if (!authGate.ok) return authGate.response;
  const dealerId = authGate.user.dealer_id;
  if (!dealerId) {
    return NextResponse.json({ success: false, message: "Asset not found" }, { status: 404 });
  }
  try {
    const { assetId } = await params;

    const [asset] = await db
      .select()
      .from(deployedAssets)
      .where(and(eq(deployedAssets.id, assetId), eq(deployedAssets.dealer_id, dealerId)))
      .limit(1);

    if (!asset) {
      return NextResponse.json(
        { success: false, message: "Asset not found" },
        { status: 404 }
      );
    }

    const [history, tickets] = await Promise.all([
      db
        .select()
        .from(deploymentHistory)
        .where(eq(deploymentHistory.deployed_asset_id, assetId))
        .orderBy(desc(deploymentHistory.created_at)),
      db
        .select()
        .from(serviceTickets)
        .where(eq(serviceTickets.deployed_asset_id, assetId))
        .orderBy(desc(serviceTickets.created_at))
        .limit(10),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        asset,
        history,
        serviceTickets: tickets,
      },
    });
  } catch (error: any) {
    console.error("ASSET DETAIL API ERROR:", error);
    return NextResponse.json(
      { success: false, message: error?.message || "Failed to fetch asset details" },
      { status: 500 }
    );
  }
}
