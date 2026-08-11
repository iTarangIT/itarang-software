import { appendConvertedLead } from "@/lib/google/sheet";
import { NextResponse } from "next/server";
import { requireDebugAccess } from "@/lib/auth/requireDebugAccess";

// Writes a junk row into the shared converted-leads Google Sheet on a bare
// GET — anyone could pollute the sheet the sales team works from. 404s in
// production and without an admin/IT session.
export async function GET() {
  const access = await requireDebugAccess();
  if (!access.ok) return access.response;

  try {
    await appendConvertedLead({
      id: "TEST-001",
      name: "Test Dealer",
      phone: "+919999999999",
      email: "test@test.com",
      website: "https://test.com",
      city: "Mumbai",
      address: "123 Test Street",
      source: "google",
      convertedAt: new Date(),
      convertedBy: "Test User",
    });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message });
  }
}
