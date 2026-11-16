// AI dialer list item 5 — the zero-answer alert, the pure half.
//
// A campaign that has dialled a fair number of leads today and not one person
// answered is almost always a line problem the carrier pause cannot see: the
// calls are placed (no SIP refusal) but ring into nothing — a flagged caller
// id, a dead route, an agent that hangs up before anyone speaks. The 19:20
// readout catches it only after the day is gone; this rule catches it while
// the campaign is still running. I/O: zeroAnswerCheck.ts.

import { isHumanDisposition } from "./dispositionV3";

/** Dials today before a campaign with no human answer raises the alert. */
export const ZERO_ANSWER_MIN_DIALS_DEFAULT = 20;
export const ZERO_ANSWER_MIN_DIALS_MIN = 5;
export const ZERO_ANSWER_MIN_DIALS_MAX = 500;

export type CampaignDial = { campaignId: string; l1: string; l2: string; rule: string };
export type ZeroAnswerHit = { campaignId: string; dials: number; humans: number };

/** Clamp a stored threshold; null / junk = the default. */
export function zeroAnswerMinDials(raw: unknown): number {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n <= 0) return ZERO_ANSWER_MIN_DIALS_DEFAULT;
    return Math.min(ZERO_ANSWER_MIN_DIALS_MAX, Math.max(ZERO_ANSWER_MIN_DIALS_MIN, n));
}

/** Campaigns with at least `minDials` outbound dials today and no human on any of them. */
export function zeroAnswerCampaigns(dials: ReadonlyArray<CampaignDial>, minDials: number): ZeroAnswerHit[] {
    const by = new Map<string, ZeroAnswerHit>();
    for (const d of dials) {
        const hit = by.get(d.campaignId) ?? { campaignId: d.campaignId, dials: 0, humans: 0 };
        hit.dials++;
        if (isHumanDisposition(d)) hit.humans++;
        by.set(d.campaignId, hit);
    }
    return [...by.values()].filter((h) => h.dials >= minDials && h.humans === 0);
}

/** A whole IST day (all campaigns) with dials but nobody answering — the readout flag. */
export function isZeroAnswerDay(row: { dials: number; humans: number }, minDials: number): boolean {
    return row.dials >= minDials && row.humans === 0;
}
