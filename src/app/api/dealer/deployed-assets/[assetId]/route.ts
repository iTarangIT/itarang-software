import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deployedAssets, deploymentHistory, serviceTickets } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
) {
  try {
    const { assetId } = await params;

    const [asset] = await db
      .select()
      .from(deployedAssets)
      .where(eq(deployedAssets.id, assetId))
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
