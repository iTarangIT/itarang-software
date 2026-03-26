import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const res = await fetch("https://api.bolna.ai/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.BOLNA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: process.env.BOLNA_AGENT_ID,
        recipient_phone_number: body.phone,
        from_phone_number: process.env.BOLNA_FROM_NUMBER,
        agent_data: {
          voice_id: "Vikram",
        },
      }),
    });

    const json = await res.json();

    return NextResponse.json({
      success: true,
      data: json,
    });
  } catch (err: any) {
    console.error("Bolna test error:", err);

    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
