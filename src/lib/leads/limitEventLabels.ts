/**
 * Words for the clocks and their "Limit passed" records (IDs 85 / 86) — one
 * place for the lead timeline, the daily email and the queues. Pure and
 * client-safe.
 */
import { formatLimit, type LimitUnit } from "@/lib/timeLimits/registry";

/** What each clock waits for. */
export const CLOCK_GOAL: Record<string, string> = {
    lead: "first call or visit",
    owner: "owner's first call or visit",
    transfer: "first field visit",
    hot_assign: "Hot lead getting an owner",
    hot_owner: "Hot lead first call or visit",
    retry: "retry after an unanswered call",
    quote: "CEO quote approval",
    ready_assign: "sales-ready lead getting an owner",
    quote_deliver: "approved quote sent to the dealer",
    quote_revise: "declined quote revised or lead marked Lost",
};

/** Short names of the clocks, for chips and tables. */
export const CLOCK_SHORT: Record<string, string> = {
    lead: "First attempt",
    owner: "Owner's first attempt",
    transfer: "Field visit",
    hot_assign: "Hot: no owner",
    hot_owner: "Hot: owner's attempt",
    retry: "Retry",
    quote: "CEO approval",
    ready_assign: "No owner",
    quote_deliver: "Quote not sent",
    quote_revise: "Declined quote",
};

const UNITS: readonly string[] = ["working_hours", "working_days", "working_day_close", "days", "count"];
const unitOf = (u: string) => (UNITS.includes(u) ? u : "working_hours") as LimitUnit;

/** "Field visit (3 working days)" — names the limit a lead is past (queue chip, 18 Oct row 34). */
export function limitChipLabel(e: { clock: string; limit_value: number; limit_unit?: string | null }): string {
    const unit = unitOf(e.limit_unit ?? "working_hours");
    return `${CLOCK_SHORT[e.clock] ?? e.clock} (${formatLimit(Math.round(Number(e.limit_value)), unit)})`;
}

export type LimitEventLike = {
    clock: string;
    limit_value: number;
    limit_unit: string;
    owner_name: string | null;
    owner_inferred: boolean;
};

/** "Limit passed — first field visit within 3 working days". */
export function limitEventTitle(e: Pick<LimitEventLike, "clock" | "limit_value" | "limit_unit">): string {
    const unit = unitOf(e.limit_unit);
    const limit = formatLimit(Math.round(Number(e.limit_value)), unit);
    return `Limit passed — ${CLOCK_GOAL[e.clock] ?? e.clock} ${unit === "working_day_close" ? `by ${limit}` : `within ${limit}`}`;
}

/** "Charged to Asha" / "Owner not on record (before 10 Sep) — not in per-person counts". */
export function limitEventOwnerLine(e: Pick<LimitEventLike, "owner_name" | "owner_inferred">): string {
    if (e.owner_inferred) return `${e.owner_name ? `${e.owner_name} · ` : ""}owner not on record — not in per-person counts`;
    return e.owner_name ? `Charged to ${e.owner_name}` : "Charged to the team (no owner)";
}
