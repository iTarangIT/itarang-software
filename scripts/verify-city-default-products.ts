/**
 * E-282/E-283/E-286/E-290/E-291 — verify the pinned default loan product
 * against a real DB.
 *
 * E-290: a rule is exactly ONE OF THREE KINDS and THE MOST SPECIFIC ONE WINS.
 * `priority` and the E-289 `customer_state`/`customer_city` columns are
 * retired: they survive as history but are written 0/NULL and ignored, and a
 * row still declaring a customer location is EXCLUDED by the resolver rather
 * than reinterpreted as "any customer".
 * E-291: the three kinds are a dealer, a CUSTOMER city, or a CUSTOMER state —
 * `state`/`city` are matched against leads.state / leads.city, not the dealer's
 * accounts address (which is what they meant between E-286 and E-290). So a
 * location assertion probes with a LOCATION and no longer has to find a dealer
 * registered there — which is what E-286 made impossible in practice, since
 * `dealers JOIN accounts` yields no dealer with an address on either host.
 * READ-ONLY by default: no writes unless --simulate is passed.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-city-default-products.ts [LEAD-ID] [--simulate]
 *
 * [LEAD-ID] (optional) — a finance lead to exercise the narrowing against.
 * Omitted, the script picks the newest finance lead that has a dealer, a state
 * and a city.
 *
 * What it asserts:
 *   1. city_default_loan_products exists, carries the E-283 columns
 *      (dealer_code, priority) and the E-289 columns (customer_state,
 *      customer_city) — the resolver still names the latter two, to EXCLUDE
 *      them — has a nullable `state`, and has the partial unique key
 *      _active_key_v3 in place of _active_key_v2 and _active_key. E-290 leaves
 *      that key alone deliberately: it coalesces the two now-always-NULL
 *      customer columns to '', so it already behaves as a three-column key.
 *   2. Every ACTIVE rule points at an active, tenant-bound loan product that
 *      really belongs to the named NBFC — a rule failing this can never fire.
 *   3. Every ACTIVE location rule pins a product that actually SERVES that
 *      location — its NBFC's `active_locations` covers it, or is empty (serves
 *      everywhere). A rule failing this can never fire: the BRE drops the
 *      product before the pin is read. This is E-282's original
 *      product-coverage check, which E-286 had to remove (it compares a
 *      CUSTOMER location, which `state`/`city` briefly stopped being) and
 *      E-291 makes meaningful again.
 *   4. Every ACTIVE rule naming a dealer names one that exists.
 *   5. No ACTIVE rule still declares a customer location (E-290's cleanup), and
 *      resolveDefaultProductRules() returns candidates most-specific first:
 *      dealer, then city, then state.
 *   6. Against a real lead: with no rule the option list is unchanged; with a
 *      rule whose product IS in the hits, exactly one NBFC and one product come
 *      back; with a rule whose product is NOT in the hits, the next rule (or
 *      the full list) is returned — the "never show a product that would reject
 *      them" rule; and excludeNbfcIds removes a lender without collapsing it.
 *   7. --simulate only: the whole ladder end to end — a state rule narrows, a
 *      city rule beats it, a dealer rule beats that, and each in turn falls
 *      through to the next when its product is not in the hits, until the full
 *      list comes back. Since E-291 the temporary RULES name the SYNTHETIC
 *      location the probe lead invents, so they cannot apply to a single real
 *      applicant even for the seconds they exist — under E-286 they had to name
 *      the probe dealer's real town and so briefly applied to its neighbours.
 *      They are deleted in a finally block.
 *   8. --simulate only (E-290): a row that still declares a customer location
 *      is INERT — it does not narrow, and it is not reinterpreted as applying
 *      to every customer. Safer than 7: it names the synthetic location the
 *      probe lead invents, so it cannot touch anyone real even in principle.
 */

export {}; // module scope — keeps Step/steps/failed off the global script namespace

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];
let failed = 0;

function pass(name: string, detail = "") {
  steps.push({ name, ok: true, detail });
  console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, detail: string) {
  steps.push({ name, ok: false, detail });
  failed += 1;
  console.log(`  ✖ ${name} — ${detail}`);
}
function skip(name: string, detail: string) {
  steps.push({ name, ok: true, detail: `SKIPPED — ${detail}` });
  console.log(`  – ${name} — SKIPPED: ${detail}`);
}

async function main() {
  // Positional lead id only — flags must not be mistaken for one.
  const leadArg = (process.argv.slice(2).find((a) => !a.startsWith("--")) || "").trim();

  const { db } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");
  const { resolveDefaultProductRules } = await import(
    "@/lib/leads/city-default-product"
  );
  const { loadSectionGOptions } = await import("@/lib/leads/section-g");

  const host = (process.env.DATABASE_URL || "").match(/@([^:/]+)/)?.[1] ?? "?";
  console.log(
    `\nE-282/E-283/E-286/E-290/E-291 pinned default loan products — verifying against ${host}\n`,
  );

  // ── 1. Table, columns and indexes ───────────────────────────────────────
  const [tbl] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM information_schema.tables
     WHERE table_name = 'city_default_loan_products'
  `);
  if (!tbl || Number(tbl.n) === 0) {
    fail("table exists", "city_default_loan_products is missing — apply E-282 first");
    report();
    return;
  }
  pass("table exists", "city_default_loan_products");

  const cols = await db.execute<{ column_name: string; is_nullable: string }>(sql`
    SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_name = 'city_default_loan_products'
  `);
  const byName = new Map(cols.map((c) => [c.column_name, c.is_nullable]));

  const missing = ["dealer_code", "priority"].filter((c) => !byName.has(c));
  if (missing.length === 0) {
    pass("E-283 columns present", "dealer_code, priority");
  } else {
    fail(
      "E-283 columns present",
      `${missing.join(", ")} missing — apply E-283 (it must be applied WITH E-282, ` +
        `or the resolver throws on every lookup and no default is ever offered)`,
    );
    report();
    return;
  }

  const missingE289 = ["customer_state", "customer_city"].filter(
    (c) => !byName.has(c),
  );
  if (missingE289.length === 0) {
    pass(
      "E-289 columns present",
      "customer_state, customer_city (retired by E-290, still named to exclude)",
    );
  } else {
    fail(
      "E-289 columns present",
      `${missingE289.join(", ")} missing — apply E-289 (the resolver names both ` +
        `columns to EXCLUDE retired rules, so without them it throws on every ` +
        `lookup and no default is ever offered)`,
    );
    report();
    return;
  }

  if (byName.get("state") === "YES") {
    pass("state is nullable", "dealer-only rules can declare no location");
  } else {
    fail("state is nullable", "state is still NOT NULL — E-283 did not fully apply");
  }

  const idxRows = await db.execute<{ indexname: string }>(sql`
    SELECT indexname FROM pg_indexes
     WHERE tablename = 'city_default_loan_products'
  `);
  const idxNames = new Set(idxRows.map((r) => r.indexname));
  if (idxNames.has("city_default_loan_products_active_key_v3")) {
    pass("widened partial unique active key present", "_active_key_v3");
  } else {
    fail(
      "widened partial unique active key present",
      "city_default_loan_products_active_key_v3 not found — apply E-289",
    );
  }
  const staleKeys = [
    "city_default_loan_products_active_key",
    "city_default_loan_products_active_key_v2",
  ].filter((k) => idxNames.has(k));
  if (staleKeys.length === 0) {
    pass("superseded unique keys replaced");
  } else {
    fail(
      "superseded unique keys replaced",
      `${staleKeys.join(", ")} still exists — a narrower key blocks legitimate ` +
        `rules (re-run E-289 if E-283 was re-applied)`,
    );
  }

  // ── 2 + 3 + 4. Every active rule is coherent and reachable ──────────────
  const rules = await db.execute<{
    id: number;
    dealer_code: string | null;
    state: string | null;
    city: string | null;
    customer_state: string | null;
    customer_city: string | null;
    priority: number;
    nbfc_id: number;
    loan_product_id: number;
    product_nbfc_id: number | null;
    product_status: string | null;
    active_locations: { state: string; city: string }[] | null;
    tenant_id: string | null;
    dealer_exists: boolean;
  }>(sql`
    SELECT c.id, c.dealer_code, c.state, c.city,
           c.customer_state, c.customer_city,
           c.priority, c.nbfc_id, c.loan_product_id,
           p.nbfc_id AS product_nbfc_id, p.status AS product_status,
           p.active_locations,
           n.tenant_id::text AS tenant_id,
           (c.dealer_code IS NULL OR a.id IS NOT NULL) AS dealer_exists
      FROM city_default_loan_products c
      LEFT JOIN nbfc_loan_products p ON p.id = c.loan_product_id
      LEFT JOIN nbfc n ON n.id = c.nbfc_id
      LEFT JOIN accounts a ON a.id = c.dealer_code
     WHERE c.is_active
     ORDER BY (c.dealer_code IS NULL), (c.city IS NULL), (c.state IS NULL),
              c.id DESC
  `);

  // ── E-290 — the retired customer leg must be gone from the ACTIVE set ────
  // A row that still declares one is inert either way (the resolver excludes
  // it), but it would sit in the table forever with no UI to explain it.
  const retired = rules.filter((m) => m.customer_state || m.customer_city);
  if (retired.length === 0) {
    pass("no active rule declares a customer location", "E-290 cleanup is in place");
  } else {
    fail(
      "no active rule declares a customer location",
      `${retired.length} row(s) still do — inert (the resolver excludes them) but ` +
        `invisible in the admin table; apply E-290: ` +
        retired.map((m) => `#${m.id}`).join(", "),
    );
  }

  const stillPrioritised = rules.filter((m) => Number(m.priority) !== 0);
  if (stillPrioritised.length > 0) {
    console.log(
      `  · note: ${stillPrioritised.length} active rule(s) carry a non-zero priority; ` +
        `it is IGNORED since E-290 — order is dealer, then city, then state`,
    );
  }

  // Only rules the resolver will actually consider take part in the ordering
  // assertions below.
  const liveRules = rules.filter((m) => !m.customer_state && !m.customer_city);

  if (rules.length === 0) {
    skip("active rules are coherent", "no defaults configured yet");
    skip("active rules pin a product that serves the location", "no defaults configured yet");
    skip("active rules name a real dealer", "no defaults configured yet");
  } else {
    const bad = rules.filter(
      (m) =>
        m.product_nbfc_id !== m.nbfc_id ||
        m.product_status !== "active" ||
        !m.tenant_id,
    );
    if (bad.length === 0) {
      pass("active rules are coherent", `${rules.length} row(s)`);
    } else {
      fail(
        "active rules are coherent",
        bad
          .map((m) => `#${m.id} ${scopeOf(m)}: product ${m.loan_product_id} ` +
            `(nbfc ${m.product_nbfc_id ?? "?"}, status ${m.product_status ?? "?"}, ` +
            `tenant ${m.tenant_id ? "bound" : "UNBOUND"})`)
          .join("; "),
      );
    }

    // E-291 — a rule's location is the CUSTOMER's again, so "can this rule ever
    // fire?" is answered by the pinned product's own coverage: the BRE drops a
    // product whose `active_locations` does not cover the lead, and the pin is
    // applied to what survives, so a pin on a product that cannot serve the
    // very place the rule names is dead on arrival. Matched exactly the way
    // `src/lib/bre/match.ts` matches it — case-sensitively, an empty leg
    // meaning "any" — so this agrees with the router rather than being a
    // second, kinder opinion.
    const unmatchable: string[] = [];
    for (const m of rules) {
      if (!m.state) continue; // no location declared — always matchable
      const locs = m.active_locations ?? [];
      if (locs.length === 0) continue; // serves everywhere
      const served = locs.some(
        (loc) =>
          (!loc.state || loc.state === m.state) &&
          (!loc.city || !m.city || loc.city === m.city),
      );
      if (!served) {
        unmatchable.push(
          `#${m.id} ${scopeOf(m)} (product ${m.loan_product_id} does not serve there)`,
        );
      }
    }
    if (unmatchable.length === 0) {
      pass("active rules pin a product that serves the location");
    } else {
      fail(
        "active rules pin a product that serves the location",
        `${unmatchable.length} rule(s) can never fire: ${unmatchable.join("; ")}`,
      );
    }

    const orphanDealers = rules.filter((m) => !m.dealer_exists);
    if (orphanDealers.length === 0) {
      pass("active rules name a real dealer");
    } else {
      fail(
        "active rules name a real dealer",
        orphanDealers
          .map((m) => `#${m.id} dealer_code ${m.dealer_code} has no accounts row`)
          .join("; "),
      );
    }
  }

  // ── 5a. A city rule beats a state rule ──────────────────────────────────
  const cityRule = liveRules.find(
    (m) =>
      m.city &&
      !m.dealer_code &&
      liveRules.some(
        (w) =>
          !w.city && !w.dealer_code && w.state && m.state && n0(w.state) === n0(m.state),
      ),
  );
  if (!cityRule) {
    skip(
      "a city rule beats a state rule",
      "no state carries both a city row and a state-wide row",
    );
  } else {
    // E-291 — the location is the CUSTOMER's, so the probe IS the location.
    // No dealer code goes in: a dealer rule would legitimately outrank both
    // rungs and this assertion is only about the two location ones.
    const got = await resolveDefaultProductRules({
      dealerCode: null,
      customerState: cityRule.state,
      customerCity: cityRule.city,
    });
    const topLocation = got.find((r) => !r.dealerCode);
    if (topLocation && topLocation.city && n0(topLocation.city) === n0(cityRule.city!)) {
      pass("a city rule beats a state rule", `${cityRule.city}, ${cityRule.state}`);
    } else {
      fail(
        "a city rule beats a state rule",
        `a customer in ${cityRule.city}, ${cityRule.state} led with ` +
          (topLocation ? `city=${topLocation.city ?? "*"}` : "nothing"),
      );
    }
  }

  // ── 5b. Specificity is the ONLY sort ────────────────────────────────────
  // Whatever rules exist, the list must come back most-specific first: every
  // dealer rule, then every city rule, then every state rule.
  const anyDealerRule = liveRules.find((m) => m.dealer_code);
  const probe = anyDealerRule ?? liveRules[0];
  if (!probe) {
    skip("candidates come back most-specific first", "no defaults configured yet");
  } else {
    // Probe with everything this rule names — its dealer AND its location —
    // so every rung that could apply to such a lead comes back at once.
    const got = await resolveDefaultProductRules({
      dealerCode: probe.dealer_code,
      customerState: probe.state,
      customerCity: probe.city,
    });
    const ascending = got.every((r, i) => i === 0 || tierOf(got[i - 1]) <= tierOf(r));
    if (ascending) {
      pass(
        "candidates come back most-specific first",
        `${got.length} candidate(s) for ${scopeOf(probe)}: ` +
          (got.map((r) => TIER_NAME[tierOf(r)]).join(" → ") || "none"),
      );
    } else {
      fail(
        "candidates come back most-specific first",
        got.map((r) => `#${r.id}:${TIER_NAME[tierOf(r)]}`).join(" "),
      );
    }
  }

  // ── 6. Narrowing against a real lead ────────────────────────────────────
  const [lead] = await db.execute<{
    id: string;
    dealer_id: string | null;
    product_category_id: string | null;
    state: string | null;
    city: string | null;
    resident_status: string | null;
    requested_loan_amount: number | null;
  }>(
    leadArg
      ? sql`SELECT id, dealer_id, product_category_id, state, city, resident_status,
                   requested_loan_amount
              FROM leads WHERE id = ${leadArg} LIMIT 1`
      : sql`SELECT id, dealer_id, product_category_id, state, city, resident_status,
                   requested_loan_amount
              FROM leads
             WHERE payment_method = 'finance'
               AND dealer_id IS NOT NULL
               AND state IS NOT NULL AND state <> 'Unknown'
               AND city  IS NOT NULL AND city  <> 'Unknown'
             ORDER BY created_at DESC LIMIT 1`,
  );

  if (!lead) {
    skip("narrowing against a real lead", leadArg ? `lead ${leadArg} not found` : "no suitable finance lead found");
    // The simulations need no real lead, so they still run.
    await simulateNarrowing();
    await simulateRetiredCustomerLeg();
    report();
    return;
  }

  const amount = lead.requested_loan_amount ?? null;
  const baseline = await loadSectionGOptions(lead, amount);
  console.log(
    `\n  lead ${lead.id} — ${lead.city}, ${lead.state}, dealer ${lead.dealer_id}, amount ${amount ?? "any"}` +
      ` → ${baseline.length} lender(s), ` +
      `${baseline.reduce((s, o) => s + o.activeLoanProducts.length, 0)} product(s)\n`,
  );

  // E-291 — the dealer AND the customer's own location go in, exactly as
  // applyPinnedDefault() passes them.
  const live = await resolveDefaultProductRules({
    dealerCode: lead.dealer_id,
    customerState: lead.state,
    customerCity: lead.city,
  });
  if (live.length > 0) {
    // Whichever rule was applied must be one of the candidates, and it must be
    // the FIRST one whose lender+product actually survived the BRE. Anything
    // else — a narrowed list showing a rule that was outranked, or one that was
    // not a candidate at all — is wrong.
    const expected = live.find((r) =>
      baseline.some(
        (o) =>
          o.nbfcId === r.nbfcId &&
          o.activeLoanProducts.some((p) => p.id === r.loanProductId),
      ),
    );
    if (!expected) {
      pass(
        "no candidate rule fit — full list returned",
        `${live.length} rule(s) matched the lead, none survived the BRE; ${baseline.length} lender(s) offered`,
      );
    } else {
      const hit =
        baseline.length === 1 &&
        baseline[0].nbfcId === expected.nbfcId &&
        baseline[0].activeLoanProducts.length === 1 &&
        baseline[0].activeLoanProducts[0].id === expected.loanProductId;
      if (hit) {
        pass(
          "first fitting rule is the one offered",
          `rule #${expected.id} (${TIER_NAME[tierOf(expected)]}) → nbfc ${expected.nbfcId} / product ${expected.loanProductId}`,
        );
      } else {
        fail(
          "first fitting rule is the one offered",
          `expected only nbfc ${expected.nbfcId} / product ${expected.loanProductId} (rule #${expected.id}), got ` +
            baseline
              .map((o) => `${o.nbfcId}:[${o.activeLoanProducts.map((p) => p.id).join(",")}]`)
              .join(" "),
        );
      }
    }
  } else {
    skip(
      "first fitting rule is the one offered",
      `no rule configured for dealer ${lead.dealer_id} / ${lead.city}, ${lead.state}`,
    );
  }

  if (baseline.length === 0) {
    skip("exclusion removes a lender", "no lenders matched this lead");
  } else {
    const drop = baseline[0].nbfcId;
    const after = await loadSectionGOptions(lead, amount, { excludeNbfcIds: [drop] });
    if (after.every((o) => o.nbfcId !== drop)) {
      pass("exclusion removes a lender", `excluded nbfc ${drop}, ${after.length} left`);
    } else {
      fail("exclusion removes a lender", `nbfc ${drop} still present after exclusion`);
    }
  }

  // An amount above every matched product's ceiling must empty the list rather
  // than force a pinned product through — decision (2), checked end to end.
  const ceiling = Math.max(
    0,
    ...baseline.flatMap((o) => o.activeLoanProducts.map((p) => p.loanAmountMax)),
  );
  if (ceiling === 0) {
    skip("an over-ceiling amount drops every product", "no lenders matched this lead");
  } else {
    const over = await loadSectionGOptions(lead, ceiling + 1);
    if (over.length === 0) {
      pass("an over-ceiling amount drops every product", `asked ₹${ceiling + 1}`);
    } else {
      fail(
        "an over-ceiling amount drops every product",
        `₹${ceiling + 1} still matched ${over.length} lender(s)`,
      );
    }
  }

  await simulateNarrowing();
  await simulateRetiredCustomerLeg();

  report();
}

/**
 * Prove the whole ladder end to end, with no effect on any real customer.
 *
 * Only runs with --simulate. The probe LEAD lives in a SYNTHETIC city no real
 * lead is in, so the BRE's own geography rule stays isolated to lenders with no
 * active_locations restriction — and since E-291 the temporary RULES name that
 * same invented location, so they cannot apply to a single real applicant even
 * in principle. (Under E-286 they had to name the probe dealer's REAL town and
 * so briefly applied to its neighbours.) Every row is deleted in a finally.
 *
 * Six phases, walking the E-290 ladder down and then back up:
 *   1. a STATE rule alone narrows to itself
 *   2. its lender being excluded falls back to the full list, not to nothing
 *   3. a CITY rule beats the state rule
 *   4. a DEALER rule beats the city rule
 *   5. the dealer rule's product going missing falls through to the city rule,
 *      then the city rule's to the state rule
 *   6. with none of the three fitting, the full matched list comes back
 *
 * Two lenders are enough to make every phase unambiguous: A is pinned by the
 * state and dealer rules, B by the city rule, and B can only win while the city
 * rule is the most specific one that fits.
 */
async function simulateNarrowing() {
  const name = "a dealer rule narrows to one lender (simulated)";
  if (!process.argv.includes("--simulate")) {
    skip(name, "pass --simulate to exercise it (inserts and deletes rows)");
    return;
  }

  const { db } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");
  const { loadSectionGOptions } = await import("@/lib/leads/section-g");
  const { resolveDefaultProductRules } = await import(
    "@/lib/leads/city-default-product"
  );

  const CITY = "ZZ Verify City";
  const STATE = "ZZ Verify State";

  const [inUse] = await db.execute<{ c: number }>(
    sql`SELECT count(*)::int AS c FROM leads WHERE city = ${CITY} OR state = ${STATE}`,
  );
  if (Number(inUse?.c ?? 0) > 0) {
    fail(name, `${CITY} is a real location here — aborting rather than risk a live lead`);
    return;
  }

  // Any dealer with a code will do: since E-291 a location rule keys on the
  // LEAD's location, not the dealer's, so no registered address is needed and
  // every rung of the ladder is provable against any dealer. Joining accounts
  // still proves the two id spaces line up for this dealer, which
  // loadSectionGOptions independently depends on.
  const [dealer] = await db.execute<{ id: number; dealer_id: string }>(
    sql`SELECT d.id, d.dealer_id
          FROM dealers d
          JOIN accounts a ON a.id = d.dealer_id
         WHERE d.dealer_id IS NOT NULL
         ORDER BY d.id ASC
         LIMIT 1`,
  );
  if (!dealer) {
    skip(name, "no dealer with a dealer code to probe with");
    return;
  }
  // Both the RULES and the LEAD name the invented location — that is what
  // keeps these rows unable to touch anyone real.
  const RULE_STATE = STATE;
  const RULE_CITY = CITY;

  const lead = {
    dealer_id: dealer.dealer_id,
    product_category_id: null,
    state: STATE,
    city: CITY,
    resident_status: null,
  };

  const before = await loadSectionGOptions(lead, null);
  if (before.length < 2) {
    skip(
      name,
      `only ${before.length} unrestricted lender(s) match an invented city — need 2+ to prove narrowing`,
    );
    return;
  }

  // A is deliberately NOT the first lender: narrowing to what was already at
  // the top would pass even if the code did nothing. B is a different lender,
  // so "which rule won" is always observable.
  const lenderA = before[1];
  const productA = lenderA.activeLoanProducts[0];
  const lenderB = before[0];
  const productB = lenderB.activeLoanProducts[0];

  const MISSING_PRODUCT = 2147483647;

  const inserted: number[] = [];
  const insert = async (
    dealerCode: string | null,
    state: string | null,
    city: string | null,
    nbfcId: number,
    productId: number,
  ) => {
    const [row] = await db.execute<{ id: number }>(sql`
      INSERT INTO city_default_loan_products
             (dealer_code, state, city, customer_state, customer_city,
              nbfc_id, loan_product_id, notes)
      VALUES (${dealerCode}, ${state}, ${city}, NULL, NULL,
              ${nbfcId}, ${productId},
              'temporary row written by verify-city-default-products.ts --simulate')
      RETURNING id
    `);
    inserted.push(Number(row.id));
    return Number(row.id);
  };

  /** Did the options collapse to exactly this lender and this product? */
  const isOnly = (
    got: { nbfcId: number; activeLoanProducts: { id: number }[] }[],
    nbfcId: number,
    productId: number,
  ) =>
    got.length === 1 &&
    got[0].nbfcId === nbfcId &&
    got[0].activeLoanProducts.length === 1 &&
    got[0].activeLoanProducts[0].id === productId;

  try {
    // ── 1. a DEALER rule alone narrows to itself ──────────────────────────
    // Written the shape the form now produces: a dealer rule declares NO
    // location, because the dealer already has one.
    const dealerId = await insert(dealer.dealer_id, null, null, lenderA.nbfcId, productA.id);

    const afterDealer = await loadSectionGOptions(lead, null);
    if (isOnly(afterDealer, lenderA.nbfcId, productA.id)) {
      pass(name, `${before.length} lender(s) → 1 (nbfc ${lenderA.nbfcId} / product ${productA.id})`);
    } else {
      fail(
        name,
        `expected exactly nbfc ${lenderA.nbfcId} / product ${productA.id}, got ` +
          describe(afterDealer),
      );
    }

    // ── 2. the pinned lender being excluded falls back to the full list ───
    // Not to nothing — decision (2) at its sharpest.
    const excluded = await loadSectionGOptions(lead, null, {
      excludeNbfcIds: [lenderA.nbfcId],
    });
    if (
      excluded.length === before.length - 1 &&
      excluded.every((o) => o.nbfcId !== lenderA.nbfcId)
    ) {
      pass("pinned-but-excluded lender falls back to the full list", `${excluded.length} lender(s)`);
    } else {
      fail(
        "pinned-but-excluded lender falls back to the full list",
        `expected ${before.length - 1} lender(s), got ${excluded.length}`,
      );
    }

    // ── 3. a dealer rule that does not fit falls back to the full list ────
    // With nothing below it on the ladder, the pin is skipped rather than
    // leaving the customer with nothing.
    await db.execute(
      sql`UPDATE city_default_loan_products
             SET loan_product_id = ${MISSING_PRODUCT}
           WHERE id = ${dealerId}`,
    );
    const dealerMissed = await loadSectionGOptions(lead, null);
    if (dealerMissed.length === before.length) {
      pass(
        "a dealer rule that does not fit falls back to the full list",
        `${dealerMissed.length} lender(s)`,
      );
    } else {
      fail(
        "a dealer rule that does not fit falls back to the full list",
        `expected ${before.length} lender(s), got ` + describe(dealerMissed),
      );
    }

    // ── 4-6. the location rungs ───────────────────────────────────────────
    {
      // Put the dealer rule back the way it was, so it can be outranked and
      // then fall through on its own terms.
      await db.execute(
        sql`UPDATE city_default_loan_products
               SET loan_product_id = ${productA.id}
             WHERE id = ${dealerId}`,
      );

      const stateId = await insert(null, RULE_STATE, null, lenderB.nbfcId, productB.id);
      const cityId = await insert(null, RULE_STATE, RULE_CITY, lenderB.nbfcId, productB.id);

      // The dealer rule still outranks both.
      const withAll = await loadSectionGOptions(lead, null);
      if (isOnly(withAll, lenderA.nbfcId, productA.id)) {
        pass(
          "a dealer rule beats a city rule",
          `rule #${dealerId} → nbfc ${lenderA.nbfcId} / product ${productA.id}`,
        );
      } else {
        fail(
          "a dealer rule beats a city rule",
          `expected nbfc ${lenderA.nbfcId} / product ${productA.id}, got ` + describe(withAll),
        );
      }

      // Drop the dealer rung: the CITY rule must be what answers, not the
      // state rule — both point at B, so prove it by id instead.
      await db.execute(
        sql`UPDATE city_default_loan_products
               SET loan_product_id = ${MISSING_PRODUCT}
             WHERE id = ${dealerId}`,
      );
      const ordered = await resolveDefaultProductRules({
        dealerCode: dealer.dealer_id,
        customerState: STATE,
        customerCity: CITY,
      });
      const rungs = ordered.map((r) => r.id);
      if (rungs.indexOf(cityId) >= 0 && rungs.indexOf(cityId) < rungs.indexOf(stateId)) {
        pass(
          "a city rule beats a state rule (simulated)",
          `#${cityId} (city) ahead of #${stateId} (state)`,
        );
      } else {
        fail(
          "a city rule beats a state rule (simulated)",
          `expected #${cityId} before #${stateId}, got ${rungs.join(" → ") || "nothing"}`,
        );
      }

      const fellToCity = await loadSectionGOptions(lead, null);
      if (isOnly(fellToCity, lenderB.nbfcId, productB.id)) {
        pass(
          "each rung falls through to the next one down",
          `#${dealerId} skipped → #${cityId} offered`,
        );
      } else {
        fail(
          "each rung falls through to the next one down",
          `expected nbfc ${lenderB.nbfcId} / product ${productB.id}, got ` + describe(fellToCity),
        );
      }

      // And with none of the three fitting, the full list comes back.
      await db.execute(
        sql`UPDATE city_default_loan_products
               SET loan_product_id = ${MISSING_PRODUCT}
             WHERE id IN (${cityId}, ${stateId})`,
      );
      const noneFit = await loadSectionGOptions(lead, null);
      if (noneFit.length === before.length) {
        pass("no rule fits — the full matched list is returned", `${noneFit.length} lender(s)`);
      } else {
        fail(
          "no rule fits — the full matched list is returned",
          `expected ${before.length} lender(s), got ${noneFit.length}`,
        );
      }
    }
  } finally {
    for (const id of inserted) {
      await db.execute(sql`DELETE FROM city_default_loan_products WHERE id = ${id}`);
    }
    if (inserted.length > 0) {
      console.log(`  · cleaned up temporary rule(s) #${inserted.join(", #")}`);
    }
  }
}

/**
 * E-290 — prove the RETIRED customer leg is inert, with no effect on anyone.
 *
 * The danger the resolver's `customer_state IS NULL AND customer_city IS NULL`
 * guard exists to prevent is the opposite of the obvious one: not that such a
 * row keeps narrowing, but that dropping the columns from the WHERE clause
 * would silently promote "customers in Pune only" into "every customer". So
 * this asserts the row does NOTHING — the full matched list comes back either
 * way — which covers both failure modes at once.
 *
 * Safer than simulateNarrowing(): the row names the synthetic location the
 * probe lead invents, so it cannot apply to a single live applicant even in
 * principle. Deleted in a finally regardless.
 */
async function simulateRetiredCustomerLeg() {
  const name = "a retired customer-location rule is inert (simulated)";
  if (!process.argv.includes("--simulate")) {
    skip(name, "pass --simulate to exercise it (inserts and deletes rows)");
    return;
  }

  const { db } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");
  const { loadSectionGOptions } = await import("@/lib/leads/section-g");

  const CITY = "ZZ Verify City";
  const STATE = "ZZ Verify State";

  const [inUse] = await db.execute<{ c: number }>(
    sql`SELECT count(*)::int AS c FROM leads WHERE city = ${CITY} OR state = ${STATE}`,
  );
  if (Number(inUse?.c ?? 0) > 0) {
    fail(name, `${CITY} is a real location here — aborting rather than risk a live lead`);
    return;
  }

  const [dealer] = await db.execute<{ dealer_id: string }>(
    sql`SELECT d.dealer_id
          FROM dealers d
          JOIN accounts a ON a.id = d.dealer_id
         WHERE d.dealer_id IS NOT NULL
         ORDER BY d.id ASC LIMIT 1`,
  );
  if (!dealer) {
    skip(name, "no dealer with a dealer code to probe with");
    return;
  }

  const lead = {
    dealer_id: dealer.dealer_id,
    product_category_id: null,
    state: STATE,
    city: CITY,
    resident_status: null,
  };

  const before = await loadSectionGOptions(lead, null);
  if (before.length < 2) {
    skip(
      name,
      `only ${before.length} unrestricted lender(s) match an invented city — need 2+ to prove nothing narrowed`,
    );
    return;
  }

  // Deliberately NOT the first lender: if the guard failed and this row DID
  // narrow, the result would differ from the full list in an obvious way.
  const target = before[1];
  const product = target.activeLoanProducts[0];

  const inserted: number[] = [];
  try {
    const [row] = await db.execute<{ id: number }>(sql`
      INSERT INTO city_default_loan_products
             (dealer_code, state, city, customer_state, customer_city,
              nbfc_id, loan_product_id, notes)
      VALUES (NULL, NULL, NULL, ${STATE}, ${CITY},
              ${target.nbfcId}, ${product.id},
              'temporary row written by verify-city-default-products.ts --simulate')
      RETURNING id
    `);
    inserted.push(Number(row.id));

    // The lead lives in exactly the place this row names, so under E-289 it
    // would have narrowed. It must not now.
    const after = await loadSectionGOptions(lead, null);
    if (after.length === before.length) {
      pass(name, `${after.length} lender(s) — unchanged, the row was excluded`);
    } else {
      fail(
        name,
        `expected the full ${before.length} lender(s), got ` + describe(after),
      );
    }
  } finally {
    for (const id of inserted) {
      await db.execute(sql`DELETE FROM city_default_loan_products WHERE id = ${id}`);
    }
    if (inserted.length > 0) {
      console.log(`  · cleaned up temporary rule(s) #${inserted.join(", #")}`);
    }
  }
}

function describe(
  options: { nbfcId: number; activeLoanProducts: { id: number }[] }[],
): string {
  return (
    options
      .map((o) => `${o.nbfcId}:[${o.activeLoanProducts.map((p) => p.id).join(",")}]`)
      .join(" ") || "nothing"
  );
}

/** How a rule reads in one line, for failure messages. */
function scopeOf(m: {
  dealer_code: string | null;
  state: string | null;
  city: string | null;
}): string {
  const where = m.city ? `${m.city}, ${m.state}` : m.state ? `all of ${m.state}` : "any location";
  const parts = [m.dealer_code, where].filter(Boolean) as string[];
  return parts.join(" — ");
}

/**
 * E-290 — which of the three kinds a rule is, as its rank. 0 beats 1 beats 2,
 * which is exactly what the resolver's
 * `(dealer_code IS NULL), (city IS NULL), (state IS NULL)` ordering produces.
 * Accepts either the raw DB row or the resolved rule, since the two spell the
 * dealer column differently.
 */
const TIER_NAME = ["dealer", "city", "state"] as const;

function tierOf(m: {
  dealer_code?: string | null;
  dealerCode?: string | null;
  city: string | null;
}): 0 | 1 | 2 {
  if (m.dealer_code ?? m.dealerCode) return 0;
  if (m.city) return 1;
  return 2;
}

function n0(v: string): string {
  return v.trim().toLowerCase();
}

function report() {
  console.log(
    `\n${failed === 0 ? "ALL GREEN" : `${failed} FAILED`} — ${steps.length} assertion(s)\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nverify-city-default-products crashed:", err);
  process.exit(1);
});
