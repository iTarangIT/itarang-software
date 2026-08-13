import { NextResponse } from "next/server";
import { awsSql } from "@/lib/db/aws";
import { requireDebugAccess } from "@/lib/auth/requireDebugAccess";

// Confirms the app can reach the AWS database, and leaks the driver's error
// text (host, credentials state) when it can't. 404s in production and
// without an admin/IT session.
export async function GET() {
  const access = await requireDebugAccess();
  if (!access.ok) return access.response;

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