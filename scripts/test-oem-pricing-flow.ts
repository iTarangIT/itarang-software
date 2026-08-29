/**
 * E-230 — a live walkthrough of the OEM Inventory Pricing flow.
 *
 *   node --import tsx --env-file=.env.local scripts/test-oem-pricing-flow.ts
 *   node --import tsx --env-file=.env.local scripts/test-oem-pricing-flow.ts --sweep
 *
 * WHY THIS EXISTS RATHER THAN "just click through it". The register is DATED,
 * and the three things most likely to be wrong are all invisible from a screen
 * you are looking at today:
 *
 *   - a price scheduled for next month must leave today's quotes alone
 *   - a price that ran out must stop approving, rather than going on forever
 *   - a new line must never silently delete a successor somebody scheduled
 *
 * You cannot see any of that by clicking, because you would have to wait a
 * month. This drives the real `oemPrices.ts` against the real database with
 * explicit `at` timestamps, so a month passes in a millisecond.
 *
 * The pure half of the flow — the at-or-above rule that decides auto-approve vs
 * CEO — needs no database and lives in src/lib/leads/__tests__/oemPricing.test.ts
 * (`npx vitest run src/lib/leads`).
 *
 * SAFETY. This WRITES to whatever DATABASE_URL points at. It snapshots every
 * existing row for the one product it borrows, and on the way out deletes the
 * lines it inserted and restores the columns it touched — including on failure.
 *
 * --sweep is OFF by default and is the one part that is not self-cleaning:
 *   - `oem.price_missing` is not in catalog.ts's NO_EMAIL set, so emit() SENDS
 *     REAL EMAIL to every active ceo/admin — on database-1 that is ceo@itarang.com,
 *     ceo.itarang@gmail.com and buyback.admin@itarang.com.
 *   - it stamps a one-week cooldown in app_settings, which then suppresses the
 *     notification you were probably trying to watch for.
 * To re-arm it afterwards:
 *   DELETE FROM app_settings WHERE key = 'oem_price_missing_notified_at';
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { oemReferencePrices } from "@/lib/db/schema";
import {
    deleteScheduledOemPrice,
    listExpiringOemPrices,
    listOemCatalogue,
    listOemPriceHistory,
    listUnpricedOemProducts,
    loadLiveOemPrices,
    OemPriceOverlapError,
    setOemPrice,
    type OemAssetType,
} from "@/lib/leads/oemPrices";
import { evaluateAgainstOemPrices, refKey } from "@/lib/leads/oemPricing";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";

const RUN_SWEEP = process.argv.includes("--sweep");

const DAY = 24 * 60 * 60_000;
const now = new Date();
const at = (days: number) => new Date(now.getTime() + days * DAY);

/** Lines this run inserted. Deleted on the way out, pass or fail. */
const inserted: string[] = [];
/** Of those, the ones the flow itself removed — a scheduled line that never applied. */
const dropped = new Set<string>();
/** Pre-existing rows for the borrowed product, so they can be put back. */
let snapshot: Array<{
    price_id: string;
    effective_to: Date | null;
    expiry_notified_at: Date | null;
}> = [];

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string) {
    if (ok) {
        passed += 1;
        console.log(`  PASS  ${label}`);
    } else {
        failed += 1;
        console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
    }
}

function step(n: number, title: string) {
    console.log(`\n${n}. ${title}`);
}

async function add(
    product: { asset_type: OemAssetType; product_id: string; model_id: string; product_name: string },
    price: number,
    from: Date,
    until: Date | null,
    note: string,
): Promise<string> {
    const id = await setOemPrice({
        asset_type: product.asset_type,
        product_id: product.product_id,
        model_id: product.model_id,
        product_name: product.product_name,
        oem_price: price,
        effective_from: from,
        valid_until: until,
        note,
        // A real users row: created_by is joined to users for "Set by", and the
        // screen showing a blank there would hide a genuine bug.
        created_by: await someUserId(),
    });
    inserted.push(id);
    return id;
}

let cachedUserId: string | null = null;
async function someUserId(): Promise<string> {
    if (cachedUserId) return cachedUserId;
    // A CEO or admin, because that is who the screen lets in.
    const rows = await db.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM users
         WHERE role IN ('ceo','admin') AND is_active
         ORDER BY created_at ASC LIMIT 1`);
    const id = (rows as unknown as Array<{ id: string }>)[0]?.id;
    if (!id) throw new Error("No active ceo/admin user on this DB to attribute prices to.");
    cachedUserId = id;
    return id;
}

/** A quote line for `product` at `unitPrice`, as the commercials route builds it. */
function quoteLine(
    product: { asset_type: OemAssetType; product_id: string; model_id: string; product_name: string },
    unitPrice: number,
): CommercialsProductLine {
    return {
        asset_type: product.asset_type,
        product_id: product.product_id,
        product_name: product.product_name,
        model_id: product.model_id,
        unit_price: unitPrice,
        quantity: 1,
    } as CommercialsProductLine;
}

/** The whole decision, exactly as the commercials route reaches it. */
async function verdictAt(
    product: { asset_type: OemAssetType; product_id: string; model_id: string; product_name: string },
    unitPrice: number,
    when: Date,
) {
    const lines = [quoteLine(product, unitPrice)];
    const refs = await loadLiveOemPrices(lines, undefined, when);
    const evaluation = evaluateAgainstOemPrices(lines, refs, when);
    return {
        reference: refs.get(refKey(product.asset_type, product.product_id))?.oem_price ?? null,
        outcome: evaluation.outcome,
        reason: evaluation.reason,
        shortfall: evaluation.shortfall_total,
    };
}

async function main() {
    console.log("OEM Inventory Pricing — live flow check");
    console.log(`DB: ${new URL(process.env.DATABASE_URL!).hostname}`);
    console.log(`Now: ${now.toISOString()}`);

    // ── Pick a product to borrow ─────────────────────────────────────────────
    step(0, "Read the catalogue");
    const catalogue = await listOemCatalogue();
    check("listOemCatalogue() runs (this is the query that 500s without E-230)", catalogue.length > 0,
        `got ${catalogue.length} rows — expected the active product masters`);
    if (catalogue.length === 0) {
        throw new Error("No active products in any master. Seed inventory first.");
    }

    const unpricedBefore = catalogue.filter((p) => p.oem_price == null).length;
    console.log(
        `        ${catalogue.length} active model(s), ${unpricedBefore} with no price in force.`,
    );

    // Prefer one nobody has priced, so the borrowed product is genuinely idle.
    const target = catalogue.find((p) => p.oem_price == null) ?? catalogue[0];
    const product = {
        asset_type: target.asset_type,
        product_id: target.product_id,
        model_id: target.model_id,
        product_name: target.product_name,
    };
    console.log(`        Borrowing: ${product.product_name} (${product.model_id})`);

    snapshot = (
        await db
            .select({
                price_id: oemReferencePrices.price_id,
                effective_to: oemReferencePrices.effective_to,
                expiry_notified_at: oemReferencePrices.expiry_notified_at,
            })
            .from(oemReferencePrices)
            .where(
                and(
                    eq(oemReferencePrices.asset_type, product.asset_type),
                    eq(oemReferencePrices.product_id, product.product_id),
                ),
            )
    ).map((r) => ({
        price_id: r.price_id,
        effective_to: r.effective_to as Date | null,
        expiry_notified_at: r.expiry_notified_at as Date | null,
    }));
    console.log(`        Snapshotted ${snapshot.length} existing line(s) to restore.`);

    // ── 1. A price with no end date ──────────────────────────────────────────
    step(1, "Set ₹50,000, open-ended — the ordinary case");
    await add(product, 50_000, at(-1), null, "[flow-check] line 1");

    const v1 = await verdictAt(product, 60_000, now);
    check("a quote AT ₹60,000 auto-approves against a ₹50,000 reference",
        v1.reference === 50_000 && v1.outcome === "auto_approved",
        `reference=${v1.reference} outcome=${v1.outcome}`);

    const v1b = await verdictAt(product, 45_000, now);
    check("a quote AT ₹45,000 goes to the CEO, shortfall ₹5,000",
        v1b.outcome === "manual_required" && v1b.reason === "below_reference" && v1b.shortfall === 5_000,
        `outcome=${v1b.outcome} reason=${v1b.reason} shortfall=${v1b.shortfall}`);

    const v1c = await verdictAt(product, 60_000, at(-30));
    check("the SAME quote raised 30 days ago finds no reference (the line had not started)",
        v1c.reference === null && v1c.reason === "missing_reference",
        `reference=${v1c.reference} reason=${v1c.reason}`);

    // ── 2. Give it an end date, then queue the successor ─────────────────────
    step(2, "Kartik's example: ₹50,000 until +30d, then ₹52,000");
    // Revising the open line so it now carries an end date.
    await add(product, 50_000, now, at(30), "[flow-check] line 2 — dated");
    await add(product, 52_000, at(30), null, "[flow-check] line 3 — successor");

    const today = await verdictAt(product, 51_000, now);
    check("TODAY a ₹51,000 quote auto-approves — judged against ₹50,000",
        today.reference === 50_000 && today.outcome === "auto_approved",
        `reference=${today.reference} outcome=${today.outcome}`);

    const later = await verdictAt(product, 51_000, at(31));
    check("in 31 days the SAME ₹51,000 quote goes to the CEO — judged against ₹52,000",
        later.reference === 52_000 && later.outcome === "manual_required",
        `reference=${later.reference} outcome=${later.outcome}`);

    const boundary = await verdictAt(product, 51_000, at(30));
    check("on the changeover instant the NEW line owns it (half-open window, no overlap)",
        boundary.reference === 52_000,
        `reference=${boundary.reference} — both lines matching would be a double-count bug`);

    const cat2 = (await listOemCatalogue()).find((p) => p.product_id === product.product_id)!;
    check("the screen shows ₹50,000 in force with ₹52,000 queued behind it",
        cat2.oem_price === 50_000 && cat2.next_price === 52_000 && cat2.valid_until != null,
        `oem_price=${cat2.oem_price} next_price=${cat2.next_price} valid_until=${cat2.valid_until}`);

    // ── 3. The successor must not be silently overwritten ────────────────────
    step(3, "Try to straddle the scheduled line");
    let refused = false;
    let message = "";
    try {
        await add(product, 47_000, now, at(45), "[flow-check] straddler");
    } catch (e) {
        refused = e instanceof OemPriceOverlapError;
        message = e instanceof Error ? e.message : String(e);
    }
    check("a line spanning the scheduled successor is REFUSED, not silently applied",
        refused, `expected OemPriceOverlapError, got: ${message || "no error at all"}`);
    if (refused) console.log(`        → "${message}"`);

    const stillThere = await verdictAt(product, 51_000, at(31));
    check("and the successor survived the attempt",
        stillThere.reference === 52_000,
        `reference=${stillThere.reference}`);

    // ── 4. Expiry detection ──────────────────────────────────────────────────
    step(4, "What the six-hourly sweep sees");
    const expiring = await listExpiringOemPrices(14);
    const mine = expiring.filter((e) => e.product_id === product.product_id);
    check("a window closing in 30 days is NOT inside the 14-day notice period",
        mine.length === 0,
        `got ${mine.length} — the warning would be a month early`);

    // Move the end date inside the window by revising to a shorter one.
    await add(product, 50_500, now, at(5), "[flow-check] lapses in 5 days");
    const expiring2 = await listExpiringOemPrices(14);
    const mine2 = expiring2.filter((e) => e.product_id === product.product_id);
    check("a window closing in 5 days IS picked up",
        mine2.length === 1, `got ${mine2.length} matching line(s)`);
    check("…and is flagged as covered, because a successor is already queued",
        mine2[0]?.has_successor === true,
        `has_successor=${mine2[0]?.has_successor} — an uncovered flag here would nag ` +
            `somebody who has already done the work`);

    // ── 5. Lapsing ───────────────────────────────────────────────────────────
    step(5, "A price that runs out with nothing behind it");
    // Drop the successor so the line genuinely lapses.
    const successorId = inserted[2];
    const removed = await deleteScheduledOemPrice(successorId);
    check("a scheduled line that never judged a quote can be removed",
        removed.deleted === true, removed.reason ?? "");
    if (removed.deleted) dropped.add(successorId);

    const inForceId = inserted[inserted.length - 1];
    const refuse = await deleteScheduledOemPrice(inForceId);
    check("the line IN FORCE cannot be removed — quotes were judged against it",
        refuse.deleted === false && /already in force/i.test(refuse.reason ?? ""),
        `deleted=${refuse.deleted} reason=${refuse.reason}`);

    const afterLapse = await verdictAt(product, 999_999, at(6));
    check("once the window closes, even a huge quote stops auto-approving",
        afterLapse.reference === null && afterLapse.reason === "missing_reference",
        `reference=${afterLapse.reference} reason=${afterLapse.reason} — a price going on ` +
            `approving past its end date is the bug E-230 exists to prevent`);

    const unpricedNow = await listUnpricedOemProducts();
    check("but TODAY it is still priced, so it is not in the unpriced backlog yet",
        !unpricedNow.some((u) => u.product_id === product.product_id),
        "the sweep would be warning about a price that is currently working");

    // ── 6. History ───────────────────────────────────────────────────────────
    step(6, "The audit trail");
    const history = await listOemPriceHistory(product.asset_type, product.product_id);
    const ours = history.filter((h) => h.note?.startsWith("[flow-check]"));
    // Every line EXCEPT the scheduled one deleted in step 5, which never applied
    // to a quote and so is not history. Revisions are never edited away: that is
    // the difference between this table and an `UPDATE price SET …`.
    const survivors = inserted.length - dropped.size;
    check("every line that was ever in force is still on the record",
        ours.length === survivors,
        `${ours.length} on record vs ${survivors} expected ` +
            `(${inserted.length} inserted, ${dropped.size} deliberately removed)`);
    check("and the removed line is genuinely gone, not left as a zero-length window",
        !ours.some((h) => dropped.has(h.price_id)));
    check("each superseded line names who set it",
        ours.every((h) => h.created_by_name != null),
        "a blank 'Set by' column means the users join is broken");
    for (const h of ours) {
        const state = h.effective_to
            ? "replaced"
            : new Date(h.effective_from) > now
              ? "scheduled"
              : h.valid_until && new Date(h.valid_until) <= now
                ? "expired"
                : "in force";
        console.log(
            `        ₹${h.oem_price.toLocaleString("en-IN")}  ` +
                `${h.effective_from.slice(0, 10)} → ${(h.valid_until ?? h.effective_to ?? "open").slice(0, 10)}  [${state}]`,
        );
    }

    // ── 7. Optional: the real sweep ──────────────────────────────────────────
    if (RUN_SWEEP) {
        step(7, "Running the real sweep — THIS NOTIFIES AND EMAILS");
        const { runOemPriceSweep } = await import("@/lib/leads/oemPriceSweep");
        const r = await runOemPriceSweep({ warnDays: 14 });
        console.log(`        ${JSON.stringify(r)}`);
        check("the sweep completed without error", !r.error, r.error ?? "");
        console.log(
            "        Not undone by the cleanup below: the notification rows, the\n" +
                "        emails, and the one-week cooldown stamp. To re-arm:\n" +
                "        DELETE FROM app_settings WHERE key = 'oem_price_missing_notified_at';",
        );
    } else {
        console.log(
            "\n7. Skipped the real sweep — detection was checked above without it.\n" +
                "   Pass --sweep to actually notify. Note it EMAILS every active ceo/admin.",
        );
    }
}

async function cleanup() {
    if (inserted.length === 0 && snapshot.length === 0) return;
    console.log("\nCleaning up…");
    try {
        // Delete only rows this run inserted. deleteScheduledOemPrice refuses
        // in-force lines by design, so go straight at the table.
        if (inserted.length > 0) {
            await db
                .delete(oemReferencePrices)
                .where(inArray(oemReferencePrices.price_id, inserted));
        }
        // Put back what setOemPrice may have closed or the sweep may have
        // stamped on rows that were already here.
        for (const row of snapshot) {
            await db
                .update(oemReferencePrices)
                .set({
                    effective_to: row.effective_to,
                    expiry_notified_at: row.expiry_notified_at,
                })
                .where(eq(oemReferencePrices.price_id, row.price_id));
        }

        console.log(
            `  removed ${inserted.length} test line(s), restored ${snapshot.length} pre-existing line(s).`,
        );
    } catch (e) {
        console.error(
            "  CLEANUP FAILED — these price ids are still in the table and must be " +
                `deleted by hand:\n  ${inserted.join("\n  ")}\n  ${e instanceof Error ? e.message : e}`,
        );
        failed += 1;
    }
}

main()
    .catch((e) => {
        console.error(`\nABORTED — ${e instanceof Error ? e.message : e}`);
        failed += 1;
    })
    .then(cleanup)
    .then(() => {
        console.log(`\n${passed} passed, ${failed} failed.`);
        process.exit(failed === 0 ? 0 : 1);
    });
