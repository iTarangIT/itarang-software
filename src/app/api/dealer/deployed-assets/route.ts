import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deployedAssets } from "@/lib/db/schema";
import { guardApi } from "@/lib/auth/apiGuard";
import { deployedAssetScope } from "@/lib/dealer/deployedAssetsAccess";
import { eq, and, or, ilike, desc, sql, count, type SQL } from "drizzle-orm";

export async function GET(req: NextRequest) {
  try {
    // ID 118: signed in; a dealer sees only its own assets (rows, total AND
    // KPIs), outside parties none.
    const authGate = await guardApi();
    if (!authGate.ok) return authGate.response;
    const scope = deployedAssetScope(authGate.user);
    if (scope.kind === "deny") {
      return NextResponse.json(
        { success: false, message: "Forbidden: Insufficient permissions" },
        { status: 403 }
      );
    }
    const scopeCondition =
      scope.kind === "dealer" ? eq(deployedAssets.dealer_id, scope.dealerId) : undefined;

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status") || "all";
    const payment = searchParams.get("payment") || "all";
    const category = searchParams.get("category") || "all";
    const search = searchParams.get("search") || "";
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = parseInt(searchParams.get("limit") || "20", 10);
    const offset = (page - 1) * limit;

    const conditions: (SQL | undefined)[] = scopeCondition ? [scopeCondition] : [];

    if (status !== "all") {
      conditions.push(eq(deployedAssets.status, status));
    }
    if (payment !== "all") {
      conditions.push(eq(deployedAssets.payment_type, payment));
    }
    if (category !== "all") {
      conditions.push(eq(deployedAssets.asset_category, category));
    }
    if (search) {
      conditions.push(
        or(
          ilike(deployedAssets.serial_number, `%${search}%`),
          ilike(deployedAssets.customer_name, `%${search}%`),
          ilike(deployedAssets.customer_phone, `%${search}%`),
          ilike(deployedAssets.id, `%${search}%`),
          ilike(deployedAssets.model_type, `%${search}%`)
        )
      );
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalResult] = await Promise.all([
      db
        .select()
        .from(deployedAssets)
        .where(whereClause)
        .orderBy(desc(deployedAssets.created_at))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(deployedAssets)
        .where(whereClause),
    ]);

    const total = Number(totalResult[0]?.total || 0);

    // KPI aggregations
    const [kpis] = await db
      .select({
        total: count(),
        active: sql<number>`count(*) filter (where ${deployedAssets.status} = 'active')`,
        maintenance: sql<number>`count(*) filter (where ${deployedAssets.status} = 'maintenance')`,
        lowBattery: sql<number>`count(*) filter (where ${deployedAssets.battery_health_percent}::numeric < 30)`,
        maintenanceDue: sql<number>`count(*) filter (where ${deployedAssets.next_maintenance_due} < now())`,
        financeCount: sql<number>`count(*) filter (where ${deployedAssets.payment_type} = 'finance')`,
        leaseCount: sql<number>`count(*) filter (where ${deployedAssets.payment_type} = 'lease')`,
        upfrontCount: sql<number>`count(*) filter (where ${deployedAssets.payment_type} = 'upfront')`,
      })
      .from(deployedAssets)
      .where(scopeCondition);

    return NextResponse.json({
      success: true,
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      kpis: {
        total: Number(kpis?.total || 0),
        active: Number(kpis?.active || 0),
        maintenance: Number(kpis?.maintenance || 0),
        lowBattery: Number(kpis?.lowBattery || 0),
        maintenanceDue: Number(kpis?.maintenanceDue || 0),
        financeCount: Number(kpis?.financeCount || 0),
        leaseCount: Number(kpis?.leaseCount || 0),
        upfrontCount: Number(kpis?.upfrontCount || 0),
      },
    });
  } catch (error: any) {
    console.error("DEPLOYED ASSETS API ERROR:", error);
    return NextResponse.json(
      { success: false, message: error?.message || "Failed to fetch deployed assets" },
      { status: 500 }
    );
  }
}
