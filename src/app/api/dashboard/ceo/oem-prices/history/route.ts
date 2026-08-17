/**
 * E-242 — GET /api/dashboard/ceo/oem-prices/history
 *
 * The complete price history, across every model.
 *
 * The sibling route [assetType]/[productId]/history answers "what has THIS
 * product cost?" and backs the per-product schedule drawer. This one answers
 * the question the requirement actually asked — "which price was applied to
 * which Model ID, and when was it changed?" — which no amount of opening
 * products one at a time assembles.
 *
 * No migration behind it: oem_reference_prices has been append-only since
 * E-226, so every revision ever made is already on disk. What was missing was
 * only a way to read it whole.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import {
  isOemAssetType,
  listAllOemPriceHistory,
  OEM_HISTORY_MAX_LIMIT,
} from "@/lib/leads/oemPrices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin"]);

/** A bad date in a query string must not blank the panel — ignore it instead. */
function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
      );
    }

    const q = req.nextUrl.searchParams;
    const rawAsset = q.get("assetType");
    // An unrecognised asset type falls back to "all" rather than 400ing: this
    // is a read on a dashboard panel, and a typo in a query string should not
    // blank the CEO's screen. Same posture as the quotations queue.
    const assetType = rawAsset && isOemAssetType(rawAsset) ? rawAsset : null;

    const limit = Number(q.get("limit") ?? 50);
    const offset = Number(q.get("offset") ?? 0);

    const { rows, total } = await listAllOemPriceHistory({
      assetType,
      search: q.get("search"),
      from: parseDate(q.get("from")),
      to: parseDate(q.get("to")),
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });

    return NextResponse.json({
      success: true,
      data: {
        revisions: rows,
        total,
        limit: Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), OEM_HISTORY_MAX_LIMIT),
        offset: Math.max(Number.isFinite(offset) ? offset : 0, 0),
      },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    console.error("[ceo/oem-prices/history] failed", {
      message: e instanceof Error ? e.message : String(e),
      cause: e instanceof Error && e.cause instanceof Error ? e.cause.message : undefined,
    });
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
