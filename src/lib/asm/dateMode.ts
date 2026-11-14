// ID 236: what the My visits date range means. Client-safe (the filter bar and the
// param reader use it; lib/asm/queryBuilder.ts builds the SQL).

/** "booked" = a visit scheduled in the range and still open (the default); "visited" = done in the range. */
export const DATE_MODES = ["booked", "visited"] as const;
export type DateMode = (typeof DATE_MODES)[number];
