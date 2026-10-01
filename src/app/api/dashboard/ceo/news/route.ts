// GET /api/dashboard/ceo/news — the Green Energy News feed (E-306). CEO only.
//
//   ?region=india|world  ?category=<key>  ?days=1..90  ?limit=1..100  ?cursor=
//   ?top=1  → the overview card: today's brief + top items of the last 24 h.

import type { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { isNewsCategory, isNewsRegion } from "@/lib/news/categories";
import {
  getBrief,
  getLastRun,
  getLatestBrief,
  itemsByIds,
  listItems,
  topItems,
} from "@/lib/news/queries";
import { getGreenNewsSettings } from "@/lib/news/settings";
import { istDateString } from "@/lib/news/time";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: NextRequest) => {
  await requireRole(["ceo"]);
  const q = req.nextUrl.searchParams;

  const regionRaw = q.get("region");
  const categoryRaw = q.get("category");
  if (regionRaw && !isNewsRegion(regionRaw)) return errorResponse("Unknown region", 400);
  if (categoryRaw && !isNewsCategory(categoryRaw)) return errorResponse("Unknown category", 400);

  const [settings, lastRun] = await Promise.all([getGreenNewsSettings(), getLastRun()]);

  if (q.get("top") === "1") {
    const today = istDateString();
    const [items, brief] = await Promise.all([topItems(6), getBrief(today).then((b) => b ?? getLatestBrief())]);
    const cited = brief ? await itemsByIds(brief.bullets.flatMap((b) => b.item_ids)) : new Map();
    return successResponse({
      enabled: settings.enabled,
      lastRun,
      brief: brief
        ? {
            ...brief,
            bullets: brief.bullets.map((b) => ({
              text: b.text,
              links: b.item_ids.map((id) => cited.get(id)).filter(Boolean),
            })),
          }
        : null,
      items,
    });
  }

  const dateRaw = q.get("brief_date");
  const briefDate = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : istDateString();
  const [page, brief] = await Promise.all([
    listItems({
      region: regionRaw as "india" | "world" | null,
      category: categoryRaw as never,
      days: Number(q.get("days")) || 7,
      limit: Number(q.get("limit")) || 30,
      cursor: q.get("cursor"),
    }),
    getBrief(briefDate),
  ]);
  const cited = brief ? await itemsByIds(brief.bullets.flatMap((b) => b.item_ids)) : new Map();

  return successResponse({
    enabled: settings.enabled,
    lastRun,
    brief: brief
      ? {
          ...brief,
          bullets: brief.bullets.map((b) => ({
            text: b.text,
            links: b.item_ids.map((id) => cited.get(id)).filter(Boolean),
          })),
        }
      : null,
    items: page.items,
    nextCursor: page.nextCursor,
  });
});
