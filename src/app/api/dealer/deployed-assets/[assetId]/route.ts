import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deployedAssets, deploymentHistory, serviceTickets } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { guardApi } from "@/lib/auth/apiGuard";
import { canReadDeployedAsset, deployedAssetScope } from "@/lib/dealer/deployedAssetsAccess";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
) {
  // ID 118: signed in; a dealer sees only its own assets, outside parties none.
  const authGate = await guardApi();
  if (!authGate.ok) return authGate.response;
  const scope = deployedAssetScope(authGate.user);
  if (scope.kind === "deny") {
    return NextResponse.json(
      { success: false, message: "Forbidden: Insufficient permissions" },
      { status: 403 }
    );
  }
  try {
    const { assetId } = await params;

    const [asset] = await db
      .select()
      .from(deployedAssets)
      .where(eq(deployedAssets.id, assetId))
      .limit(1);

    // Another dealer's asset is "not found", not "forbidden" — no id probing.
    if (!asset || !canReadDeployedAsset(scope, asset.dealer_id)) {
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
