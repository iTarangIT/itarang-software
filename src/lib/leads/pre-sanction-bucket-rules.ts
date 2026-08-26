/**
 * Pure rules for the Step-4 pre-sanction bucket — no database, no I/O — so
 * they can be unit-tested (this repo's vitest scope) and reused by both
 * writers. See ./pre-sanction-bucket.ts for the DB half.
 */

/** Section-G cap, mirrored by productSelectionSchema's `.max(10)`. */
export const PRE_SANCTION_MAX = 10;

export interface BucketItem {
  url: string;
  name: string;
  type: string;
  size: number;
}

/** Keep only well-formed items; the same coercion the PATCH route applied. */
export function coerceBucketItems(raw: unknown): BucketItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
    .map((it) => ({
      url: String(it.url ?? ""),
      name: String(it.name ?? "file"),
      type: String(it.type ?? "application/octet-stream"),
      size: Number(it.size ?? 0) || 0,
    }))
    .filter((it) => it.url);
}

/**
 * Pure merge: `existing` + `incoming`, deduped by url, capped at the limit.
 * Returns what fits and how many incoming items were dropped for the cap.
 */
export function mergeBucketItems(
  existing: BucketItem[],
  incoming: BucketItem[],
  max = PRE_SANCTION_MAX,
): { items: BucketItem[]; dropped: number } {
  const seen = new Set(existing.map((i) => i.url));
  const items = existing.slice(0, max);
  let dropped = 0;
  for (const it of incoming) {
    if (!it.url || seen.has(it.url)) continue;
    if (items.length >= max) {
      dropped += 1;
      continue;
    }
    seen.add(it.url);
    items.push(it);
  }
  return { items, dropped };
}
