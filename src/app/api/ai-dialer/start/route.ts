import { dialerSession, type DialerProvider } from "@/lib/queue/dialerSession";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

const ALLOWED_PROVIDERS: DialerProvider[] = ["bolna", "elevenlabs"];

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { queueIds, provider: rawProvider, category, location } = body;

  if (!Array.isArray(queueIds) || queueIds.length === 0) {
    return NextResponse.json(
      { success: false, error: "queueIds array required" },
      { status: 400 },
    );
  }

  const provider: DialerProvider = ALLOWED_PROVIDERS.includes(rawProvider)
    ? rawProvider
    : "bolna";

  // `location` is sent by the new region-targeted dialer flow. We trust the
  // client's queueIds as authoritative (they already had the location
  // filter applied client-side), so the location here is only for audit /
  // observability — useful when answering "what region was this session
  // dialing?" from logs alone.
  if (typeof location === "string" && location !== "all" && location.trim()) {
    console.log(
      `[AI DIALER] session.start provider=${provider} category=${category ?? "all"} location="${location}" queue=${queueIds.length}`,
    );
  }

  await dialerSession.start(queueIds, {
    provider,
    category: typeof category === "string" ? category : undefined,
  });

  // Tag every lead in the queue with the chosen provider so:
  //  1. The catch-up cron routes them to the correct provider's scheduler
  //  2. Any in-flight follow-ups land on the same provider
  try {
    await db
      .update(dealerLeads)
      .set({ provider })
      .where(inArray(dealerLeads.id, queueIds));
  } catch (err) {
    console.error("[AI DIALER] Failed to bulk-tag dealer_leads.provider:", err);
  }

  return NextResponse.json({
    success: true,
    provider,
    category: category ?? null,
    queued: queueIds.length,
  });
}
