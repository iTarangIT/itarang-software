/**
 * E-232 — who may bid, and who may never (Battery Auction BRD §9).
 *
 * DEPENDENCY-FREE ON PURPOSE. This module is imported by middleware and by the
 * audience resolver, and `src/middleware.ts` runs on the Edge runtime where
 * `@/lib/db` cannot load. Same treatment, same reason, as
 * `src/lib/buyback/roles.ts`. Do not import anything here.
 *
 * THE RULE
 *   A lot is visible to, and biddable by, DEALERS ONLY. Other NBFCs must never
 *   see a competitor's recovered stock, let alone bid on it.
 *
 *   The exclusion is by ROLE, not by geography. That distinction is the whole
 *   point: a city- or radius-scoped lot would otherwise leak to an NBFC user
 *   who happens to sit inside the circle, and the leak would be invisible
 *   because the lot would look correctly targeted. Geography narrows an
 *   already-dealer audience; it never grants entry to one.
 */

/** Roles that may place a bid. */
export const AUCTION_BIDDER_ROLES = ["dealer"] as const;

/**
 * Roles that may *see* a lot in a bidding surface. Admin and CEO are included
 * for oversight — they can watch an auction, and `assertMayBid` still stops
 * them placing a bid, so oversight never becomes participation.
 */
export const AUCTION_VIEWER_ROLES = [
  "dealer",
  "admin",
  "ceo",
  "driver",
] as const;

/**
 * Roles that are structurally barred from the bidding side of an auction, no
 * matter what geography or audience row says.
 */
export const AUCTION_EXCLUDED_ROLES = ["nbfc_partner"] as const;

function normalise(role: string | null | undefined): string {
  // users.role is free-text varchar with no enum and inconsistent casing in
  // seeded rows — the same reason emit.ts matches on LOWER(users.role).
  return String(role ?? "").trim().toLowerCase();
}

export function isAuctionBidderRole(role: string | null | undefined): boolean {
  return (AUCTION_BIDDER_ROLES as readonly string[]).includes(normalise(role));
}

export function isAuctionViewerRole(role: string | null | undefined): boolean {
  return (AUCTION_VIEWER_ROLES as readonly string[]).includes(normalise(role));
}

export function isAuctionExcludedRole(role: string | null | undefined): boolean {
  return (AUCTION_EXCLUDED_ROLES as readonly string[]).includes(normalise(role));
}

/**
 * Throws the `FORBIDDEN:`-prefixed error every NBFC route's `statusFromError`
 * maps to 403.
 *
 * The NBFC-specific message is separate from the generic one deliberately: an
 * NBFC user hitting the bid route is not a permissions misconfiguration to be
 * granted later, it is a rule of the marketplace, and the message should say so
 * rather than read like something an admin can fix.
 */
export function assertMayBid(role: string | null | undefined): void {
  if (isAuctionExcludedRole(role)) {
    throw new Error(
      "FORBIDDEN: NBFC users cannot bid on auction lots — dealers only (BRD §9)",
    );
  }
  if (!isAuctionBidderRole(role)) {
    throw new Error("FORBIDDEN: only dealer accounts may place auction bids");
  }
}
