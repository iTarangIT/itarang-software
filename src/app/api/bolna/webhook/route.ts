import { handleBolnaWebhook } from "@/lib/ai/bolna_ai";
import { after, NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    console.log("WEBHOOK HIT", JSON.stringify({
      status: body.status,
      hasTranscript: !!body.transcript,
      phone: body.user_number || body.recipient_phone_number,
      keys: Object.keys(body),
    }));

    // Acknowledge Bolna immediately so it doesn't retry; do the heavy
    // analysis + DB writes + next-lead trigger in the background.
    after(async () => {
      try {
        await handleBolnaWebhook(body);
      } catch (err) {
        console.error("[bolna:webhook] background handler failed", err);
      }
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("API error:", err);

    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
