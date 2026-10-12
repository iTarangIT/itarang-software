// ID 121 — the hand-back rule end to end against a real database, through the
// real writers (logLeadTouchpoint for the ASM's follow-up, reassignFromEscalation
// for the escalation Reassign). Everything runs in ONE transaction that is
// ROLLED BACK at the end: nothing is left behind.
//
//   DATABASE_URL=<sandbox> node --import tsx --env-file=.env.local scripts/_verify-id121-handback.ts
//
// Exits 1 if any check fails.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { handBackRefusal } from "@/lib/leads/asmHandBack";
import { reassignFromEscalation } from "@/lib/leads/escalationReassign";
import { logLeadTouchpoint } from "@/lib/inside-sales/logTouchpoint";

class Rollback extends Error {}
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  →  ${JSON.stringify(detail)}`}`);
}

async function main() {
    console.log("HOST:", new URL(process.env.DATABASE_URL!).hostname, "\n");

    await db
        .transaction(async (tx) => {
            const one = async <T>(q: ReturnType<typeof sql>) =>
                ((await tx.execute(q)) as unknown as T[])[0];

            const asm = await one<{ id: string; name: string | null }>(sql`
                SELECT id::text AS id, name FROM users WHERE role = 'asm' AND is_active IS NOT FALSE ORDER BY created_at LIMIT 1`);
            const isr = await one<{ id: string; name: string | null }>(sql`
                SELECT id::text AS id, name FROM users WHERE role = 'inside_sales_rep' AND is_active IS NOT FALSE ORDER BY created_at LIMIT 1`);
            const admin = await one<{ id: string }>(sql`
                SELECT id::text AS id FROM users WHERE role IN ('admin', 'sales_head') AND is_active IS NOT FALSE ORDER BY created_at LIMIT 1`);
            const lead = await one<{ id: string }>(sql`
                SELECT id FROM dealer_leads WHERE lead_status = 'Under_Discussion' ORDER BY updated_at DESC LIMIT 1`);
            if (!asm || !isr || !admin || !lead) throw new Error(`fixtures missing: ${JSON.stringify({ asm, isr, admin, lead })}`);
            console.log(`lead ${lead.id} · ASM ${asm.name} · ISR ${isr.name}\n`);
            const L = lead.id;

            // A lead Awaiting field visit with this ASM; no visits, no follow-up.
            await tx.execute(sql`
                UPDATE dealer_leads
                   SET lead_status = 'Transferred_to_ASM', pre_transfer_status = 'Under_Discussion',
                       asm_id = ${asm.id}, current_owner_id = ${asm.id}, next_follow_up_at = NULL
                 WHERE id = ${L}`);
            await tx.execute(sql`
                UPDATE lead_visits SET visit_status = 'cancelled'
                 WHERE dealer_lead_id = ${L} AND visit_status IN ('scheduled', 'pending_scheduling')`);
            const tomorrow = (await one<{ t: string }>(sql`SELECT ((CURRENT_DATE + 1)::timestamp + interval '11 hours')::timestamptz AS t`))!.t;
            const tomorrowIso = new Date(tomorrow).toISOString();

            // 1. Booked visit → refused.
            await tx.execute(sql`
                INSERT INTO lead_visits (dealer_lead_id, asm_id, scheduled_date, visit_status)
                VALUES (${L}, ${asm.id}, CURRENT_DATE + 1, 'scheduled')`);
            const r1 = await handBackRefusal(tx, L);
            check("booked visit blocks the hand-back", !!r1 && /has a visit booked for/.test(r1), r1);
            await tx.execute(sql`UPDATE lead_visits SET visit_status = 'cancelled' WHERE dealer_lead_id = ${L} AND visit_status = 'scheduled'`);
            check("visit cancelled → nothing blocks", (await handBackRefusal(tx, L)) === null);

            // 2. The ASM sets a follow-up from the log form (real writer) → refused.
            await logLeadTouchpoint(
                { leadId: L, actorId: asm.id, body: { touchpoint_type: "status_change_note", remarks: "ID 121 verify: ASM follow-up", follow_up_at: tomorrowIso } as never },
                { tx },
            );
            const tp = await one<{ next_action_at: string | null }>(sql`
                SELECT next_action_at FROM lead_touchpoints WHERE dealer_lead_id = ${L} ORDER BY performed_at DESC LIMIT 1`);
            check("the form's follow-up is recorded on the touchpoint", !!tp?.next_action_at && new Date(tp.next_action_at).toISOString() === tomorrowIso, tp);
            const r2 = await handBackRefusal(tx, L);
            check("ASM follow-up blocks the hand-back", !!r2 && /has a follow-up set for/.test(r2), r2);

            // 2b. …and through the escalation Reassign: 409, nothing written.
            const before = await one<{ current_owner_id: string }>(sql`SELECT current_owner_id FROM dealer_leads WHERE id = ${L}`);
            const err = await reassignFromEscalation(tx, { leadId: L, actorId: admin.id, targetUserId: isr.id, notes: "ID 121 verify — refused" }).catch((e) => e);
            check("escalation Reassign is refused with 409", err?.status === 409 && /follow-up set for/.test(err?.message), err?.message);
            const after = await one<{ current_owner_id: string }>(sql`SELECT current_owner_id FROM dealer_leads WHERE id = ${L}`);
            check("refused Reassign changed nothing", after?.current_owner_id === before?.current_owner_id);

            // 3. The ASM clears it ("Clear the follow-up" sends follow_up_at: null) → allowed.
            await logLeadTouchpoint(
                { leadId: L, actorId: asm.id, body: { touchpoint_type: "status_change_note", remarks: "ID 121 verify: clear", follow_up_at: null } as never },
                { tx },
            );
            check("cleared follow-up → nothing blocks", (await handBackRefusal(tx, L)) === null);

            // 4. A follow-up the ISR set (not the ASM) does not block.
            await logLeadTouchpoint(
                { leadId: L, actorId: isr.id, body: { touchpoint_type: "status_change_note", remarks: "ID 121 verify: ISR follow-up", follow_up_at: tomorrowIso } as never },
                { tx },
            );
            check("an ISR's follow-up does not block", (await handBackRefusal(tx, L)) === null);

            // 5. An ASM follow-up already in the past does not block.
            await tx.execute(sql`UPDATE dealer_leads SET next_follow_up_at = now() - interval '2 days' WHERE id = ${L}`);
            await tx.execute(sql`
                UPDATE lead_touchpoints SET next_action_at = (SELECT next_follow_up_at FROM dealer_leads WHERE id = ${L}), performed_by = ${asm.id}
                 WHERE touchpoint_id = (SELECT touchpoint_id FROM lead_touchpoints WHERE dealer_lead_id = ${L} ORDER BY performed_at DESC LIMIT 1)`);
            check("a past ASM follow-up does not block", (await handBackRefusal(tx, L)) === null);

            // 6. Escalation Reassign with nothing booked: full hand-back.
            await tx.execute(sql`
                INSERT INTO lead_visits (dealer_lead_id, asm_id, visit_status) VALUES (${L}, ${asm.id}, 'pending_scheduling')`);
            const out = await reassignFromEscalation(tx, { leadId: L, actorId: admin.id, targetUserId: isr.id, notes: "ID 121 verify — hand back" });
            check("hand-back reported", out.handedBack && out.closedVisits === 1, out);
            const dl = await one<Record<string, string | null>>(sql`
                SELECT current_owner_id, asm_id, lead_status, pre_transfer_status FROM dealer_leads WHERE id = ${L}`);
            check("owner is the ISR", dl?.current_owner_id === isr.id, dl);
            check("ASM unlinked", dl?.asm_id === null, dl);
            check("back to the pre-transfer stage", dl?.lead_status === "Under_Discussion", dl);
            check("pre_transfer_status cleared", dl?.pre_transfer_status === null, dl);
            const open = await one<{ n: number }>(sql`
                SELECT count(*)::int AS n FROM lead_visits WHERE dealer_lead_id = ${L} AND visit_status IN ('scheduled', 'pending_scheduling')`);
            check("open visits closed", open?.n === 0, open);
            const esc = await one<{ to_owner_id: string | null; from_owner_id: string | null }>(sql`
                SELECT to_owner_id, from_owner_id FROM lead_touchpoints
                 WHERE dealer_lead_id = ${L} AND touchpoint_type = 'escalation_resolved_reassign'
                 ORDER BY performed_at DESC LIMIT 1`);
            check("escalation_resolved_reassign touchpoint records the hop", esc?.to_owner_id === isr.id && esc?.from_owner_id === asm.id, esc);

            throw new Rollback();
        })
        .catch((e) => {
            if (!(e instanceof Rollback)) throw e;
        });

    console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`} — transaction rolled back, nothing kept.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
