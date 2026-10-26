/**
 * Labels built from the time limits, so a screen or a mail never prints a
 * fixed number that an Admin can change (ID 85 Decision 6, 15 Oct). Pure and
 * client-safe: pass the values from getTimeLimits() (server) or the API.
 */
import type { TimeLimits } from "@/lib/timeLimits/registry";

const days = (n: number) => `${n} working day${n === 1 ? "" : "s"}`;

/** "ISR 5+, ASM 7+ working days" — the idle rule, per role (idle_cc / idle_asm). */
export function idleLimitLabel(l: Pick<TimeLimits, "idle_cc" | "idle_asm">): string {
    const cc = Math.floor(l.idle_cc);
    const asm = Math.floor(l.idle_asm);
    return cc === asm ? `${days(cc)} or more` : `ISR ${cc}+, ASM ${asm}+ working days`;
}

type StaleBand = "yellow" | "red" | "critical";

/**
 * "5 working days", or "ISR 5, ASM 7 working days" when the two sets differ
 * (ID 85 #5) — one no-touch warning's threshold for a label.
 */
export function staleBandLabel(
    l: Pick<TimeLimits, "stale_yellow" | "stale_red" | "stale_critical" | "stale_yellow_asm" | "stale_red_asm" | "stale_critical_asm">,
    band: StaleBand,
): string {
    const isr = Math.floor(band === "yellow" ? l.stale_yellow : band === "red" ? l.stale_red : l.stale_critical);
    const asm = Math.floor(band === "yellow" ? l.stale_yellow_asm : band === "red" ? l.stale_red_asm : l.stale_critical_asm);
    return isr === asm ? days(isr) : `ISR ${isr}, ASM ${asm} working days`;
}

/**
 * The critical band as a bare number for "Idle 14+ working days", or
 * "ISR 14 / ASM 20" when the two sets differ (ID 85 #5).
 */
export function staleCriticalShort(l: Pick<TimeLimits, "stale_critical"> & Partial<Pick<TimeLimits, "stale_critical_asm">>): string {
    const isr = Math.floor(l.stale_critical);
    const asm = Math.floor(l.stale_critical_asm ?? l.stale_critical);
    return isr === asm ? String(isr) : `ISR ${isr} / ASM ${asm}`;
}

/** "No touch > 5 working days" from stale_yellow (and stale_yellow_asm when it differs). */
export function noTouchLabel(l: Parameters<typeof staleBandLabel>[0]): string {
    return `No touch > ${staleBandLabel(l, "yellow")}`;
}
