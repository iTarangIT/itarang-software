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
};

export type LimitEventLike = {
    clock: string;
    limit_value: number;
    limit_unit: string;
    owner_name: string | null;
    owner_inferred: boolean;
};

/** "Limit passed — first field visit within 3 working days". */
export function limitEventTitle(e: Pick<LimitEventLike, "clock" | "limit_value" | "limit_unit">): string {
    const unit = (["working_hours", "working_days", "days", "count"].includes(e.limit_unit) ? e.limit_unit : "working_hours") as LimitUnit;
    return `Limit passed — ${CLOCK_GOAL[e.clock] ?? e.clock} within ${formatLimit(Math.round(Number(e.limit_value)), unit)}`;
}

/** "Charged to Asha" / "Owner not on record (before 10 Sep) — not in per-person counts". */
export function limitEventOwnerLine(e: Pick<LimitEventLike, "owner_name" | "owner_inferred">): string {
    if (e.owner_inferred) return `${e.owner_name ? `${e.owner_name} · ` : ""}owner not on record — not in per-person counts`;
    return e.owner_name ? `Charged to ${e.owner_name}` : "Charged to the team (no owner)";
}
