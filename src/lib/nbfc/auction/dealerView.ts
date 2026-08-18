/**
 * E-234 — the dealer-facing projection of an auction (BRD §9, §10, §11, §21).
 *
 * TWO RULES SHAPE EVERY FUNCTION HERE, and both are about what is ABSENT:
 *
 *   1. AUDIENCE SCOPING. A dealer sees a lot only if they are in that lot's
 *      frozen `auction_lot_audience`. This is enforced in the query, not in the
 *      component — a filter applied after the fact is one refactor away from
 *      being dropped, and the failure mode is a competitor's stock leaking to
 *      the wrong region.
 *
 *   2. NO BIDDER IDENTITY, EVER. §11 says the highest bid is visible and the
 *      bidder's name is not. So the rival's name is not merely hidden in the
 *      UI — it never enters the payload. `you_are_leading` is computed
 *      server-side from the caller's own id so the client never needs to
 *      compare identities it should not have.
 */
import { db } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";
import { requireAuth } from "@/lib/auth-utils";
import { ForbiddenError } from "@/lib/buyback/errors";
import { isAuctionExcludedRole } from "@/lib/nbfc/auction/roles";
import { auctionLotAudience } from "@/lib/db/schema";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";

export interface AuctionDealerActor {
  user_id: string;
  /** accounts.id */
  dealer_id: string;
}

/**
 * Maps a thrown value to the response every dealer auction route returns.
 *
 * Shared rather than repeated per route because the first draft used a regex
 * over the message in five places and got the most common case wrong:
 * `requireAuth()` signs a caller out by calling Next's `redirect()`, which
 * throws a control-flow error carrying a `NEXT_REDIRECT` digest and NO useful
 * message. Every unauthenticated API call therefore came back as
 * `500 {"message":"NEXT_REDIRECT"}` — a redirect is meaningless to a `fetch()`
 * expecting JSON, and 500 told the client the server was broken when the real
 * answer was "you are signed out".
 */
export function auctionApiError(e: unknown): {
  body: { success: false; error: { message: string } };
  status: number;
} {
  if (isNextRedirectError(e)) {
    return {
      body: { success: false, error: { message: "Your session has expired. Please sign in again." } },
      status: 401,
    };
  }

  // ForbiddenError and friends carry an explicit status (see auth-utils.ts).
  const declared = (e as { status?: unknown })?.status;
  if (typeof declared === "number") {
    return {
      body: { success: false, error: { message: errorMessage(e) } },
      status: declared,
    };
  }

  const msg = errorMessage(e);
  const status = msg.startsWith("NOT_FOUND")
    ? 404
    : msg.startsWith("CONFLICT")
      ? 409
      : msg.startsWith("BAD_REQUEST")
        ? 400
        : msg.startsWith("FORBIDDEN")
          ? 403
          : msg.startsWith("UNAUTHORIZED")
            ? 401
            : 500;

  return {
    body: { success: false, error: { message: msg.replace(/^[A-Z_]+: /, "") } },
    status,
  };
}

/**
 * Auction-specific dealer guard.
 *
 * Deliberately NOT `requireDealer()` from buyback/auth.ts: that one also
 * demands a dealer TYPE that trades in old batteries (`capabilitiesFor().buyback`),
 * which is the right gate for selling scrap and the wrong one for buying at
 * auction. Every dealer may bid.
 *
 * The NBFC exclusion is restated here even though a `nbfc_partner` could not
 * pass `requireRole(["dealer"])` anyway. It is one line, it is the rule the BRD
 * is most emphatic about, and if the role list is ever widened this is the
 * check that has to be deleted on purpose rather than lost by accident.
 */
export async function requireAuctionDealer(): Promise<AuctionDealerActor> {
  const user = await requireAuth();

  if (isAuctionExcludedRole(user.role)) {
    throw new ForbiddenError(
      "NBFC users cannot take part in auctions — lots are sold to dealers only (BRD §9).",
    );
  }
  if (String(user.role ?? "").toLowerCase() !== "dealer") {
    throw new ForbiddenError("Only dealer accounts can view or bid on auctions.");
  }
  if (!user.dealer_id) {
    throw new ForbiddenError("Your login is not linked to a dealer account.");
  }

  return { user_id: user.id, dealer_id: user.dealer_id };
}

export interface DealerLotCard {
  lot_id: string;
  lot_code: string;
  title: string | null;
  status: string;
  quantity: number;
  conditions: string[];
  capacity: string | null;
  avg_soh: number | null;
  base_price: number;
  bid_increment: number;
  current_bid: number;
  bid_count: number;
  starts_at: string | null;
  ends_at: string;
  auction_type: string;
  city: string | null;
  state: string | null;
  distance_km: number | null;
  image_url: string | null;
  you_are_leading: boolean;
  your_max_bid: number | null;
}

export interface ListDealerLotsInput {
  dealer_id: string;
  status?: "live" | "ending_soon" | "ended" | "all";
  condition?: string;
  auction_type?: string;
  state?: string;
  city?: string;
  min_price?: number;
  max_price?: number;
  max_distance_km?: number;
  sort?: "ending_soon" | "newest" | "price_asc" | "price_desc" | "nearest";
  page?: number;
  pageSize?: number;
}

/**
 * The dealer lot grid.
 *
 * One query, because a card carries per-lot aggregates (current bid, bid count,
 * the caller's own standing) that would otherwise be N+1 across a page of
 * twenty cards. `listLots()` in service.ts had exactly that bug while claiming
 * in its own comment not to.
 */
export async function listDealerLots(
  input: ListDealerLotsInput,
): Promise<{ items: DealerLotCard[]; total: number; page: number }> {
  const page = input.page ?? 1;
  const pageSize = Math.min(input.pageSize ?? 24, 60);
  const offset = (page - 1) * pageSize;

  const sort =
    input.sort === "newest"
      ? sql`l.published_at DESC NULLS LAST`
      : input.sort === "price_asc"
        ? sql`COALESCE(b.max_amount, l.base_price) ASC`
        : input.sort === "price_desc"
          ? sql`COALESCE(b.max_amount, l.base_price) DESC`
          : input.sort === "nearest"
            ? sql`a.distance_km ASC NULLS LAST`
            : sql`l.ends_at ASC`;

  const statusFilter =
    input.status === "ended"
      ? sql`l.status = 'ended'`
      : input.status === "ending_soon"
        ? sql`l.status = 'live' AND l.ends_at <= now() + interval '1 hour'`
        : input.status === "all"
          ? sql`l.status IN ('live','ended')`
          : sql`l.status = 'live'`;

  const rows = await db.execute(sql`
    WITH aud AS (
      -- One row per lot for this dealer. The audience table has a row per
      -- CHANNEL, so DISTINCT ON collapses the four channels back to one lot
      -- and stops each lot appearing four times in the grid.
      SELECT DISTINCT ON (lot_id) lot_id, distance_km, city, state
        FROM auction_lot_audience
       WHERE dealer_id = ${input.dealer_id}
    ),
    bids AS (
      SELECT lot_id,
             MAX(amount) AS max_amount,
             COUNT(*)::int AS bid_count,
             MAX(amount) FILTER (WHERE bidder_dealer_id = ${input.dealer_id}) AS my_max
        FROM auction_bids
       GROUP BY lot_id
    ),
    leader AS (
      SELECT DISTINCT ON (lot_id) lot_id, bidder_dealer_id
        FROM auction_bids
       ORDER BY lot_id, amount DESC, placed_at ASC
    ),
    items AS (
      -- The card shows the mix of grades in the pallet and ONE cover image.
      -- The cover is the first photo of whichever battery has one; a lot whose
      -- batteries were never photographed gets null and the card falls back to
      -- a placeholder rather than a broken image.
      SELECT i.lot_id,
             array_agg(DISTINCT i.condition) AS conditions,
             (array_agg(rb.image_urls[1]) FILTER (WHERE rb.image_urls[1] IS NOT NULL))[1] AS image_url
        FROM auction_lot_items i
        LEFT JOIN recovery_batteries rb ON rb.id = i.battery_id
       GROUP BY i.lot_id
    )
    SELECT l.id, l.lot_code, l.title, l.status, l.quantity, l.capacity,
           l.avg_soh, l.base_price, l.bid_increment, l.starts_at, l.ends_at,
           l.auction_type,
           a.city, a.state, a.distance_km,
           COALESCE(b.max_amount, 0) AS current_bid,
           COALESCE(b.bid_count, 0)  AS bid_count,
           b.my_max,
           (ld.bidder_dealer_id = ${input.dealer_id}) AS you_are_leading,
           it.conditions, it.image_url,
           COUNT(*) OVER () AS total_count
      FROM auction_lots l
      JOIN aud a       ON a.lot_id = l.id
      LEFT JOIN bids b ON b.lot_id = l.id
      LEFT JOIN leader ld ON ld.lot_id = l.id
      LEFT JOIN items it  ON it.lot_id = l.id
     WHERE ${statusFilter}
       AND (${input.condition ?? null}::text IS NULL
            OR ${input.condition ?? null}::text = ANY(it.conditions))
       AND (${input.auction_type ?? null}::text IS NULL
            OR l.auction_type = ${input.auction_type ?? null}::text)
       AND (${input.state ?? null}::text IS NULL OR a.state = ${input.state ?? null}::text)
       AND (${input.city ?? null}::text IS NULL OR a.city = ${input.city ?? null}::text)
       AND (${input.min_price ?? null}::numeric IS NULL
            OR COALESCE(b.max_amount, l.base_price) >= ${input.min_price ?? null}::numeric)
       AND (${input.max_price ?? null}::numeric IS NULL
            OR COALESCE(b.max_amount, l.base_price) <= ${input.max_price ?? null}::numeric)
       AND (${input.max_distance_km ?? null}::numeric IS NULL
            OR a.distance_km IS NULL
            OR a.distance_km <= ${input.max_distance_km ?? null}::numeric)
     ORDER BY ${sort}
     LIMIT ${pageSize} OFFSET ${offset}
  `);

  const list = rows as unknown as Array<Record<string, unknown>>;

  return {
    total: list.length > 0 ? Number(list[0].total_count) : 0,
    page,
    items: list.map(mapDealerLotCard),
  };
}

/**
 * Row → card. Extracted so the single-lot fetch below cannot drift away from
 * the grid: two copies of this mapping is how a field ends up present on the
 * card and missing on the detail page.
 */
function mapDealerLotCard(r: Record<string, unknown>): DealerLotCard {
  return {
    lot_id: String(r.id),
    lot_code: String(r.lot_code),
    title: r.title ? String(r.title) : null,
    status: String(r.status),
    quantity: Number(r.quantity),
    conditions: (r.conditions as string[] | null) ?? [],
    capacity: r.capacity ? String(r.capacity) : null,
    avg_soh: r.avg_soh === null ? null : Number(r.avg_soh),
    base_price: Number(r.base_price),
    bid_increment: Number(r.bid_increment),
    current_bid: Number(r.current_bid),
    bid_count: Number(r.bid_count),
    starts_at: r.starts_at ? new Date(String(r.starts_at)).toISOString() : null,
    ends_at: new Date(String(r.ends_at)).toISOString(),
    auction_type: String(r.auction_type),
    city: r.city ? String(r.city) : null,
    state: r.state ? String(r.state) : null,
    distance_km: r.distance_km === null ? null : Number(r.distance_km),
    image_url: r.image_url ? String(r.image_url) : null,
    you_are_leading: r.you_are_leading === true,
    your_max_bid: r.my_max === null ? null : Number(r.my_max),
  };
}

/**
 * One lot, by id, for a dealer who is in its frozen audience.
 *
 * The same shape as a grid card, fetched directly instead of by paging the grid
 * and searching it — see the note in `getDealerLotDetail`. No status filter:
 * if the dealer is in the audience they may see the lot whatever state it is
 * in, including paused and cancelled, which is exactly when they most need to
 * know.
 */
export async function getDealerLotCard(
  dealer_id: string,
  lot_id: string,
): Promise<DealerLotCard | null> {
  const rows = (await db.execute(sql`
    WITH aud AS (
      SELECT DISTINCT ON (lot_id) lot_id, distance_km, city, state
        FROM auction_lot_audience
       WHERE dealer_id = ${dealer_id} AND lot_id = ${lot_id}
    ),
    bids AS (
      SELECT lot_id,
             MAX(amount) AS max_amount,
             COUNT(*)::int AS bid_count,
             MAX(amount) FILTER (WHERE bidder_dealer_id = ${dealer_id}) AS my_max
        FROM auction_bids
       WHERE lot_id = ${lot_id}
       GROUP BY lot_id
    ),
    leader AS (
      SELECT DISTINCT ON (lot_id) lot_id, bidder_dealer_id
        FROM auction_bids
       WHERE lot_id = ${lot_id}
       ORDER BY lot_id, amount DESC, placed_at ASC
    ),
    items AS (
      SELECT i.lot_id,
             array_agg(DISTINCT i.condition) AS conditions,
             (array_agg(rb.image_urls[1]) FILTER (WHERE rb.image_urls[1] IS NOT NULL))[1] AS image_url
        FROM auction_lot_items i
        LEFT JOIN recovery_batteries rb ON rb.id = i.battery_id
       WHERE i.lot_id = ${lot_id}
       GROUP BY i.lot_id
    )
    SELECT l.id, l.lot_code, l.title, l.status, l.quantity, l.capacity,
           l.avg_soh, l.base_price, l.bid_increment, l.starts_at, l.ends_at,
           l.auction_type,
           a.city, a.state, a.distance_km,
           COALESCE(b.max_amount, 0) AS current_bid,
           COALESCE(b.bid_count, 0)  AS bid_count,
           b.my_max,
           (ld.bidder_dealer_id = ${dealer_id}) AS you_are_leading,
           it.conditions, it.image_url
      FROM auction_lots l
      JOIN aud a       ON a.lot_id = l.id
      LEFT JOIN bids b ON b.lot_id = l.id
      LEFT JOIN leader ld ON ld.lot_id = l.id
      LEFT JOIN items it  ON it.lot_id = l.id
     WHERE l.id = ${lot_id}
     LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;

  if (rows.length === 0) return null;
  return mapDealerLotCard(rows[0]);
}

export interface DealerLotDetail extends DealerLotCard {
  items: Array<{
    serial: string;
    condition: string;
    capacity: string | null;
    model: string | null;
    soh: number | null;
    image_urls: string[];
  }>;
  /** Amounts and times only — NEVER who placed them (BRD §11). */
  bid_history: Array<{ amount: number; placed_at: string; is_yours: boolean }>;
  anti_snipe_seconds: number;
  auto_bid_max: number | null;
}

export async function getDealerLotDetail(
  dealer_id: string,
  lot_id: string,
): Promise<DealerLotDetail | null> {
  // [FIX] This used to build the card by calling
  // `listDealerLots({ status: "all", pageSize: 60 })` and `.find()`-ing the id.
  // Two things were wrong with that. `pageSize` is clamped to 60 in
  // `listDealerLots`, so a dealer in the audience of more than sixty lots got a
  // spurious 404 for the sixty-first — and it was page ONE only, ordered by
  // soonest-ending, so which lots were unreachable changed by the minute.
  // Second, `status: "all"` there means `IN ('live','ended')`, so a paused or
  // cancelled lot 404'd for a dealer who was legitimately in its audience and
  // may well have money standing on it.
  //
  // The audience check is the same `EXISTS` guard `getLotLiveState()` uses, and
  // it stays a 404 rather than a 403: a dealer outside the visibility rule
  // should not be able to learn that the lot exists at all.
  const card = await getDealerLotCard(dealer_id, lot_id);
  if (!card) return null;

  const itemRows = await db.execute(sql`
    SELECT i.condition, rb.serial, rb.capacity, rb.model, rb.image_urls,
           (SELECT (e.step1 ->> 'soh_percent')::numeric
              FROM nbfc_battery_evaluations e
              JOIN nbfc_recovery_pipeline p ON p.id = e.recovery_pipeline_id
             WHERE p.battery_id = rb.id
             ORDER BY e.created_at DESC LIMIT 1) AS soh
      FROM auction_lot_items i
      LEFT JOIN recovery_batteries rb ON rb.id = i.battery_id
     WHERE i.lot_id = ${lot_id}
     ORDER BY rb.serial
  `);

  const bidRows = await db.execute(sql`
    SELECT amount, placed_at,
           (bidder_dealer_id = ${dealer_id}) AS is_yours
      FROM auction_bids
     WHERE lot_id = ${lot_id}
     ORDER BY amount DESC, placed_at ASC
     LIMIT 50
  `);

  const [meta] = (await db.execute(sql`
    SELECT l.anti_snipe_seconds,
           (SELECT max_amount FROM auction_auto_bids
             WHERE lot_id = l.id AND bidder_dealer_id = ${dealer_id}
               AND status = 'active' LIMIT 1) AS auto_bid_max
      FROM auction_lots l WHERE l.id = ${lot_id}
  `)) as unknown as Array<Record<string, unknown>>;

  return {
    ...card,
    anti_snipe_seconds: Number(meta?.anti_snipe_seconds ?? 120),
    auto_bid_max: meta?.auto_bid_max == null ? null : Number(meta.auto_bid_max),
    items: (itemRows as unknown as Array<Record<string, unknown>>).map((r) => ({
      serial: String(r.serial ?? ""),
      condition: String(r.condition),
      capacity: r.capacity ? String(r.capacity) : null,
      model: r.model ? String(r.model) : null,
      soh: r.soh === null ? null : Number(r.soh),
      image_urls: (r.image_urls as string[] | null) ?? [],
    })),
    bid_history: (bidRows as unknown as Array<Record<string, unknown>>).map((r) => ({
      amount: Number(r.amount),
      placed_at: new Date(String(r.placed_at)).toISOString(),
      is_yours: r.is_yours === true,
    })),
  };
}

/** The 2-second poll payload. Deliberately tiny, and identity-free. */
export async function getLotLiveState(
  dealer_id: string,
  lot_id: string,
): Promise<{
  status: string;
  current_bid: number;
  bid_count: number;
  ends_at: string;
  you_are_leading: boolean;
  min_next_bid: number;
} | null> {
  const [row] = (await db.execute(sql`
    SELECT l.status, l.ends_at, l.base_price, l.bid_increment,
           COALESCE(MAX(b.amount), 0) AS current_bid,
           COUNT(b.id)::int AS bid_count,
           (SELECT bidder_dealer_id FROM auction_bids
             WHERE lot_id = l.id ORDER BY amount DESC, placed_at ASC LIMIT 1)
             = ${dealer_id} AS you_are_leading
      FROM auction_lots l
      LEFT JOIN auction_bids b ON b.lot_id = l.id
     WHERE l.id = ${lot_id}
       AND EXISTS (SELECT 1 FROM auction_lot_audience
                    WHERE lot_id = l.id AND dealer_id = ${dealer_id})
     GROUP BY l.id
  `)) as unknown as Array<Record<string, unknown>>;

  if (!row) return null;

  const current = Number(row.current_bid);
  const base = Number(row.base_price);
  const increment = Number(row.bid_increment);

  return {
    status: String(row.status),
    current_bid: current,
    bid_count: Number(row.bid_count),
    ends_at: new Date(String(row.ends_at)).toISOString(),
    you_are_leading: row.you_are_leading === true,
    // Sent so the bid form can pre-fill and validate without re-deriving a rule
    // that lives in placeBid(). Two copies of "what is the minimum" is how they
    // drift apart.
    min_next_bid: current === 0 ? base : current + increment,
  };
}

/** The dealer's own bid history across every lot. */
export async function listDealerBids(dealer_id: string) {
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (l.id)
           l.id AS lot_id, l.lot_code, l.title, l.status, l.ends_at,
           b.amount AS your_best,
           (SELECT MAX(amount) FROM auction_bids WHERE lot_id = l.id) AS current_bid,
           s.id IS NOT NULL AS settled,
           s.winner_dealer_id = ${dealer_id} AS you_won
      FROM auction_bids b
      JOIN auction_lots l ON l.id = b.lot_id
      LEFT JOIN auction_settlements s ON s.lot_id = l.id
     WHERE b.bidder_dealer_id = ${dealer_id}
     ORDER BY l.id, b.amount DESC
  `);

  return (rows as unknown as Array<Record<string, unknown>>)
    .map((r) => {
      const yourBest = Number(r.your_best);
      const current = Number(r.current_bid);
      const ended = String(r.status) === "ended";
      return {
        lot_id: String(r.lot_id),
        lot_code: String(r.lot_code),
        title: r.title ? String(r.title) : null,
        status: String(r.status),
        ends_at: new Date(String(r.ends_at)).toISOString(),
        your_best: yourBest,
        current_bid: current,
        // Four states a bidder actually cares about, resolved here so three
        // separate screens cannot disagree about what "lost" means.
        outcome: ended
          ? r.you_won === true
            ? ("won" as const)
            : ("lost" as const)
          : yourBest >= current
            ? ("leading" as const)
            : ("outbid" as const),
      };
    })
    .sort((a, b) => b.ends_at.localeCompare(a.ends_at));
}

/**
 * Audience-membership gate for the bid route.
 *
 * Throws NOT_FOUND rather than FORBIDDEN on purpose: a dealer outside the
 * visibility rule should not be able to learn that a lot exists, and a 403
 * confirms it does.
 */
export async function assertDealerMayBid(
  dealer_id: string,
  lot_id: string,
): Promise<void> {
  const [row] = await db
    .select({ id: auctionLotAudience.id })
    .from(auctionLotAudience)
    .where(
      and(
        eq(auctionLotAudience.lot_id, lot_id),
        eq(auctionLotAudience.dealer_id, dealer_id),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error("NOT_FOUND: this lot is not available to your account");
  }
}
