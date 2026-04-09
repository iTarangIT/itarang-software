import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { kycDataAudit } from "@/lib/db/schema";
import {
  createWorkflowId,
  requireAdminAppUser,
} from "@/lib/kyc/admin-workflow";

const VALID_DATA_SOURCES = ["ocr", "api", "manual"] as const;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId } = await params;

    const entries = await db
      .select()
      .from(kycDataAudit)
      .where(eq(kycDataAudit.lead_id, leadId))
      .orderBy(desc(kycDataAudit.entered_at));

    return NextResponse.json({
      success: true,
      data: entries,
    });
  } catch (error) {
    console.error("[KYC Data Audit GET] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to fetch audit trail";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  try {
    const appUser = await requireAdminAppUser();
    if (!appUser) {
      return NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 403 },
      );
    }

    const { leadId } = await params;
    const body = await req.json();

    const fieldName =
      typeof body.field_name === "string" ? body.field_name.trim() : "";
    const fieldValue =
      typeof body.field_value === "string" ? body.field_value.trim() : "";
    const dataSource =
      typeof body.data_source === "string" ? body.data_source.trim() : "";
    const reason =
      typeof body.reason === "string" ? body.reason.trim() : null;

    if (!fieldName || !dataSource) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "field_name and data_source are required" },
        },
        { status: 400 },
      );
    }

    if (
      !VALID_DATA_SOURCES.includes(
        dataSource as (typeof VALID_DATA_SOURCES)[number],
      )
    ) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: `data_source must be one of: ${VALID_DATA_SOURCES.join(", ")}`,
          },
        },
        { status: 400 },
      );
    }

    const now = new Date();
    const id = createWorkflowId("KYCAUD", now);

    await db.insert(kycDataAudit).values({
      id,
      lead_id: leadId,
      field_name: fieldName,
      field_value: fieldValue || null,
      data_source: dataSource,
      entered_by: appUser.id,
      entered_at: now,
      reason,
    });

    return NextResponse.json({
      success: true,
      data: { id, leadId, fieldName, dataSource },
    });
  } catch (error) {
    console.error("[KYC Data Audit POST] Error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to create audit entry";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
