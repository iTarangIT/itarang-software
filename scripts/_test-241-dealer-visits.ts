// One-off TEST (ID 241-1 / 241-2) on database-1: logs a dealer visit the way
// POST /api/visits/account does (Order taken, ₹25,000 reported, next visit in 7 days),
// then checks the dealer history, the booked visit, My visits, My dealers' Last visit
// and that revenue did not move. Every row it writes is deleted at the end.
//   node --import tsx --env-file=.env.local scripts/_test-241-dealer-visits.ts
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { listDealerHealth } from "@/lib/dealers/accountHealth";
import { myDealerRows } from "@/lib/accounts/myDealers";
import {
    accountHistory,
    bookAccountVisit,
    bookedDealerVisits,
    hasDealerVisitOutcomes,
    openAccountBooking,
    setDealerVisitFields,
    takeOverAccountBooking,
} from "@/lib/visits/dealerVisitStore";
import { istDay } from "@/lib/visits/verifiedCapture";

const rows = <T,>(r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
    if (!ok) failed++;
};

async function main() {
    const host = new URL(process.env.DATABASE_URL!).host.split(".")[0];
    if (host !== "database-1") throw new Error(`refusing to write on ${host}`);
    check("E-386 present", await hasDealerVisitOutcomes());

    const [acct] = rows<{ account_id: string; owner_id: string; role: string; name: string }>(
        await db.execute(sql`
            SELECT ao.account_id, ao.owner_user_id::text AS owner_id, u.role, a.business_entity_name AS name
              FROM account_ownership ao JOIN users u ON u.id = ao.owner_user_id JOIN accounts a ON a.id = ao.account_id
             WHERE u.role = 'asm' AND ao.source_dealer_lead_id IS NULL
             ORDER BY ao.account_id LIMIT 1`),
    );
    if (!acct) throw new Error("no ASM-owned account on db-1");
    console.log(`account: ${acct.name} (${acct.account_id}), owner role ${acct.role}`);

    const today = istDay(new Date());
    const next = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const before = (await listDealerHealth()).find((r) => r.account_id === acct.account_id);
    const ids: string[] = [];

    try {
        // 1. A stale booking from earlier: the visit must take it over (keep the planned date).
        const oldBooking = await db.transaction((tx) => bookAccountVisit(tx, acct.account_id, acct.owner_id, today));
        ids.push(oldBooking);
        // 2. Log the visit as the route does.
        const visitId = await db.transaction(async (tx) => {
            const taken = await takeOverAccountBooking(tx, acct.account_id, today);
            check("visit takes over the booking due today", taken === oldBooking);
            await tx.execute(sql`
                UPDATE lead_visits SET actual_visit_date = ${today}::date, visit_status = 'visited',
                       visit_outcome = 'productive', visit_remarks = 'TEST 241 — order for 10 batteries',
                       photos = '[]'::jsonb, updated_at = NOW()
                 WHERE visit_id::text = ${taken}`);
            await setDealerVisitFields(tx, taken!, {
                dealerOutcome: "order_taken",
                reportedAmount: 25000,
                nextVisitDate: next,
                noFollowUp: false,
            });
            ids.push(await bookAccountVisit(tx, acct.account_id, acct.owner_id, next));
            return taken!;
        });

        const hist = await accountHistory(acct.account_id, null, false);
        const v = hist.find((h) => h.kind === "visit" && h.detail?.startsWith("TEST 241"));
        check("history shows the visit with 'Order taken'", !!v && v.title === "Visit · Order taken", v?.title);
        check("history shows the reported amount", v?.reportedAmount === 25000, String(v?.reportedAmount));
        check("history shows the booked visit first", hist[0]?.kind === "booked" && hist[0].at.startsWith(next), hist[0]?.at);

        const booking = await openAccountBooking(acct.account_id);
        check("one open booking, on the next date", booking?.scheduled_date === next, booking?.scheduled_date ?? "none");

        const mine = await bookedDealerVisits([acct.owner_id]);
        check("My visits lists the booked dealer visit", mine.some((m) => m.account_id === acct.account_id && m.scheduled_date === next));

        const md = await myDealerRows({ id: acct.owner_id, role: "asm" });
        const row = md.rows.find((r) => r.account_id === acct.account_id);
        check("My dealers: Last visit = today", row?.last_visit_date === today, row?.last_visit_date ?? "none");
        check("My dealers: not flagged 'Not visited in 30 days'", row?.not_visited_30 === false);

        const after = (await listDealerHealth()).find((r) => r.account_id === acct.account_id);
        check(
            "reported amount never in revenue",
            before?.revenue_90d === after?.revenue_90d && before?.revenue_lifetime === after?.revenue_lifetime,
            `${before?.revenue_lifetime} → ${after?.revenue_lifetime}`,
        );

        // 3. A second booking for a later day replaces nothing yet; logging with a new date keeps ONE open booking.
        const later = await db.transaction(async (tx) => {
            await takeOverAccountBooking(tx, acct.account_id, today); // nothing due today now
            return bookAccountVisit(tx, acct.account_id, acct.owner_id, next);
        });
        ids.push(later);
        const open = rows<{ n: number }>(
            await db.execute(sql`SELECT COUNT(*)::int AS n FROM lead_visits
                                  WHERE account_id = ${acct.account_id} AND visit_status IN ('scheduled','pending_scheduling')`),
        );
        // The route always runs takeOver first, which cancels bookings NOT due (rest), so only the new one is open.
        check("a new date leaves exactly one open booking", open[0]?.n === 1, `open=${open[0]?.n}`);
        void visitId;
    } finally {
        if (ids.length) {
            await db.execute(sql`DELETE FROM lead_visits WHERE visit_id::text IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
            console.log(`cleaned up ${ids.length} TEST rows`);
        }
    }
    console.log(failed ? `${failed} FAILED` : "ALL PASSED");
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
