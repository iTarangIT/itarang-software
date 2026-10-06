// The onboarding clock — when a dealer or iTarang last ACTED on an onboarding
// application (tracker ID 122). "Stalled" (7 days / 2 working days) and the
// 21-day drop-out review both count from it.
//
// It used to be wrong in both directions:
//   - `last_action_at` was written once, when an application was created from
//     a converted lead, and never again — those dealers showed stalled at day
//     7 and reached drop-out at day 21 however active they were;
//   - every other application fell back to `updated_at`, which the 15-minute
//     agreement sweep rewrote on each check — a dealer waiting to sign never
//     aged at all.
//
// E-327 fixes the column rather than the readers: a trigger on
// dealer_onboarding_applications keeps `last_action_at` at the last write that
// changed something a person changes (submit, save, review, correction,
// agreement sent / signed, approval), and ignores bookkeeping (the sweep's
// refresh, cached PDF links, provider payloads). Uploads and a submitted
// correction round stamp it too. The sweep has its own
// `agreement_last_checked_at`. E-328 recomputes the column for existing rows.
//
// So the expression below is unchanged — on a database without E-327 it
// behaves exactly as before — but there is now ONE copy of it. It was inlined
// in four files.
//
// No db import: plain strings, safe to use from any query builder.

/** SQL for the clock, for an application row aliased `alias` (default `oa`). */
export function onboardingClockSql(alias = "oa"): string {
    if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`bad SQL alias: ${alias}`);
    return `COALESCE(${alias}.last_action_at, ${alias}.updated_at)`;
}
