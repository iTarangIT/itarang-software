import { dialerSession, type DialerProvider } from "@/lib/queue/dialerSession";
import { db } from "@/lib/db";
import { dealerLeads, regionGroups } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { createCampaign } from "@/lib/queue/campaignTracker";
import { advanceCampaign } from "@/lib/queue/advanceCampaign";
import { requireAuth } from "@/lib/auth-utils";

const ALLOWED_PROVIDERS: DialerProvider[] = ["bolna", "elevenlabs"];

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { queueIds, provider: rawProvider, category, location, region } = body;

  if (!Array.isArray(queueIds) || queueIds.length === 0) {
    return NextResponse.json(
      { success: false, error: "queueIds array required" },
      { status: 400 },
    );
  }

  const provider: DialerProvider = ALLOWED_PROVIDERS.includes(rawProvider)
    ? rawProvider
    : "bolna";

  // `location` / `region` come from the region-targeted dialer flow. We trust
  // the client's queueIds as authoritative (they already had the location
  // filter applied client-side); region is persisted on the campaign for
  // history + replay, location is logged for grep-ability of old runs.
  if (typeof location === "string" && location !== "all" && location.trim()) {
    console.log(
      `[AI DIALER] session.start provider=${provider} category=${category ?? "all"} location="${location}" queue=${queueIds.length}`,
    );
  }

  // Resolve triggered_by. requireAuth() returns null/redirects on no-session,
  // but a system-fired start (e.g. cron-driven sweeps) might not have a user;
  // keep the campaign insert resilient by tolerating an absent user.
  let triggeredBy: string | null = null;
  try {
    const user = await requireAuth();
    triggeredBy = (user as any)?.id ?? null;
  } catch {
    triggeredBy = null;
  }

  // Snapshot saved-group names into the region blob so the campaign history
  // survives group renames/deletes. Best-effort — if lookup fails, we still
  // persist the original payload and the UI falls back to "Saved group".
  let regionToPersist: unknown = region ?? null;
  if (
    region &&
    typeof region === "object" &&
    Array.isArray((region as { groupIds?: unknown }).groupIds) &&
    ((region as { groupIds: string[] }).groupIds.length > 0)
  ) {
    try {
      const ids = (region as { groupIds: string[] }).groupIds;
      const rows = await db
        .select({ id: regionGroups.id, name: regionGroups.name })
        .from(regionGroups)
        .where(inArray(regionGroups.id, ids));
      const groupNames = ids
        .map((id) => rows.find((r) => r.id === id)?.name)
        .filter(Boolean) as string[];
      regionToPersist = { ...(region as object), groupNames };
    } catch (err) {
      console.error("[AI DIALER] groupNames snapshot failed:", err);
    }
  }

  // Insert campaign + per-lead rows BEFORE starting the session so the
  // banner's first poll already sees a campaignId. createCampaign is
  // best-effort — failure returns null and the session still starts.
  const campaignId = await createCampaign({
    queueIds,
    provider,
    category: typeof category === "string" ? category : null,
    region: regionToPersist,
    triggeredBy,
  });

  await dialerSession.start(queueIds, {
    provider,
    category: typeof category === "string" ? category : undefined,
    campaignId: campaignId ?? undefined,
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

  // Place the first call server-side via the DB-driven advance. The whole
  // queue is now in dialer_campaign_leads; advanceCampaign atomically
  // claims the first pending row, fires the call, persists the call id.
  // Done after the response so the user sees instant UI feedback; the
  // provider call placement (which can take a couple of seconds) doesn't
  // block the redirect/banner update.
  let firstCallPlaced = false;
  let firstCallError: string | null = null;
  if (campaignId) {
    try {
      const r = await advanceCampaign(campaignId);
      firstCallPlaced = r.kind === "placed";
      if (r.kind === "error") {
        firstCallError = r.error;
      }
    } catch (err) {
      firstCallError = err instanceof Error ? err.message : "advance threw";
      console.error("[AI DIALER] start → advanceCampaign failed:", err);
    }
  }

  return NextResponse.json({
    success: true,
    provider,
    category: category ?? null,
    queued: queueIds.length,
    campaignId,
    firstCallPlaced,
    firstCallError,
  });
}
