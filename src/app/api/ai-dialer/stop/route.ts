import { dialerSession } from "@/lib/queue/dialerSession";
import { NextResponse } from "next/server";

export async function POST() {
  dialerSession.stop();
  return NextResponse.json({ success: true });
}