// Read-only check of the NeoDove call history (26 Nov: ID 242 follow-up).
//   node --import tsx --env-file=.env.local scripts/verify-neodove-call-history.ts [sampleLeads=25]
//
// 1. Every inbound NeoDove message in the ledger, re-parsed: how many carry a
//    status code with no name, how many of those the code table now names,
//    any code the table does not know, and how many follow-up dates parse.
// 2. Calls never reaching the CRM: inbound call messages with no call record.
// 3. For a sample of leads with NeoDove calls: the Calls tab lists exactly the
//    lead's call records, newest first, at the stored call time, and no NeoDove
//    row shows a bare "status code N".
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { parseInboundEvent } from "@/lib/neodove/mapper";
import { NEODOVE_STATUS_CODE_NAMES } from "@/lib/neodove/statusCodes";
import { loadLeadCalls } from "@/lib/leads/leadCallHistory";

let fails = 0;
const check = (ok: boolean, msg: string) => {
    console.log(`${ok ? "  ✓" : "  ✗"} ${msg}`);
    if (!ok) fails++;
};

async function main() {
    const sample = Number(process.argv[2] ?? 25);

    console.log("\n── 1. Every inbound NeoDove message, re-parsed");
    const evs = (await db.execute(sql`
        SELECT request_payload AS p, event_type FROM neodove_sync_events
         WHERE direction = 'inbound' AND jsonb_typeof(request_payload) = 'object'
           AND NOT (request_payload ? 'body' AND request_payload - 'body' = '{}'::jsonb)
    `)) as unknown as Array<{ p: unknown; event_type: string }>;
    let codeOnly = 0, codeOnlyNamed = 0, withFollowUpField = 0, followUpParsed = 0;
    const unknownCodes = new Map<string, number>();
    for (const r of evs) {
        const e = parseInboundEvent(r.p);
        const raw = r.p as Record<string, unknown>;
        if (e.dispositionCode && !e.disposition) {
            codeOnly++;
            if (e.statusName) codeOnlyNamed++;
        }
        if (e.dispositionCode && /^-?\d+$/.test(e.dispositionCode) && !(e.dispositionCode in NEODOVE_STATUS_CODE_NAMES)) unknownCodes.set(e.dispositionCode, (unknownCodes.get(e.dispositionCode) ?? 0) + 1);
        const fu = raw.follow_up_date ?? raw.follow_up_date_time;
        if (fu != null && String(fu).trim() !== "" && String(fu) !== "0") {
            withFollowUpField++;
            if (e.followUpAt) followUpParsed++;
        }
    }
    console.log(`  ${evs.length} messages · ${codeOnly} came with a code and no name · ${withFollowUpField} carry a follow-up date`);
    check(codeOnly === codeOnlyNamed, `every code-only message now has a status name (${codeOnlyNamed} of ${codeOnly})`);
    check(unknownCodes.size === 0, `no code outside the table${unknownCodes.size ? `: ${[...unknownCodes].map(([c, n]) => `${c}×${n}`).join(", ")}` : ""}`);
    check(withFollowUpField === followUpParsed, `every follow-up date parses (${followUpParsed} of ${withFollowUpField})`);

    console.log("\n── 2. Calls that never reached the CRM");
    const gap = (await db.execute(sql`
        SELECT count(*)::int AS calls,
               count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM lead_touchpoints t WHERE t.external_system = 'neodove' AND t.external_event_id = ev.external_event_id))::int AS missing,
               count(*) FILTER (WHERE ev.error IS NOT NULL)::int AS with_error,
               -- Before the 4 Aug phone-matching fix (resolveInboundLead): history, not a current gap.
               count(*) FILTER (WHERE ev.error IS NULL AND ev.created_at < '2026-08-05'
                                  AND NOT EXISTS (SELECT 1 FROM lead_touchpoints t WHERE t.external_system = 'neodove' AND t.external_event_id = ev.external_event_id))::int AS before_fix
          FROM neodove_sync_events ev
         WHERE ev.direction = 'inbound' AND ev.event_type IN ('lead_disposed', 'call_connected', 'call_not_connected')
    `)) as unknown as Array<{ calls: number; missing: number; with_error: number; before_fix: number }>;
    const g = gap[0];
    console.log(`  ${g.calls} call messages · ${g.missing} with no CRM call record: ${g.with_error} logged an error (no phone number to match), ${g.before_fix} from before the 4 Aug matching fix`);
    check(g.missing === g.with_error + g.before_fix, "every call message since the 4 Aug fix has a CRM call record, unless NeoDove sent no phone number (logged on Sync Activity)");

    console.log(`\n── 3. Calls tab, ${sample} leads with NeoDove calls`);
    const leads = (await db.execute(sql`
        SELECT dealer_lead_id AS id, count(*)::int AS n FROM lead_touchpoints
         WHERE external_system = 'neodove' AND touchpoint_type = 'inside_sales_call'
         GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT ${sample}
    `)) as unknown as Array<{ id: string; n: number }>;
    let bad = 0, rows = 0, named = 0, neoRows = 0, follow = 0;
    for (const l of leads) {
        const { calls } = await loadLeadCalls(l.id);
        const tps = (await db.execute(sql`
            SELECT touchpoint_id::text AS id, performed_at FROM lead_touchpoints
             WHERE dealer_lead_id = ${l.id} AND touchpoint_type = 'inside_sales_call'
             ORDER BY performed_at DESC NULLS LAST, touchpoint_id DESC LIMIT 300
        `)) as unknown as Array<{ id: string; performed_at: string | Date }>;
        const sameRows = tps.length === calls.length && tps.every((t, i) => t.id === calls[i].id && new Date(t.performed_at).toISOString() === calls[i].at);
        const rawCode = calls.some((c) => /status code \d/.test(`${c.status ?? ""} ${c.remarks ?? ""}`));
        if (!sameRows || rawCode) {
            bad++;
            console.log(`    ✗ ${l.id}: rows ${calls.length} vs ${tps.length}${rawCode ? " · a bare status code is shown" : ""}`);
        }
        rows += calls.length;
        for (const c of calls.filter((x) => x.source === "neodove")) {
            neoRows++;
            if (c.status) named++;
            if (c.follow_up_at) follow++;
        }
    }
    console.log(`  ${rows} calls on ${leads.length} leads · NeoDove ${neoRows}, of which ${named} with a status and ${follow} with a NeoDove follow-up date`);
    check(bad === 0, "each lead's Calls tab = its call records, newest first, at the stored call time, no bare code");
    const sampleLead = leads[0];
    if (sampleLead) {
        const { calls } = await loadLeadCalls(sampleLead.id);
        console.log(`\n  Example, lead ${sampleLead.id} (newest 3):`);
        for (const c of calls.slice(0, 3)) {
            console.log(`    ${c.at} · ${c.source} · ${c.by ?? "-"} · ${c.connected ? "connected" : "not connected"} · ${c.status ?? "-"} · stage ${c.stage ?? "-"} · outcome ${c.outcome ?? "-"} · follow-up ${c.follow_up_at ?? "-"}`);
        }
    }

    console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
    process.exit(fails ? 1 : 0);
}
void main();
