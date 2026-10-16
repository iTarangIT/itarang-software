/**
 * ID 166 — read-only check that the Calls and Expenses downloads carry no
 * working file link: every Recording / Bill link cell is a checked CRM address
 * (/api/files/open or /api/ai-dialer/recording) or a note.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id166-download-links.ts
 *
 * Writes nothing.
 */
import { datasetById, type RunContext } from "@/lib/exports/datasets/registry";
import { exportOrigin } from "@/lib/exports/fileLinks";

async function check(id: string, key: string): Promise<number> {
    const dataset = datasetById(id);
    if (!dataset) throw new Error(`${id} dataset missing`);
    const user = { id: "00000000-0000-0000-0000-000000000000", role: "admin", email: null, name: "verify" } as unknown as RunContext["user"];
    const [sheet] = await dataset.build({ params: new URLSearchParams({ from: "2000-01-01", to: "2100-12-31" }), user, ownOnly: false });
    const origin = exportOrigin();
    const filled = sheet.rows.map((r) => r[key]).filter((v): v is string => typeof v === "string" && v !== "");
    const links = filled.filter((v) => /^https?:\/\//i.test(v) || v.startsWith("/"));
    const bad = links.filter((v) => !v.startsWith(`${origin}/api/files/open?u=`) && !v.startsWith(`${origin}/api/ai-dialer/recording/`));
    const notes = filled.length - links.length;
    console.log(`${id}: ${sheet.rows.length} rows, ${links.length} checked links, ${notes} notes, ${bad.length} raw links`);
    for (const v of bad.slice(0, 5)) console.log(`  RAW: ${v.slice(0, 120)}`);
    return bad.length;
}

async function main() {
    const bad = (await check("calls", "recording_url")) + (await check("expenses", "bill_url"));
    console.log(bad ? "FAIL" : "OK");
    process.exit(bad ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
