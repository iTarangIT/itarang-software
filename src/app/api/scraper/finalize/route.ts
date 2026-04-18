import { NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { finalizeChunkedRun } from "@/lib/scraper/chunkedPipeline";

export const maxDuration = 60;

let receiver: Receiver | null = null;

function getReceiver(): Receiver {
  if (!receiver) {
    const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
    const next = process.env.QSTASH_NEXT_SIGNING_KEY;
    if (!current || !next) {
      throw new Error(
        "QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY are required",
      );
    }
    receiver = new Receiver({
      currentSigningKey: current,
      nextSigningKey: next,
    });
  }
  return receiver;
}

export async function POST(req: Request) {
  const signature = req.headers.get("upstash-signature");
  const rawBody = await req.text();

  if (!signature) {
    return NextResponse.json(
      { success: false, error: "Missing signature" },
      { status: 401 },
    );
  }

  try {
    const valid = await getReceiver().verify({ signature, body: rawBody });
    if (!valid) {
      return NextResponse.json(
        { success: false, error: "Invalid signature" },
        { status: 401 },
      );
    }
  } catch (err) {
    console.error("[scraper:finalize] signature verify failed", err);
    return NextResponse.json(
      { success: false, error: "Signature verification error" },
      { status: 401 },
    );
  }

  let payload: { runId?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  if (!payload.runId) {
    return NextResponse.json(
      { success: false, error: "runId required" },
      { status: 400 },
    );
  }

  await finalizeChunkedRun(payload.runId);

  return NextResponse.json({ success: true });
}
