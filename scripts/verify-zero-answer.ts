// AI dialer list item 5 — read-only replay of the zero-answer alert against a
// real database. Writes nothing; safe on prod.
//
//   node --import tsx --env-file=.env.local scripts/verify-zero-answer.ts [--days=7] [--min=20]
//
// For each of the last N IST days, which campaigns WOULD have been alerted
// (>= min outbound dials, no person answering), using the same rule as the
// tick (zeroAnswerCampaigns). Needs E-373 (ai_dial_dispositions).

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { hasDialDispositionTables } from "@/lib/ai/storage/dialDisposition";
import { getDialerAlertSettings } from "@/lib/ai-dialer/dialerAlerts";
import { zeroAnswerCampaigns, zeroAnswerMinDials, type CampaignDial } from "@/lib/ai-dialer/zeroAnswer";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const days = Number(arg("days") ?? 7);

function rowsOf<T>(r: unknown): T[] {
    return Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []);
}

async function main() {
    if (!(await hasDialDispositionTables())) {
        console.log("E-373 (ai_dial_dispositions) missing: the alert never runs here.");
        process.exit(0);
    }
    const min = arg("min") ? zeroAnswerMinDials(arg("min")) : (await getDialerAlertSettings()).zeroAnswerMinDials;
    const rows = rowsOf<{ day: string; campaign_id: string; name: string | null; l1: string; l2: string; rule_no: string }>(
        await db.execute(sql`
            SELECT (d.dialled_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
                   d.campaign_id, c.name, d.l1, d.l2, d.rule_no
              FROM ai_dial_dispositions d
              LEFT JOIN dialer_campaigns c ON c.id = d.campaign_id
             WHERE d.direction = 'outbound' AND d.campaign_id IS NOT NULL
               AND d.dialled_at >= now() - make_interval(days => ${days})
        `),
    );
    const names = new Map(rows.map((r) => [r.campaign_id, r.name ?? r.campaign_id]));
    const byDay = new Map<string, CampaignDial[]>();
    for (const r of rows) {
        const list = byDay.get(r.day) ?? [];
        list.push({ campaignId: r.campaign_id, l1: r.l1, l2: r.l2, rule: r.rule_no });
        byDay.set(r.day, list);
    }
    console.log(`Threshold: ${min} dials with nobody answering.\n`);
    let total = 0;
    for (const day of [...byDay.keys()].sort().reverse()) {
        const dials = byDay.get(day)!;
        const hits = zeroAnswerCampaigns(dials, min);
        total += hits.length;
        const campaigns = new Set(dials.map((d) => d.campaignId)).size;
        console.log(`${day}  ${dials.length} dials on ${campaigns} campaigns → ${hits.length} alert(s)`);
        for (const h of hits) console.log(`    ${names.get(h.campaignId)}: ${h.dials} dials, 0 people`);
    }
    console.log(`\n${total} alert(s) would have gone out in ${days} days.`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
