/**
 * ID 238 — drive WhatsApp dealer onboarding with the real orchestrator, the
 * Meta leg stubbed (WA_DRY_RUN=1: nothing is sent to WhatsApp). Refuses live.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-whatsapp-doc-skip-238.ts --i-understand-this-mutates
 *
 * WRITES on the sandbox: a WhatsApp onboarding session and a SUBMITTED
 * application for a made-up test number (91 9000 xxxxxx). Checks:
 *   1. every document request carries the ⏭ Skip button and the line;
 *   2. tapping Skip on the Bank statement → the NEXT document is asked;
 *   3. a dealer who skipped is not told "received all your documents";
 *   4. GST skipped too, and the application still submits (no block);
 *   5. the application's session records the skips the admin pages read.
 * Prints the application id to open in Dealer Validation.
 */

process.env.WA_DRY_RUN = "1";

let failed = 0;
const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failed++;
};

async function main() {
    if (!process.argv.includes("--i-understand-this-mutates")) {
        console.error("This script writes a test WhatsApp onboarding on the sandbox. Add --i-understand-this-mutates.");
        process.exit(2);
    }
    const host = new URL(process.env.DATABASE_URL ?? "postgres://none").hostname;
    if (host.startsWith("database-2")) throw new Error("refusing to run against live (database-2)");
    console.log("DB HOST:", host, "\n");

    const { db } = await import("@/lib/db");
    const { sql } = await import("drizzle-orm");
    const { runTurn } = await import("@/lib/whatsapp/orchestrator");
    const { dryRunSends, dryRunClear } = await import("@/lib/whatsapp/dry-run");
    const { DOC_SKIP_ID, DOC_REQUEST_SKIP_LINE } = await import("@/lib/whatsapp/doc-buttons");

    const waPhone = `919000${String(Date.now()).slice(-6)}`;
    let seq = 0;
    const say = async (text: string, verbose = true) => {
        dryRunClear();
        await runTurn({ providerMessageId: `verify-238-${Date.now()}-${seq++}`, waPhone, type: "interactive", text } as never);
        const out = dryRunSends().filter((s) => s.to.replace(/\D/g, "").endsWith(waPhone.slice(-10)));
        if (verbose) for (const s of out) console.log(`   ← ${s.body.replace(/\n+/g, " ⏎ ").slice(0, 160)}${s.buttons ? " " + s.buttons.map((b) => `[${b.title}]`).join(" ") : ""}`);
        return out;
    };
    const session = async () =>
        ((await db.execute(sql`
            SELECT id::text AS id, current_state, expected_document_type, application_id::text AS application_id, context
              FROM whatsapp_onboarding_sessions WHERE wa_phone = ${waPhone}
             ORDER BY created_at DESC LIMIT 1`)) as unknown as Array<{
            id: string; current_state: string; expected_document_type: string | null; application_id: string | null; context: { skipped?: string[] };
        }>)[0];
    const hasSkip = (s: { body: string; buttons?: Array<{ id: string }> }) =>
        s.body.includes(DOC_REQUEST_SKIP_LINE) && !!s.buttons?.some((b) => b.id === DOC_SKIP_ID);

    console.log(`Test dealer on WhatsApp ${waPhone}: hi → I'm a dealer → Sole proprietor → one by one`);
    await say("hi", false);
    await say("role_dealer", false);
    await say("sole_proprietorship", false);
    let out = await say("upload_one");

    let requests = 0, withSkip = 0, bankSeen = false;
    for (let guard = 0; guard < 15; guard++) {
        const s = await session();
        if (s?.current_state !== "COLLECTING_DOC") break;
        const ask = out[out.length - 1];
        requests++;
        if (ask && hasSkip(ask)) withSkip++;
        const was = s.expected_document_type;
        console.log(`→ tap ⏭ Skip on ${was}`);
        out = await say(DOC_SKIP_ID);
        if (was === "bank_statement") {
            bankSeen = true;
            const after = await session();
            check(
                after?.current_state === "COLLECTING_DOC" && !!after.expected_document_type && after.expected_document_type !== "bank_statement",
                `Skip on the Bank statement → the next document is asked (${after?.expected_document_type})`,
            );
        }
    }
    check(bankSeen, "the Bank statement was requested");
    check(requests > 0 && withSkip === requests, `every document request had the Skip line and button (${withSkip}/${requests})`);
    const doneMsg = out.map((s) => s.body).join(" ");
    check(!/received all your documents/.test(doneMsg) && /continue without/.test(doneMsg), "after skipping, the dealer is not told 'all documents received'");

    console.log("→ tap No (financing), Correct (signer)");
    await say("finance_no", false);
    await say("CORRECT");
    const s = await session();
    check(s?.current_state === "SUBMITTED" && !!s.application_id, `the application submits with GST skipped (state ${s?.current_state})`);
    const skipped = s?.context?.skipped ?? [];
    check(skipped.includes("bank_statement") && skipped.includes("gst"), `the session records the skips the admin pages read (${skipped.join(", ")})`);
    if (s?.application_id) {
        console.log(`\nOpen in Dealer Validation: /admin/dealer-verification/${s.application_id}`);
    }
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(1);
});
