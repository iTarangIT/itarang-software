import { NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { sql } from "drizzle-orm";

export async function GET() {
  try {
    await db.execute(sql`
      ALTER TABLE dealer_onboarding_applications
      ADD COLUMN IF NOT EXISTS owner_name text,
      ADD COLUMN IF NOT EXISTS owner_phone text,
      ADD COLUMN IF NOT EXISTS owner_email text,
      ADD COLUMN IF NOT EXISTS bank_name text,
      ADD COLUMN IF NOT EXISTS account_number text,
      ADD COLUMN IF NOT EXISTS beneficiary_name text,
      ADD COLUMN IF NOT EXISTS ifsc_code text,
      ADD COLUMN IF NOT EXISTS correction_remarks text,
      ADD COLUMN IF NOT EXISTS rejection_remarks text,
      ADD COLUMN IF NOT EXISTS dealer_account_status varchar(30) DEFAULT 'inactive',
      ADD COLUMN IF NOT EXISTS dealer_code text;
    `);

    return NextResponse.json({
      success: true,
      message: "Dealer onboarding table altered successfully",
    });
  } catch (error: any) {
    console.error("ALTER ONBOARDING TABLE ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to alter onboarding table",
      },
      { status: 500 }
    );
  }
}