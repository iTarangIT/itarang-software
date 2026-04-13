import { dialerSession } from "@/lib/queue/dialerSession";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { queueIds } = await req.json();
  dialerSession.start(queueIds);
  return NextResponse.json({ success: true });
}