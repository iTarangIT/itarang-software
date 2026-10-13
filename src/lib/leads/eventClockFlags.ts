// ID 35 — the lead clock / owner clock columns on the Lead events download.
//
// eventLog.ts joins each event to the clocks (lead_clocks, E-337) that were
// running when it happened: the lead's clock (started on or before the event)
// and the owner clock whose window holds it (started on or before, not yet
// ended). The SQL hands back IST wall-clock text, and the "limit passed" time
// only when the limit had passed BY the event — so a flag reads as of the
// event, not as of today. These turn those values into the cells.
//
// Pure: no DB. Tested in __tests__/eventClockFlags.test.ts.

/** "2026-10-01 14:05:09.123" → "2026-10-01 14:05" (minutes are enough in a cell). */
export function istMinute(text: string | null | undefined): string | null {
    if (!text) return null;
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(text));
    return m ? `${m[1]} ${m[2]}` : String(text);
}

/**
 * "Limit passed" cell for one clock as of the event:
 *   no clock running at the event   → null (blank)
 *   clock running, limit not passed → "No"
 *   limit passed on or before it    → "Yes, 2026-10-01 14:05"
 */
export function limitPassedLabel(
    clockStartedAt: string | null | undefined,
    passedByEventAt: string | null | undefined,
): string | null {
    if (!clockStartedAt) return null;
    if (!passedByEventAt) return "No";
    return `Yes, ${istMinute(passedByEventAt)}`;
}

/** "Owner inferred" cell: blank with no owner clock, else Yes / No (ID 86 back-fill flag). */
export function ownerInferredLabel(
    ownerClockStartedAt: string | null | undefined,
    inferred: boolean | string | null | undefined,
): string | null {
    if (!ownerClockStartedAt) return null;
    return inferred === true || inferred === "t" || inferred === "true" ? "Yes" : "No";
}
