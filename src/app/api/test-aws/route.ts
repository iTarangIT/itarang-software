import { NextResponse } from "next/server";
import { awsSql } from "@/lib/db/aws";

export async function GET() {
  try {
    const result = await awsSql`select now() as current_time`;
    return NextResponse.json({ success: true, result });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}