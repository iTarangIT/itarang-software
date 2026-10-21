/**
 * HANDOVER-A16 — one-off back-fill of product families onto invoice lines.
 *
 * Item mappings saved before 14 Oct cover only their own spelling: Invoice
 * Ledger › Item mapping shows the product family as mapped, but the family's
 * other spellings' lines stay unlinked, so gross margin and By SKU still count
 * them "not linked". This runs every saved mapping through the Item mapping
 * rules (reapplyFamilyMappings in src/lib/sales/vyaparImport.ts):
 *   1. writes the family key for a mapping that has none yet (the
 *      latest-saved spelling wins; existing family rows are never touched);
 *   2. stamps product / class on every line STILL without a product that a
 *      mapping reaches — exact spelling first, else its family. Lines that
 *      already have a product are never changed.
 *
 * Usage (DATABASE_URL picks the database):
 *   node --import tsx --env-file=.env.local scripts/backfill-item-families.ts            # dry run, writes nothing
 *   node --import tsx --env-file=.env.local scripts/backfill-item-families.ts --apply
 * For prod: export DATABASE_URL from .env.production first (an exported value
 * wins over --env-file).
 *
 * Idempotent: a second --apply finds nothing to write. Check afterwards that
 * Item mapping's mapped families and gross margin's "items not linked" agree.
 */
import { reapplyFamilyMappings } from "@/lib/sales/vyaparImport";

const APPLY = process.argv.slice(2).includes("--apply");

async function main() {
    const host = (() => {
        try {
            return new URL(process.env.DATABASE_URL ?? "").host || "(unset)";
        } catch {
            return "(unparseable DATABASE_URL)";
        }
    })();
    console.log(`${APPLY ? "APPLY" : "DRY RUN"} against ${host}\n`);

    const r = await reapplyFamilyMappings({ apply: APPLY });

    console.log(`Family keys to write: ${r.families_written.length}`);
    for (const f of r.families_written) {
        console.log(`  ${f.family_key}  ←  "${f.from_item}"  (${f.asset_type ?? "?"} ${f.product_id})`);
    }
    if (r.conflicts.length) {
        console.log(`\nFamilies whose spellings were mapped to different products (latest kept; each spelling keeps its own): ${r.conflicts.length}`);
        for (const c of r.conflicts) console.log(`  ${c.family_key}: kept "${c.kept}", also ${c.also.map((x) => `"${x}"`).join(", ")}`);
    }
    console.log(`\nLines ${APPLY ? "stamped" : "to stamp"}: ${r.lines_stamped} (${r.spellings_stamped} spellings)`);
    for (const p of r.by_product) console.log(`  ${p.asset_type ?? "?"} ${p.product_id}: ${p.lines} lines, ${p.spellings} spellings`);
    if (!APPLY) console.log("\nNothing written. Re-run with --apply to write.");
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
