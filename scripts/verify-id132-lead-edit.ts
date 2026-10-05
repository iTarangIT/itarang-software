// Read-only check for tracker ID 132 — "record every change to name or phone:
// who, when, old and new value; a phone change keeps the old number".
//
//   node --import tsx --env-file=.env.local scripts/verify-id132-lead-edit.ts
//
// The record is kept by the E-304 trigger on dealer_leads, not by the edit
// route, so the thing to verify on a database is that the trigger is there and
// covers name and phone. Changes nothing.

import postgres from "postgres";

async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    console.log("target:", new URL(url).host);
    const sql = postgres(url, { max: 1, ssl: "require" });
    let failed = 0;
    const say = (ok: boolean, label: string, detail = "") => {
        if (!ok) failed++;
        console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    };

    try {
        const [t] = await sql`SELECT to_regclass('public.dealer_lead_field_changes') IS NOT NULL AS ok`;
        say(t.ok, "dealer_lead_field_changes exists (E-304)");

        const triggers = await sql`
            SELECT tg.tgname, p.proname, pg_get_functiondef(p.oid) AS def
              FROM pg_trigger tg
              JOIN pg_class c ON c.oid = tg.tgrelid
              JOIN pg_proc p ON p.oid = tg.tgfoid
             WHERE c.relname = 'dealer_leads' AND NOT tg.tgisinternal AND tg.tgenabled <> 'D'`;
        const audit = triggers.find((r) => /dealer_lead_field_changes/.test(r.def));
        say(!!audit, "an enabled trigger on dealer_leads writes dealer_lead_field_changes", audit?.tgname ?? "none found");
        if (audit) {
            for (const col of ["dealer_name", "phone", "shop_name"]) {
                say(new RegExp(`'${col}'`).test(audit.def), `the trigger audits ${col}`);
            }
            say(/app\.actor_id/.test(audit.def), "the trigger records who made the change (app.actor_id)");
        }

        if (t.ok) {
            const [n] = await sql`
                SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE field = 'phone')::int AS phone,
                       count(*) FILTER (WHERE changed_by IS NULL)::int AS no_actor
                  FROM dealer_lead_field_changes`;
            console.log(`INFO  ${n.total} change(s) recorded; ${n.phone} of a phone number; ${n.no_actor} with no recorded user`);
        }
    } finally {
        await sql.end();
    }
    console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
    process.exit(failed ? 1 : 0);
}

main();
