// One-off TEST (ID 166-A, decision 17) against a running dev server on :3000 + database-1.
// Read-only: mints links in memory, opens them over HTTP, writes nothing.
//   node --import tsx --env-file=.env.local scripts/_test-166a-links.ts
//
//   R6.2  the dealer's browser (holding the code cookie) opens its own earlier upload
//   R6.3/R6.5  the same link with no cookie (another browser / incognito) → refused
//   cookie of ANOTHER application → refused
//   file-link minting without the cookie → 403 codeRequired
//   R6.4  an expired link → refused
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { DOC_BINDING_COOKIE } from "@/lib/onboarding/docBinding";
import { signResumeToken } from "@/lib/onboarding/submitAccess";
import { onboardingStoredDocuments } from "@/lib/onboarding/onboardingFileLinks";

const BASE = process.env.TEST_BASE ?? "http://localhost:3000";
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
    if (!ok) failed++;
};
const rows = <T,>(r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];

async function open(path: string, cookie?: string) {
    const res = await fetch(`${BASE}${path}`, {
        redirect: "manual",
        headers: { accept: "application/json", ...(cookie ? { cookie } : {}) },
    });
    return res.status;
}

async function main() {
    // Applications with at least one stored onboarding document.
    const apps = rows<{ id: string }>(
        await db.execute(sql`
            SELECT DISTINCT d.application_id AS id FROM dealer_onboarding_documents d
             WHERE d.application_id IS NOT NULL ORDER BY 1 DESC LIMIT 15`),
    );
    let appId: string | null = null;
    let link: string | null = null;
    for (const a of apps) {
        const docs = await onboardingStoredDocuments(a.id);
        // Only a file that is really in storage (the S3 backfill left some rows pointing nowhere).
        for (const d of docs.filter((x) => x.bucketName === "dealer-documents" && x.viewUrl)) {
            const st = await open(d.viewUrl!.startsWith("http") ? new URL(d.viewUrl!).pathname + new URL(d.viewUrl!).search : d.viewUrl!,
                `${DOC_BINDING_COOKIE}=${encodeURIComponent(signResumeToken(a.id)!)}`);
            if (st === 200) {
                link = d.viewUrl;
                break;
            }
        }
        if (link) {
            appId = a.id;
            break;
        }
    }
    if (!appId || !link) throw new Error("no application with a stored, linkable document on db-1");
    const path = link.startsWith("http") ? new URL(link).pathname + new URL(link).search : link;
    console.log(`application ${appId}; link ${path.split("?")[0]}`);

    const other = apps.find((a) => a.id !== appId)?.id ?? "app-that-does-not-match";
    const own = `${DOC_BINDING_COOKIE}=${encodeURIComponent(signResumeToken(appId)!)}`;
    const wrong = `${DOC_BINDING_COOKIE}=${encodeURIComponent(signResumeToken(other)!)}`;

    const s1 = await open(path, own);
    check("R6.2 dealer's browser (code cookie) opens its own upload", s1 === 200, `HTTP ${s1}`);
    const s2 = await open(path);
    check("R6.3/R6.5 same link, no cookie (other browser) → refused", s2 === 401 || s2 === 403, `HTTP ${s2}`);
    const s3 = await open(path, wrong);
    check("same link, cookie for another application → refused", s3 === 401 || s3 === 403, `HTTP ${s3}`);

    const expired = path.replace(/([?&]exp=)(\d+)/, (_m, p) => `${p}${Math.floor(Date.now() / 1000) - 60}`);
    const s4 = await open(expired, own);
    check("R6.4 expired / altered link → refused", s4 === 401 || s4 === 403, `HTTP ${s4}`);

    // Minting: the resume token alone (forwarded) mints nothing without the browser cookie.
    const mint = await fetch(`${BASE}/api/dealer/onboarding/file-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: path.split("?")[0], resumeToken: signResumeToken(appId) }),
    });
    const mj = (await mint.json().catch(() => ({}))) as { codeRequired?: boolean };
    check("file-link without the code cookie → 403 code required", mint.status === 403 && mj.codeRequired === true, `HTTP ${mint.status}`);
    const mint2 = await fetch(`${BASE}/api/dealer/onboarding/file-link`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: own },
        body: JSON.stringify({ url: path.split("?")[0], resumeToken: signResumeToken(appId) }),
    });
    const m2 = (await mint2.json().catch(() => ({}))) as { success?: boolean; url?: string };
    check("file-link with the code cookie → fresh 15-minute link", mint2.status === 200 && !!m2.url, `HTTP ${mint2.status}`);
    if (m2.url) {
        const exp = Number(new URL(m2.url, BASE).searchParams.get("exp"));
        const mins = (exp * 1000 - Date.now()) / 60000;
        check("link lives 15 minutes at most", mins > 0 && mins <= 15.1, `${mins.toFixed(1)} min`);
    }

    console.log(failed ? `${failed} FAILED` : "ALL PASSED");
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
