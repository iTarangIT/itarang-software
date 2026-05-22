// seed-gwalior-leads.mjs
//
// One-off: load the first 50 valid leads from docs/Gwalior Leads.xlsx into
// dealer_leads so they appear under Madhya Pradesh > Gwalior in the AI
// dialer's Region selector and can be dialed via Bolna.
//
// Why these column values (must match the scraper path, NOT bulk upload):
//   - lead_status = NULL          → AI-dialable per BRD §0.2 exclusion filter
//                                   (src/lib/ai-dialer/exclusionFilter.ts).
//                                   Bulk upload sets 'New_Unassigned', which
//                                   routes a lead to Inside Sales instead.
//   - phone = 10-digit            → dealer_leads canonical form (Bolna's
//                                   triggerCall normalizes to E.164 at call
//                                   time). Mirrors promoteLeadsToDealerLeads.
//   - current_status = 'new'      → not a no-call status, so it counts as
//                                   "dialable" in the region tree.
//   - city/state hard-set to Gwalior / Madhya Pradesh — the file is a
//     Gwalior scrape; the raw address column is junk (plus-codes, "No 12").
//
// Idempotent: dedupes against existing dealer_leads.phone (10-digit and +91
// variants) and uses ON CONFLICT (phone) DO NOTHING. Re-running inserts 0.
//
// Run:  node scripts/seed-gwalior-leads.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import XLSX from "xlsx";
import postgres from "postgres";
import { nanoid } from "nanoid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// The project keeps secrets in .env.local (with .env as a fallback) — load
// both explicitly; dotenv's default only reads .env.
dotenv.config({ path: path.join(ROOT, ".env.local") });
dotenv.config({ path: path.join(ROOT, ".env") });

const TARGET = 50;
const CITY = "Gwalior";
const STATE = "Madhya Pradesh";

const XLSX_PATH = path.join(ROOT, "docs", "Gwalior Leads.xlsx");

// 10-digit Indian mobile, the dealer_leads-canonical form.
function toTenDigits(raw) {
    const digits = String(raw ?? "").replace(/\D/g, "");
    let ten = null;
    if (digits.length === 10) ten = digits;
    else if (digits.length === 12 && digits.startsWith("91")) ten = digits.slice(2);
    else if (digits.length === 13 && digits.startsWith("091")) ten = digits.slice(3);
    else if (digits.length === 11 && digits.startsWith("0")) ten = digits.slice(1);
    if (!ten || !/^[6-9]\d{9}$/.test(ten)) return null;
    return ten;
}

function clean(v) {
    const s = String(v ?? "").trim();
    return s && s !== "—" ? s : null;
}

async function main() {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

    // ── 1. Parse the workbook ──────────────────────────────────────────────
    const wb = XLSX.readFile(XLSX_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    // Header: Name, Company Name, Phone Number, Email, Address, ...
    const dataRows = grid.slice(1);
    console.log(`Workbook: ${dataRows.length} data rows in "${wb.SheetNames[0]}".`);

    // ── 2. Normalise + de-dupe within the file ─────────────────────────────
    let skippedInvalidPhone = 0;
    let skippedInBatchDup = 0;
    const seen = new Set();
    const candidates = [];
    for (const r of dataRows) {
        const phone = toTenDigits(r[2]);
        if (!phone) {
            skippedInvalidPhone++;
            continue;
        }
        if (seen.has(phone)) {
            skippedInBatchDup++;
            continue;
        }
        seen.add(phone);
        const name = clean(r[1]) || clean(r[0]); // Company Name → Name
        candidates.push({
            phone,
            name,
            address: clean(r[4]),
        });
    }
    console.log(
        `Valid unique phones in file: ${candidates.length} ` +
            `(skipped ${skippedInvalidPhone} invalid, ${skippedInBatchDup} in-file duplicates).`,
    );

    const sql = postgres(process.env.DATABASE_URL, {
        ssl: "require",
        prepare: false,
        max: 3,
    });

    try {
        // ── 3. Drop phones already in dealer_leads (10-digit or +91) ───────
        const allVariants = candidates.flatMap((c) => [c.phone, `+91${c.phone}`, `91${c.phone}`]);
        const existing = await sql`
            SELECT phone FROM dealer_leads WHERE phone IN ${sql(allVariants)}
        `;
        const existingTen = new Set(existing.map((e) => toTenDigits(e.phone)).filter(Boolean));
        const fresh = candidates.filter((c) => !existingTen.has(c.phone));
        console.log(
            `Already in dealer_leads: ${candidates.length - fresh.length}. ` +
                `Fresh candidates: ${fresh.length}.`,
        );

        // ── 4. Take the first TARGET and build rows ────────────────────────
        const picked = fresh.slice(0, TARGET);
        if (picked.length === 0) {
            console.log("Nothing new to insert — the first 50 Gwalior leads are already present.");
            return;
        }
        if (picked.length < TARGET) {
            console.log(`WARNING: only ${picked.length} fresh leads available (wanted ${TARGET}).`);
        }

        const now = new Date();
        const rows = picked.map((c) => ({
            id: `L-${nanoid(8)}`,
            dealer_name: c.name,
            shop_name: c.name,
            phone: c.phone,
            location: CITY,
            state: STATE,
            city: CITY,
            country: "IN",
            language: "hindi",
            current_status: "new", // dialable; lead_status stays NULL → AI-dialable
            total_attempts: 0,
            source: "ai_dialer_lead",
            provider: "bolna",
            address_notes: c.address,
            created_at: now,
        }));

        // ── 5. Insert ──────────────────────────────────────────────────────
        const inserted = await sql`
            INSERT INTO dealer_leads ${sql(
                rows,
                "id",
                "dealer_name",
                "shop_name",
                "phone",
                "location",
                "state",
                "city",
                "country",
                "language",
                "current_status",
                "total_attempts",
                "source",
                "provider",
                "address_notes",
                "created_at",
            )}
            ON CONFLICT (phone) DO NOTHING
            RETURNING id
        `;
        console.log(`Inserted ${inserted.length} new dealer_leads rows for ${CITY}, ${STATE}.`);

        // ── 6. Verify what the AI dialer will now see ──────────────────────
        const summary = await sql`
            SELECT
                COUNT(*)::int AS total,
                SUM(CASE
                    WHEN lead_status IS NULL
                     AND (ai_recall_status IS NULL OR ai_recall_status <> 'excluded')
                     AND phone IS NOT NULL AND phone <> ''
                    THEN 1 ELSE 0 END)::int AS ai_dialable
            FROM dealer_leads
            WHERE LOWER(TRIM(city)) = 'gwalior'
        `;
        console.log(
            `dealer_leads in Gwalior now: ${summary[0].total} total, ` +
                `${summary[0].ai_dialable} AI-dialable.`,
        );
    } finally {
        await sql.end();
    }
}

main().catch((e) => {
    console.error("FAILED:", e.message);
    process.exit(1);
});
