import { NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import { sql } from "drizzle-orm";

export async function GET() {
  try {
    const result = await db.execute(sql`
      select column_name, data_type
      from information_schema.columns
      where table_name = 'dealer_onboarding_applications'
      order by ordinal_position
    `);

    return NextResponse.json({
      success: true,
      columns: result,
    });
  } catch (error: any) {
    console.error("DEBUG ONBOARDING DB ERROR:", error);
    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to inspect onboarding table",
        cause: error?.cause || null,
      },
      { status: 500 }
    );
  }
}