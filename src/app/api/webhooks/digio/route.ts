import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json();

  console.log("DIGIO WEBHOOK:", body);

  const status = body.status;
  const documentId = body.document_id;

  // TODO: update DB

  if (status === "completed") {
    console.log("Agreement signed");
  }

  return NextResponse.json({ received: true });
}