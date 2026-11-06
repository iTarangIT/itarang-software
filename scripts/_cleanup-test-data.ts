// CRM wording audit, CEO pages rows 5 / 8 / 40 (Kartik, 2 Nov): test data out
// of the live counts.
//
//   node --import tsx --env-file=.env.local      scripts/_cleanup-test-data.ts            (dry run, sandbox)
//   node --import tsx --env-file=.env.local      scripts/_cleanup-test-data.ts --apply
//   node --import tsx --env-file=.env.production scripts/_cleanup-test-data.ts            (prod: read the plan first)
//
// --skip=users keeps the test logins (sandbox: testers use them).
//
//   row 5  — users named "ASM Test" / "ISR Test": users.is_active = false and a
//            Supabase Auth ban (an open session cannot refresh). Reversible:
//            is_active = true, ban_duration "none".
//   row 8  — test dealer accounts ("Playwright Test Co", "TEST-SIGNED Dealer",
//            names with Test / Demo): closed through closeAccount(), the same
//            path as Dealer Health › Close dealer. Reversible: reopenAccount().
//            "… Recyclers" rows are LISTED only — some may be real dealers;
//            pass --close-recyclers after checking the list.
//   row 40 — test leads "Aditya Tile", "Lucky", "Rushikesh Test Lead 0011":
//            Mark Lost (reason other, note "Test lead") through markLeadLost(),
//            so the touchpoint and status history are written as usual.
//
// Nothing is deleted. --by=<email> picks who the closures are recorded as
// (default: the first active admin, else CEO).

import { createClient, type User } from "@supabase/supabase-js";
import { sql } from "drizzle-orm";

const TEST_USER_NAMES = ["asm test", "isr test"];
// Whole words only, so a real "Testa Motors" is never caught.
const TEST_ACCOUNT_REGEX = String.raw`\m(test|demo|playwright)\M`;
const RECYCLER_PATTERN = "%recyclers%";
const TEST_LEAD_NAMES = ["aditya tile", "lucky", "rushikesh test lead 0011"];
const BAN = "876000h";

type Row = Record<string, unknown>;
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];

async function main() {
    const apply = process.argv.includes("--apply");
    const closeRecyclers = process.argv.includes("--close-recyclers");
    // --skip=users,accounts,leads — e.g. keep the test logins on sandbox, where testers use them.
    const skip = new Set((arg("skip") ?? "").split(",").filter(Boolean));
    const { db } = await import("@/lib/db");
    const rows = async <T extends Row>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];
    console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").host}`);
    console.log(apply ? "Mode: APPLY\n" : "Mode: dry run (add --apply to change anything)\n");

    // Who the closures are recorded as.
    const byEmail = arg("by");
    const actor = (
        await rows<{ id: string; email: string; role: string }>(sql`
            SELECT id::text, email, role FROM users
             WHERE is_active AND ${byEmail ? sql`lower(email) = ${byEmail.toLowerCase()}` : sql`role IN ('admin','ceo')`}
             ORDER BY (role = 'admin') DESC, created_at LIMIT 1`)
    )[0];
    if (!actor) throw new Error("No active admin/CEO user to record the change as (use --by=<email>).");
    console.log(`Recorded as: ${actor.email} (${actor.role})\n`);
    let failed = 0;

    // ── Row 5: test users ──────────────────────────────────────────────────
    const users = skip.has("users")
        ? []
        : await rows<{ id: string; name: string; email: string; role: string; is_active: boolean }>(sql`
        SELECT id::text, name, email, role, is_active FROM users WHERE lower(trim(name)) IN ${TEST_USER_NAMES} ORDER BY name`);
    console.log(`Row 5 — test users (${users.length}):`);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const admin = url && service ? createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } }) : null;
    for (const u of users) {
        let auth: User | null = null;
        if (admin) {
            const { data } = await admin.auth.admin.getUserById(u.id);
            auth = data?.user ?? null;
        }
        const banned = !!auth?.banned_until && new Date(auth.banned_until) > new Date();
        const state = `users=${u.is_active ? "active" : "inactive"} auth=${auth ? (banned ? "banned" : "open") : "none"}`;
        if (!apply) {
            console.log(`  plan  ${u.name} <${u.email}> (${u.role}) ${state}`);
            continue;
        }
        await db.execute(sql`UPDATE users SET is_active = FALSE, updated_at = now() WHERE id = ${u.id}::uuid`);
        if (admin && auth && !banned) {
            const { error } = await admin.auth.admin.updateUserById(auth.id, { ban_duration: BAN });
            if (error) {
                failed++;
                console.log(`  FAIL  ${u.email} — ban: ${error.message}`);
                continue;
            }
        }
        console.log(`  done  ${u.name} <${u.email}> was ${state}`);
    }
    if (!admin) console.log("  (no Supabase service key: is_active only, no auth ban)");

    // ── Row 8: test dealer accounts ────────────────────────────────────────
    const { closeAccount } = await import("@/lib/accounts/accountClosures");
    const accounts = skip.has("accounts") ? [] : await rows<{ id: string; name: string; gstin: string; closed: boolean; recycler: boolean }>(sql`
        SELECT a.id, a.business_entity_name AS name, a.gstin,
               EXISTS (SELECT 1 FROM account_closures c WHERE c.account_id = a.id) AS closed,
               (a.business_entity_name ILIKE ${RECYCLER_PATTERN}) AS recycler
          FROM accounts a
         WHERE a.business_entity_name ~* ${TEST_ACCOUNT_REGEX} OR a.business_entity_name ILIKE ${RECYCLER_PATTERN}
         ORDER BY recycler, a.business_entity_name`);
    console.log(`\nRow 8 — test accounts (${accounts.length}):`);
    for (const a of accounts) {
        const tag = `${a.name} [${a.id}] GSTIN ${a.gstin || "—"}`;
        if (a.closed) {
            console.log(`  skip  ${tag} — already closed`);
            continue;
        }
        if (a.recycler && !closeRecyclers) {
            console.log(`  CHECK ${tag} — "Recyclers": confirm it is a test row, then rerun with --close-recyclers`);
            continue;
        }
        if (!apply) {
            console.log(`  plan  ${tag}`);
            continue;
        }
        const ok = await closeAccount(a.id, "Test account (not a real dealer)", actor.id);
        console.log(`  ${ok ? "done" : "FAIL"}  ${tag}`);
        if (!ok) failed++;
    }

    // ── Row 40: test leads ─────────────────────────────────────────────────
    const { markLeadLost } = await import("@/lib/leads/markLost");
    const leads = skip.has("leads") ? [] : await rows<{ id: string; name: string; status: string | null; phone: string | null }>(sql`
        SELECT id::text, COALESCE(NULLIF(shop_name,''), dealer_name) AS name, lead_status AS status, phone
          FROM dealer_leads
         WHERE is_active IS NOT FALSE
           AND (lower(trim(dealer_name)) IN ${TEST_LEAD_NAMES} OR lower(trim(shop_name)) IN ${TEST_LEAD_NAMES})
         ORDER BY name`);
    console.log(`\nRow 40 — test leads (${leads.length}):`);
    for (const l of leads) {
        const tag = `${l.name} [${l.id}] ${l.phone ?? ""} status=${l.status ?? "none"}`;
        if (l.status === "Lost") {
            console.log(`  skip  ${tag} — already Lost`);
            continue;
        }
        if (l.status === "Won" || l.status === "Converted") {
            console.log(`  CHECK ${tag} — ${l.status}; not closed here`);
            continue;
        }
        if (!apply) {
            console.log(`  plan  ${tag}`);
            continue;
        }
        try {
            await markLeadLost({
                leadId: l.id,
                actor: { id: actor.id, role: "admin" },
                reason: "other",
                notes: "Test lead (not a real dealer)",
                closingRole: "admin",
            });
            console.log(`  done  ${tag}`);
        } catch (e) {
            failed++;
            console.log(`  FAIL  ${tag} — ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
});
