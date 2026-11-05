// ID 222 — "Waiting for a field visit": the booked visit on each row, and the
// No visit booked / Visit booked filter. Pure, so the list page, its CSV and
// the My day email word it the same way and the tests can load it.
//
// Decided 3 Nov (Kartik): a booked visit does NOT take the lead off the list or
// out of "past the limit" — a booking is not a visit — the row just shows it.
// "Booked" = the same rule as Leads' "Next visit date": the earliest visit from
// today (IST) that is not visited, cancelled or no-show.

export type VisitBookedFilter = "none" | "booked" | "all";

export const VISIT_BOOKED_OPTIONS: Array<{ value: VisitBookedFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "none", label: "No visit booked" },
    { value: "booked", label: "Visit booked" },
];

export function parseVisitBooked(v: string | null | undefined): VisitBookedFilter {
    return v === "none" || v === "booked" ? v : "all";
}

/** The row's reason line, with the booked visit when there is one. */
export function fieldVisitDetail(r: { transferredOn: string; days: number; lim: number; booked: string | null }): string {
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const past = r.days > r.lim;
    return (
        `Transferred ${r.transferredOn} · ${plural(r.days, "working day")}, no visit · ` +
        `${past ? "past" : "within"} the limit (${plural(r.lim, "working day")})` +
        (r.booked ? ` · visit booked for ${r.booked}` : "")
    );
}

/** Keep the rows the filter asks for. */
export function filterVisitBooked<T extends { visit_booked?: string | null }>(rows: T[], f: VisitBookedFilter): T[] {
    if (f === "none") return rows.filter((r) => !r.visit_booked);
    if (f === "booked") return rows.filter((r) => !!r.visit_booked);
    return rows;
}
