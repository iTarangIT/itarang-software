import { appendConvertedLead } from "@/lib/google/sheet";
import { NextResponse } from "next/server";

export async function GET() {
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
