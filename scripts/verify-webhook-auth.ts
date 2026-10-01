/**
 * Verifier for tracker ID 118, gap 4 — webhooks must prove their caller.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-webhook-auth.ts
 *
 * Calls the REAL route handlers with a forged event and with a correctly
 * signed one. Read-only: every event names a document / agreement / product
 * that does not exist, so a call that gets past the check only ever reaches a
 * "not found" lookup, and a refused call touches nothing. The secrets used are
 * made up for this run and set in this process only.
 */
import { createHmac } from "node:crypto";

type Outcome = "PASS" | "FAIL";
const results: Array<{ id: string; outcome: Outcome; note: string }> = [];

async function check(id: string, fn: () => Promise<string>) {
    try {
        results.push({ id, outcome: "PASS", note: await fn() });
    } catch (e) {
        results.push({ id, outcome: "FAIL", note: e instanceof Error ? e.message : String(e) });
    }
}
function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}

const DIGIO_SECRET = "verify-run-digio-secret";
const BOLNA_SECRET = "verify-run-bolna-secret";
const TOOL_SECRET = "verify-run-tool-secret";
const NO_SUCH = "ZZ-VERIFY-NO-SUCH-0000";

const sign = (body: string) => createHmac("sha256", DIGIO_SECRET).update(body, "utf8").digest("hex");
const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
    });

async function main() {
    // Silence the verifier's own [webhook-auth] lines; the outcome table is the report.
    const warn = console.warn;
    const log = console.log;
    console.warn = () => {};

    const { NextRequest } = await import("next/server");
    const digioMain = await import("../src/app/api/webhooks/digio/route");
    const digioLoan = await import("../src/app/api/digio/webhook/loan-agreement/route");
    const digioNbfc = await import("../src/app/api/digio/webhook/nbfc/route");
    const bolnaLegacy = await import("../src/app/api/webhooks/bolna/route");
    const bolnaCeo = await import("../src/app/api/ceo/ai-dialer/webhook/bolna/route");
    const priceLookup = await import("../src/app/api/bolna/tools/price-lookup/route");

    const req = (path: string, body: string, headers?: Record<string, string>) =>
        new NextRequest(post(path, body, headers));

    const consentEvent = JSON.stringify({ document_id: NO_SUCH, status: "signed" });
    const loanEvent = JSON.stringify({
        payload: { agreement_id: NO_SUCH, agreement_status: "COMPLETED", callback: `AGR_${NO_SUCH}` },
    });
    const nbfcEvent = JSON.stringify({
        payload: { agreement_id: NO_SUCH, agreement_status: "COMPLETED", callback: "NBFC_999999" },
    });

    // ── Digio, secret configured ─────────────────────────────────────────────
    process.env.DIGIO_WEBHOOK_SECRET = DIGIO_SECRET;
    process.env.WEBHOOK_AUTH_STRICT = "";

    await check("digio-forged-refused", async () => {
        const a = await digioMain.POST(req("/api/webhooks/digio", consentEvent));
        const b = await digioLoan.POST(req("/api/digio/webhook/loan-agreement", loanEvent));
        const c = await digioNbfc.POST(req("/api/digio/webhook/nbfc", nbfcEvent));
        assert(a.status === 401 && b.status === 401 && c.status === 401, `expected 401,401,401 got ${a.status},${b.status},${c.status}`);
        return "a 'signed' event with no X-Digio-Checksum is refused on all three Digio URLs";
    });

    await check("digio-wrong-checksum-refused", async () => {
        const bad = { "x-digio-checksum": createHmac("sha256", "guess").update(nbfcEvent).digest("hex") };
        const res = await digioNbfc.POST(req("/api/digio/webhook/nbfc", nbfcEvent, bad));
        assert(res.status === 401, `expected 401, got ${res.status}`);
        return "a checksum made with the wrong secret is refused";
    });

    await check("digio-tampered-body-refused", async () => {
        const tampered = nbfcEvent.replace("COMPLETED", "FAILED");
        const res = await digioNbfc.POST(req("/api/digio/webhook/nbfc", tampered, { "x-digio-checksum": sign(nbfcEvent) }));
        assert(res.status === 401, `expected 401, got ${res.status}`);
        return "a genuine checksum replayed on an edited body is refused";
    });

    await check("digio-genuine-accepted", async () => {
        const a = await digioMain.POST(req("/api/webhooks/digio", consentEvent, { "x-digio-checksum": sign(consentEvent) }));
        const b = await digioLoan.POST(req("/api/digio/webhook/loan-agreement", loanEvent, { "x-digio-checksum": sign(loanEvent) }));
        const c = await digioNbfc.POST(req("/api/digio/webhook/nbfc", nbfcEvent, { "x-digio-checksum": sign(nbfcEvent) }));
        // Past the check, each reaches its own "no such document" answer.
        assert(a.status === 200, `consent webhook: expected 200, got ${a.status}`);
        assert(b.status === 200, `loan-agreement webhook: expected 200, got ${b.status}`);
        assert(c.status === 404, `NBFC webhook: expected 404 AGREEMENT_NOT_FOUND, got ${c.status}`);
        return "a correctly signed event passes the check and reaches the lookup (200, 200, 404 not-found)";
    });

    // ── Digio, secret NOT configured: nothing changes on deploy ──────────────
    await check("digio-unconfigured-unchanged", async () => {
        process.env.DIGIO_WEBHOOK_SECRET = "";
        const c = await digioNbfc.POST(req("/api/digio/webhook/nbfc", nbfcEvent));
        assert(c.status === 404, `expected the old behaviour (404 not-found), got ${c.status}`);
        process.env.WEBHOOK_AUTH_STRICT = "1";
        const strict = await digioNbfc.POST(req("/api/digio/webhook/nbfc", nbfcEvent));
        process.env.WEBHOOK_AUTH_STRICT = "";
        assert(strict.status === 401, `strict mode: expected 401, got ${strict.status}`);
        return "with no secret the webhook behaves as before; WEBHOOK_AUTH_STRICT=1 refuses it";
    });

    // ── Bolna ────────────────────────────────────────────────────────────────
    process.env.BOLNA_WEBHOOK_SECRET = BOLNA_SECRET;
    const callEvent = JSON.stringify({ call_id: NO_SUCH, status: "completed" });

    await check("bolna-legacy-forged-refused", async () => {
        const a = await bolnaLegacy.POST(post("/api/webhooks/bolna", callEvent));
        const b = await bolnaCeo.POST(req("/api/ceo/ai-dialer/webhook/bolna", callEvent));
        const c = await bolnaCeo.POST(
            req("/api/ceo/ai-dialer/webhook/bolna", callEvent, { authorization: "Bearer wrong" }),
        );
        assert(a.status === 401 && b.status === 401 && c.status === 401, `expected 401,401,401 got ${a.status},${b.status},${c.status}`);
        return "a call event with no bearer, or the wrong one, is refused on both legacy Bolna URLs";
    });

    await check("bolna-tool-secret-separate", async () => {
        process.env.BOLNA_TOOL_SECRET = "";
        const lookup = JSON.stringify({ product_name: NO_SUCH });
        const open = await priceLookup.POST(req("/api/bolna/tools/price-lookup", lookup));
        assert(open.status !== 401, "the webhook secret alone must not lock the agent's tool call");

        process.env.BOLNA_TOOL_SECRET = TOOL_SECRET;
        const refused = await priceLookup.POST(req("/api/bolna/tools/price-lookup", lookup));
        assert(refused.status === 401, `no bearer: expected 401, got ${refused.status}`);
        const crossed = await priceLookup.POST(
            req("/api/bolna/tools/price-lookup", lookup, { authorization: `Bearer ${BOLNA_SECRET}` }),
        );
        assert(crossed.status === 401, `webhook secret on the tool URL: expected 401, got ${crossed.status}`);
        const ok = await priceLookup.POST(
            req("/api/bolna/tools/price-lookup", lookup, { authorization: `Bearer ${TOOL_SECRET}` }),
        );
        assert(ok.status === 200, `right bearer: expected 200, got ${ok.status}`);
        return "price lookup: open until BOLNA_TOOL_SECRET is set, then only the tool bearer gets prices";
    });

    console.warn = warn;
    const width = Math.max(...results.map((r) => r.id.length));
    for (const r of results) log(`${r.outcome}  ${r.id.padEnd(width)}  ${r.note}`);
    const failed = results.filter((r) => r.outcome === "FAIL").length;
    log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
