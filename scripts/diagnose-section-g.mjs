#!/usr/bin/env node
// Diagnose why /api/lead/[id]/section-g-options is failing.
// Verifies the BRE query's preconditions against the live DB:
//   - dealer_nbfc_assignments table exists (migration E-012)
//   - nbfc_loan_products has every column the BRE selects
//     (migrations E-113 / E-114 / E-115 / E-130)
//   - nbfc table exists with the joined columns
//   - For a given dealer (CLI arg or env DIAG_DEALER_ID), how many active
//     assignments + active loan products would surface in Section G.
//
// Usage:
//   node scripts/diagnose-section-g.mjs           # schema check only
//   node scripts/diagnose-section-g.mjs 33        # also count dealer 33's assignments

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const raw = await readFile(resolve(process.cwd(), '.env.local'), 'utf8');
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["'](.*)["']$/, '$1');
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const REQUIRED_TABLES = ['nbfc', 'nbfc_loan_products', 'dealer_nbfc_assignments'];

// These are the columns the BRE's loadActiveProductsForDealer selects.
// Keep in sync with src/lib/bre/load-products.ts.
const REQUIRED_COLUMNS = {
  nbfc_loan_products: [
    'id',
    'nbfc_id',
    'product_name',
    'status',
    'eligible_battery_categories',
    'loan_amount_min',
    'loan_amount_max',
    'tenure_months_min',
    'tenure_months_max',
    'min_roi_pct',
    'max_roi_pct',
    'down_payment_pct',
    'active_locations',                       // E-114
    'processing_fee_owned_rupees',            // E-113
    'processing_fee_rented_rupees',           // E-113
    'health_life_insurance_owned_rupees',     // E-113
    'health_life_insurance_rented_rupees',    // E-113
    'disbursement_tat_hours',                 // E-113
    'min_credit_score',                       // E-113
    'max_credit_score',                       // E-115
    'cibil_required',                         // E-115
  ],
  nbfc: ['id', 'short_name', 'legal_name'],
  dealer_nbfc_assignments: ['dealer_id', 'nbfc_id', 'status'],
};

// Maps a missing-column to the migration that adds it. Used for the hint.
const COLUMN_TO_MIGRATION = {
  active_locations: 'E-114_loan_products_active_locations.sql',
  processing_fee_owned_rupees: 'E-113_loan_products_scheme_highlights.sql',
  processing_fee_rented_rupees: 'E-113_loan_products_scheme_highlights.sql',
  health_life_insurance_owned_rupees: 'E-113_loan_products_scheme_highlights.sql',
  health_life_insurance_rented_rupees: 'E-113_loan_products_scheme_highlights.sql',
  disbursement_tat_hours: 'E-113_loan_products_scheme_highlights.sql',
  min_credit_score: 'E-113_loan_products_scheme_highlights.sql',
  max_credit_score: 'E-115_loan_products_cibil_range.sql',
  cibil_required: 'E-115_loan_products_cibil_range.sql',
};

let problems = 0;

console.log('━━━ TABLES ━━━');
const tblRes = await client.query(
  `SELECT table_name
     FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY($1)`,
  [REQUIRED_TABLES],
);
const haveTables = new Set(tblRes.rows.map((r) => r.table_name));
for (const t of REQUIRED_TABLES) {
  if (haveTables.has(t)) {
    console.log(`  ✓ ${t}`);
  } else {
    console.log(`  ✗ ${t}  MISSING`);
    if (t === 'dealer_nbfc_assignments') {
      console.log('     -> apply drizzle/E-012_dealer_nbfc_assignments.sql');
    }
    problems += 1;
  }
}

console.log('\n━━━ COLUMNS ━━━');
for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
  if (!haveTables.has(table)) {
    console.log(`  (skipped ${table} — table missing)`);
    continue;
  }
  const res = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`,
    [table, cols],
  );
  const present = new Set(res.rows.map((r) => r.column_name));
  for (const col of cols) {
    if (present.has(col)) {
      console.log(`  ✓ ${table}.${col}`);
    } else {
      const mig = COLUMN_TO_MIGRATION[col];
      console.log(
        `  ✗ ${table}.${col}  MISSING${mig ? `  -> apply drizzle/${mig}` : ''}`,
      );
      problems += 1;
    }
  }
}

// Argument can be:
//   - integer:    dealers.id
//   - "DLR-..." or any varchar:  dealers.dealer_id
//   - UUID:       dealers.application_id (used by /admin/dealer-verification/[uuid])
const dealerArg = process.argv[2] || process.env.DIAG_DEALER_ID;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (dealerArg && problems === 0) {
  let dealerRow = null;
  if (/^\d+$/.test(dealerArg)) {
    const r = await client.query(
      `SELECT id, dealer_id, application_id, company_name, onboarding_status
         FROM dealers WHERE id = $1 LIMIT 1`,
      [Number(dealerArg)],
    );
    dealerRow = r.rows[0] ?? null;
    console.log(`\n━━━ DEALER (by id=${dealerArg}) ━━━`);
  } else if (UUID_RE.test(dealerArg)) {
    const r = await client.query(
      `SELECT id, dealer_id, application_id, company_name, onboarding_status
         FROM dealers WHERE application_id = $1 LIMIT 1`,
      [dealerArg],
    );
    dealerRow = r.rows[0] ?? null;
    console.log(`\n━━━ DEALER (by application_id=${dealerArg}) ━━━`);
  } else {
    const r = await client.query(
      `SELECT id, dealer_id, application_id, company_name, onboarding_status
         FROM dealers WHERE dealer_id = $1 LIMIT 1`,
      [dealerArg],
    );
    dealerRow = r.rows[0] ?? null;
    console.log(`\n━━━ DEALER (by dealer_id='${dealerArg}') ━━━`);
  }

  if (!dealerRow) {
    console.log(`  ✗ no dealers row matched.`);
    console.log(`     -> for a pre-activation onboarding application, no dealers row exists yet.`);
    console.log(`     -> activate via /admin/dealer-verification/<uuid> first.`);
  } else {
    console.log(`  ✓ dealers.id            = ${dealerRow.id}`);
    console.log(`    dealers.dealer_id     = ${dealerRow.dealer_id ?? '(null — pre-activation)'}`);
    console.log(`    dealers.application_id= ${dealerRow.application_id ?? '(null)'}`);
    console.log(`    dealers.company_name  = ${dealerRow.company_name}`);
    console.log(`    onboarding_status     = ${dealerRow.onboarding_status}`);

    if (!dealerRow.dealer_id) {
      console.log(`\n  ⚠ this dealer has NULL dealer_id. Section G's lookup is`);
      console.log(`     WHERE dealers.dealer_id = <session.dealer_id> — that lookup`);
      console.log(`     CANNOT match a NULL row. The logged-in dealer will see an`);
      console.log(`     empty Section G regardless of how many NBFCs are assigned.`);
      console.log(`     -> Complete activation in /admin/dealer-verification/<uuid>`);
      console.log(`        so dealer_id (e.g. "DLR-001") gets populated.`);
    }

    const { rows: assignRows } = await client.query(
      `SELECT dna.id, dna.status, dna.nbfc_id, n.short_name, n.legal_name, n.status AS nbfc_status
         FROM dealer_nbfc_assignments dna
         JOIN nbfc n ON n.id = dna.nbfc_id
        WHERE dna.dealer_id = $1
        ORDER BY dna.id`,
      [dealerRow.id],
    );
    console.log(`\n  Assignments on dealer.id=${dealerRow.id}: ${assignRows.length}`);
    for (const r of assignRows) {
      console.log(`    [${r.status.padEnd(11)}] nbfc.id=${r.nbfc_id} (${r.nbfc_status})  ${r.short_name} — ${r.legal_name}`);
    }
    if (assignRows.length === 0) {
      console.log(`     -> assign NBFCs in /admin/dealer-verification/<uuid>/nbfcs`);
    }

    const activeAssigned = assignRows.filter((r) => r.status === 'active');
    if (activeAssigned.length > 0) {
      const { rows: productRows } = await client.query(
        `SELECT lp.nbfc_id, n.short_name,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE lp.status = 'active') AS active_count
           FROM nbfc_loan_products lp
           JOIN nbfc n ON n.id = lp.nbfc_id
           JOIN dealer_nbfc_assignments dna ON dna.nbfc_id = lp.nbfc_id
          WHERE dna.dealer_id = $1 AND dna.status = 'active'
          GROUP BY lp.nbfc_id, n.short_name
          ORDER BY n.short_name`,
        [dealerRow.id],
      );
      console.log(`\n  Loan products per active-assigned NBFC:`);
      for (const r of productRows) {
        const flag = r.active_count > 0 ? '✓' : '⚠';
        console.log(`    ${flag} ${r.short_name.padEnd(20)} active=${r.active_count}  total=${r.total}`);
        if (r.active_count === 0) {
          console.log(`       -> Section G hides this NBFC: no active loan products.`);
          console.log(`          create products in the admin loan-products UI.`);
        }
      }
      if (productRows.length < activeAssigned.length) {
        console.log(`    ⚠ ${activeAssigned.length - productRows.length} active assignment(s) have zero loan products on the NBFC at all — won't appear on Section G.`);
      }

      // Dump each active loan product's BRE-relevant constraints so we can
      // tell at a glance which gate is filtering Section G to empty.
      const { rows: prodDetails } = await client.query(
        `SELECT lp.id, lp.product_name, n.short_name,
                lp.eligible_battery_categories, lp.active_locations,
                lp.loan_amount_min, lp.loan_amount_max,
                lp.cibil_required, lp.min_credit_score, lp.max_credit_score
           FROM nbfc_loan_products lp
           JOIN nbfc n ON n.id = lp.nbfc_id
           JOIN dealer_nbfc_assignments dna ON dna.nbfc_id = lp.nbfc_id
          WHERE dna.dealer_id = $1 AND dna.status = 'active' AND lp.status = 'active'
          ORDER BY n.short_name, lp.id`,
        [dealerRow.id],
      );
      if (prodDetails.length > 0) {
        console.log(`\n  ━━━ Active loan-product constraints (what the BRE filters on) ━━━`);
        for (const p of prodDetails) {
          console.log(`    [${p.short_name}] product#${p.id} "${p.product_name}"`);
          const cats = Array.isArray(p.eligible_battery_categories) ? p.eligible_battery_categories : [];
          const locs = Array.isArray(p.active_locations) ? p.active_locations : [];
          console.log(`      eligible_battery_categories : ${cats.length === 0 ? '(empty — matches ANY category)' : JSON.stringify(cats)}`);
          console.log(`      active_locations             : ${locs.length === 0 ? '(empty — matches ANY location)' : JSON.stringify(locs)}`);
          console.log(`      loan_amount band             : ₹${p.loan_amount_min} – ₹${p.loan_amount_max}`);
          console.log(`      cibil_required               : ${p.cibil_required}`);
        }
      }
    }
  }
} else if (!dealerArg) {
  console.log('\n(pass a dealer identifier — id, dealer_id code, or application UUID — to probe assignments:');
  console.log('   node scripts/diagnose-section-g.mjs 33');
  console.log('   node scripts/diagnose-section-g.mjs DLR-001');
  console.log('   node scripts/diagnose-section-g.mjs e3598af6-4640-463d-adb8-75b41a55fb11)');
  console.log('  optionally pass a lead id as a 2nd arg to compare lead profile vs BRE gates:');
  console.log('   node scripts/diagnose-section-g.mjs 33 LEAD-20260526-e69dfc29');
}

// Lead profile probe — what the matcher actually sees from the customer side.
const leadArg = process.argv[3] || process.env.DIAG_LEAD_ID;
if (leadArg && problems === 0) {
  console.log(`\n━━━ LEAD ${leadArg} ━━━`);
  const { rows: leadRows } = await client.query(
    `SELECT id, dealer_id, full_name, state, city,
            product_category_id, resident_status, payment_method
       FROM leads WHERE id = $1 LIMIT 1`,
    [leadArg],
  );
  if (leadRows.length === 0) {
    console.log(`  ✗ no leads row matched id='${leadArg}'`);
  } else {
    const lead = leadRows[0];
    console.log(`  lead.dealer_id (varchar)   : ${lead.dealer_id}`);
    console.log(`  full_name                  : ${lead.full_name ?? '(null)'}`);
    console.log(`  state / city               : ${lead.state ?? '(null)'} / ${lead.city ?? '(null)'}`);
    console.log(`  product_category_id        : ${lead.product_category_id ?? '(null)'}`);
    console.log(`  resident_status            : ${lead.resident_status ?? '(null)'}`);
    console.log(`  payment_method             : ${lead.payment_method ?? '(null)'}`);
    console.log(`\n  -> The BRE filters each loan product against these values:`);
    console.log(`     - if product.eligible_battery_categories is non-empty AND product_category_id is not in it -> EXCLUDED`);
    console.log(`     - if product.active_locations is non-empty AND no entry matches state/city -> EXCLUDED`);
    console.log(`     Compare the product constraints printed above with this lead profile.`);
  }
}

await client.end();

console.log('');
if (problems === 0) {
  console.log('OK — schema is sufficient for the BRE query.');
  process.exit(0);
} else {
  console.log(`FAIL — ${problems} problem(s) found. Apply the migration(s) listed above and re-run.`);
  process.exit(1);
}
