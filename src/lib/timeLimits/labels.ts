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

/** "No touch > 5 working days" from stale_yellow. */
export function noTouchLabel(l: Pick<TimeLimits, "stale_yellow">): string {
    return `No touch > ${days(Math.floor(l.stale_yellow))}`;
}
