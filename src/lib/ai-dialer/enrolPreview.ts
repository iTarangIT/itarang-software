// ID 207 (28 Oct) — what the start screen says will be left out, before the
// campaign exists. The same rules createCampaign applies at enrolment
// (planEnrolment with the D7 switchboard / dead marks and the D8 open
// callbacks), read-only: nothing is recorded, nothing is skipped here.

import { leadsWithOpenCallback } from "./callbackLoop";
import { describeEnrolSkips, phoneKey, planEnrolment, type EnrolSkip } from "./numberHygiene";
import { observedNumbers } from "./phoneTypeStore";

export type EnrolSkipPreview = {
    total: number;
    byReason: Record<EnrolSkip, number>;
    /** "3 not a mobile, 1 vehicle showroom" — null when nothing would be skipped. */
    text: string | null;
};

export function noEnrolSkips(): Record<EnrolSkip, number> {
    return {
        no_phone: 0,
        not_mobile: 0,
        vehicle_showroom: 0,
        duplicate_number: 0,
        switchboard: 0,
        dead_number: 0,
        open_callback: 0,
    };
}

/** Rows in queue order, named as createCampaign names them ("shop | dealer"). */
export async function previewEnrolSkips(
    rows: Array<{ id: string; phone: string | null; shop_name: string | null; dealer_name: string | null }>,
): Promise<EnrolSkipPreview> {
    const byReason = noEnrolSkips();
    if (rows.length === 0) return { total: 0, byReason, text: null };
    const [observed, promised] = await Promise.all([
        observedNumbers(rows.map((r) => r.phone)),
        leadsWithOpenCallback(rows.map((r) => r.id)),
    ]);
    const plan = planEnrolment(
        rows.map((r) => ({
            id: r.id,
            phone: r.phone,
            name: [r.shop_name, r.dealer_name].filter(Boolean).join(" | ") || null,
            observed: observed.get(phoneKey(r.phone) ?? "") ?? null,
            openCallback: promised.has(r.id),
        })),
    );
    let total = 0;
    for (const d of plan) {
        if (d.skip === null) continue;
        byReason[d.skip]++;
        total++;
    }
    return { total, byReason, text: describeEnrolSkips(byReason) };
}
