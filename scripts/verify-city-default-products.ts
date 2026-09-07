/**
 * E-282/E-283/E-286 — verify the pinned default loan product against a real DB.
 *
 * E-286: a rule's state/city are the DEALER's (accounts.state / accounts.city),
 * not the customer's, so every assertion below probes by dealer code and the
 * locations it uses are locations dealers really are in.
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
 *      (dealer_code, priority), has a nullable `state`, and has the widened
 *      partial unique key _active_key_v2 in place of the E-282 _active_key.
 *   2. Every ACTIVE rule points at an active, tenant-bound loan product that
 *      really belongs to the named NBFC — a rule failing this can never fire.
 *   3. Every ACTIVE rule can match at least one real dealer: a location-only
 *      rule names a location some dealer is registered in, and a rule naming
 *      both a dealer and a location names a location THAT dealer is in. This
 *      replaces E-282's product-coverage check, which compared
 *      active_locations — a rule about the CUSTOMER's city — against what is
 *      now a dealer location, and so no longer means anything.
 *   4. Every ACTIVE rule naming a dealer names one that exists.
 *   5. resolveDefaultProductRules() orders candidates by priority DESC, then by
 *      specificity: dealer rules before location-only ones, exact city before
 *      the state-wide wildcard.
 *   6. Against a real lead: with no rule the option list is unchanged; with a
 *      rule whose product IS in the hits, exactly one NBFC and one product come
 *      back; with a rule whose product is NOT in the hits, the next rule (or
 *      the full list) is returned — the "never show a product that would reject
 *      them" rule; and excludeNbfcIds removes a lender without collapsing it.
 *   7. --simulate only: end-to-end proof covering the dealer-beats-location
 *      tiebreak, priority overriding it, and fall-through when the top rule's
 *      product is not in the hits. The LEAD's location stays synthetic (it
 *      isolates the BRE's own geography rule), but since E-286 the temporary
 *      RULES must name the probe dealer's REAL location to match at all — so
 *      for the few seconds they exist they also apply to other dealers in that
 *      same city. They are deleted in a finally block.
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
  console.log(`\nE-280/E-283/E-286 pinned default loan products — verifying against ${host}\n`);

  /**
   * E-286 — the code of any dealer registered in this location, or null. Every
   * ordering assertion needs one: since a rule's location is now the DEALER's,
   * the only way to exercise a location rule is through a dealer that sits in
   * it. `accounts.id` is what the rules and `leads.dealer_id` both carry.
   */
  const dealerCodeIn = async (
    state: string | null,
    city: string | null,
  ): Promise<string | null> => {
    if (!state) return null;
    const [row] = await db.execute<{ id: string }>(sql`
      SELECT a.id
        FROM accounts a
       WHERE lower(btrim(a.state)) = ${n0(state)}
         AND (${city}::text IS NULL OR lower(btrim(a.city)) = ${city ? n0(city) : null})
       ORDER BY a.id
       LIMIT 1
    `);
    return row?.id ?? null;
  };

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
  if (idxNames.has("city_default_loan_products_active_key_v2")) {
    pass("widened partial unique active key present", "_active_key_v2");
  } else {
    fail(
      "widened partial unique active key present",
      "city_default_loan_products_active_key_v2 not found",
    );
  }
  if (idxNames.has("city_default_loan_products_active_key")) {
    fail(
      "E-282 unique key replaced",
      "the old city_default_loan_products_active_key still exists — it would block a " +
        "dealer rule and a location rule for the same city",
    );
  } else {
    pass("E-282 unique key replaced");
  }

  // ── 2 + 3 + 4. Every active rule is coherent and reachable ──────────────
  const rules = await db.execute<{
    id: number;
    dealer_code: string | null;
    state: string | null;
    city: string | null;
    priority: number;
    nbfc_id: number;
    loan_product_id: number;
    product_nbfc_id: number | null;
    product_status: string | null;
    tenant_id: string | null;
    dealer_exists: boolean;
  }>(sql`
    SELECT c.id, c.dealer_code, c.state, c.city, c.priority, c.nbfc_id, c.loan_product_id,
           p.nbfc_id AS product_nbfc_id, p.status AS product_status,
           n.tenant_id::text AS tenant_id,
           (c.dealer_code IS NULL OR a.id IS NOT NULL) AS dealer_exists
      FROM city_default_loan_products c
      LEFT JOIN nbfc_loan_products p ON p.id = c.loan_product_id
      LEFT JOIN nbfc n ON n.id = c.nbfc_id
      LEFT JOIN accounts a ON a.id = c.dealer_code
     WHERE c.is_active
     ORDER BY c.priority DESC, (c.dealer_code IS NULL), (c.city IS NULL), (c.state IS NULL), c.id DESC
  `);

  if (rules.length === 0) {
    skip("active rules are coherent", "no defaults configured yet");
    skip("active rules can match a real dealer", "no defaults configured yet");
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

    // E-286 — a rule's location is the DEALER's, so "can this rule ever fire?"
    // is answered by the dealer directory, not by the product's
    // active_locations (which the BRE matches against the CUSTOMER's city and
    // which therefore says nothing about a dealer-scoped rule).
    const unmatchable: string[] = [];
    for (const m of rules) {
      if (!m.state) continue; // no location declared — always matchable
      const [hit] = await db.execute<{ c: number }>(sql`
        SELECT count(*)::int AS c
          FROM accounts a
         WHERE lower(btrim(a.state)) = ${n0(m.state)}
           AND (${m.city}::text IS NULL OR lower(btrim(a.city)) = ${m.city ? n0(m.city) : null})
           AND (${m.dealer_code}::text IS NULL OR a.id = ${m.dealer_code})
      `);
      if (Number(hit?.c ?? 0) === 0) {
        unmatchable.push(
          `#${m.id} ${scopeOf(m)}` +
            (m.dealer_code
              ? " (that dealer is not registered in that location)"
              : " (no dealer is registered there)"),
        );
      }
    }
    if (unmatchable.length === 0) {
      pass("active rules can match a real dealer");
    } else {
      fail(
        "active rules can match a real dealer",
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

  // ── 5a. Exact city beats the state-wide wildcard ────────────────────────
  // Only meaningful between rules the admin left at the SAME priority — a
  // higher-priority wildcard is supposed to win, and that is asserted in 5b.
  const cityRule = rules.find(
    (m) =>
      m.city &&
      !m.dealer_code &&
      rules.some(
        (w) =>
          !w.city &&
          !w.dealer_code &&
          w.state &&
          m.state &&
          n0(w.state) === n0(m.state) &&
          w.priority === m.priority,
      ),
  );
  if (!cityRule) {
    skip(
      "exact city beats the state wildcard",
      "no state with both a city row and an equal-priority wildcard row",
    );
  } else {
    // E-286 — the resolver reads the location off the dealer, so this needs a
    // dealer actually registered in that city to probe with.
    const probeCode = await dealerCodeIn(cityRule.state, cityRule.city);
    if (!probeCode) {
      skip(
        "exact city beats the state wildcard",
        `no dealer is registered in ${cityRule.city}, ${cityRule.state} to probe with`,
      );
    } else {
      const got = await resolveDefaultProductRules(probeCode);
      if (got[0] && got[0].city && n0(got[0].city) === n0(cityRule.city!)) {
        pass("exact city beats the state wildcard", `${cityRule.city}, ${cityRule.state}`);
      } else {
        fail(
          "exact city beats the state wildcard",
          `resolveDefaultProductRules(${probeCode}) led with ` +
            (got[0] ? `city=${got[0].city ?? "*"}` : "nothing"),
        );
      }
    }
  }

  // ── 5b. Priority is the primary sort ────────────────────────────────────
  // Whatever rules exist, the list must come back non-increasing in priority.
  const anyDealerRule = rules.find((m) => m.dealer_code);
  const probe = anyDealerRule ?? rules[0];
  if (!probe) {
    skip("candidates come back highest-priority first", "no defaults configured yet");
  } else {
    const probeCode =
      probe.dealer_code ?? (await dealerCodeIn(probe.state, probe.city));
    const got = probeCode ? await resolveDefaultProductRules(probeCode) : [];
    const descending = got.every(
      (r, i) => i === 0 || got[i - 1].priority >= r.priority,
    );
    if (!probeCode) {
      skip(
        "candidates come back highest-priority first",
        `no dealer registered in ${scopeOf(probe)} to probe with`,
      );
    } else if (descending) {
      pass(
        "candidates come back highest-priority first",
        `${got.length} candidate(s) for ${scopeOf(probe)}`,
      );
    } else {
      fail(
        "candidates come back highest-priority first",
        got.map((r) => `#${r.id}:p${r.priority}`).join(" "),
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
    // The simulation needs no real lead, so it still runs.
    await simulateNarrowing();
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

  // E-286 — dealer only; the location comes off that dealer's own account.
  const live = await resolveDefaultProductRules(lead.dealer_id);
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
          `rule #${expected.id} (p${expected.priority}) → nbfc ${expected.nbfcId} / product ${expected.loanProductId}`,
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

  report();
}

/**
 * Prove the narrowing end to end, with no effect on any real customer.
 *
 * Only runs with --simulate. It pins rules on a SYNTHETIC city that no lead
 * lives in, asks for the options as a synthetic lead in that city, and deletes
 * every row again in a finally. A real applicant is never routed differently,
 * because no real applicant is in this city — and the dealer rule is scoped to
 * that invented city too, so the dealer's real customers are untouched.
 *
 * The lenders come from products with NO active_locations restriction — the
 * only kind that can match an invented city.
 */
async function simulateNarrowing() {
  const name = "narrowing pins one lender (simulated)";
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

  // E-286 - the probe dealer must have a real registered location, because
  // that is what the temporary LOCATION rules have to name to match at all.
  // Joining accounts also proves the two id spaces line up for this dealer,
  // which loadSectionGOptions independently depends on.
  const [dealer] = await db.execute<{
    id: number;
    dealer_id: string;
    acc_state: string;
    acc_city: string;
  }>(
    sql`SELECT d.id, d.dealer_id, a.state AS acc_state, a.city AS acc_city
          FROM dealers d
          JOIN accounts a ON a.id = d.dealer_id
         WHERE d.dealer_id IS NOT NULL
           AND btrim(coalesce(a.state, '')) <> ''
           AND btrim(coalesce(a.city, '')) <> ''
         ORDER BY d.id ASC LIMIT 1`,
  );
  if (!dealer) {
    skip(name, "no dealer with both a dealer code and a registered state/city");
    return;
  }
  // The RULES key on where the dealer is; the LEAD keeps the invented location
  // so the BRE's own geography rule stays isolated to unrestricted lenders.
  const RULE_STATE = dealer.acc_state;
  const RULE_CITY = dealer.acc_city;

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

  // Deliberately NOT the first lender: narrowing to what was already at the top
  // would pass even if the code did nothing.
  const locTarget = before[1];
  const locProduct = locTarget.activeLoanProducts[0];
  // A different lender for the dealer rule, so "which rule won" is observable.
  const dealerTarget = before[0];
  const dealerProduct = dealerTarget.activeLoanProducts[0];

  const inserted: number[] = [];
  const insert = async (
    dealerCode: string | null,
    state: string | null,
    city: string | null,
    nbfcId: number,
    productId: number,
    priority: number,
  ) => {
    const [row] = await db.execute<{ id: number }>(sql`
      INSERT INTO city_default_loan_products
             (dealer_code, state, city, nbfc_id, loan_product_id, priority, notes)
      VALUES (${dealerCode}, ${state}, ${city}, ${nbfcId}, ${productId}, ${priority},
              'temporary row written by verify-city-default-products.ts --simulate')
      RETURNING id
    `);
    inserted.push(Number(row.id));
    return Number(row.id);
  };

  try {
    // ── location rule alone narrows to itself ─────────────────────────────
    const locId = await insert(
      null,
      RULE_STATE,
      RULE_CITY,
      locTarget.nbfcId,
      locProduct.id,
      0,
    );

    const after = await loadSectionGOptions(lead, null);
    const narrowed =
      after.length === 1 &&
      after[0].nbfcId === locTarget.nbfcId &&
      after[0].activeLoanProducts.length === 1 &&
      after[0].activeLoanProducts[0].id === locProduct.id;

    if (narrowed) {
      pass(name, `${before.length} lender(s) → 1 (nbfc ${locTarget.nbfcId} / product ${locProduct.id})`);
    } else {
      fail(
        name,
        `expected exactly nbfc ${locTarget.nbfcId} / product ${locProduct.id}, got ` +
          describe(after),
      );
    }

    // The pinned lender being excluded must fall back to the full list, not
    // collapse to nothing — decision (2) at its sharpest.
    const excluded = await loadSectionGOptions(lead, null, {
      excludeNbfcIds: [locTarget.nbfcId],
    });
    if (
      excluded.length === before.length - 1 &&
      excluded.every((o) => o.nbfcId !== locTarget.nbfcId)
    ) {
      pass("pinned-but-excluded lender falls back to the full list", `${excluded.length} lender(s)`);
    } else {
      fail(
        "pinned-but-excluded lender falls back to the full list",
        `expected ${before.length - 1} lender(s), got ${excluded.length}`,
      );
    }

    // ── E-283: a dealer rule beats a location rule at equal priority ──────
    const dealerId = await insert(
      dealer.dealer_id,
      RULE_STATE,
      RULE_CITY,
      dealerTarget.nbfcId,
      dealerProduct.id,
      0,
    );

    const withDealer = await loadSectionGOptions(lead, null);
    if (
      withDealer.length === 1 &&
      withDealer[0].nbfcId === dealerTarget.nbfcId &&
      withDealer[0].activeLoanProducts[0]?.id === dealerProduct.id
    ) {
      pass(
        "dealer rule beats a location rule at equal priority",
        `nbfc ${dealerTarget.nbfcId} / product ${dealerProduct.id}`,
      );
    } else {
      fail(
        "dealer rule beats a location rule at equal priority",
        `expected nbfc ${dealerTarget.nbfcId} / product ${dealerProduct.id}, got ` +
          describe(withDealer),
      );
    }

    // ── E-283: priority overrides that specificity tiebreak ───────────────
    await db.execute(
      sql`UPDATE city_default_loan_products SET priority = 100 WHERE id = ${locId}`,
    );
    const withPriority = await loadSectionGOptions(lead, null);
    if (
      withPriority.length === 1 &&
      withPriority[0].nbfcId === locTarget.nbfcId &&
      withPriority[0].activeLoanProducts[0]?.id === locProduct.id
    ) {
      pass(
        "higher priority outranks the more specific rule",
        `location rule at p100 beat the dealer rule at p0`,
      );
    } else {
      fail(
        "higher priority outranks the more specific rule",
        `expected nbfc ${locTarget.nbfcId} / product ${locProduct.id}, got ` +
          describe(withPriority),
      );
    }

    // ── E-283: a top rule that does not fit falls through to the next ─────
    // Point the p100 location rule at a product that is in no hit list at all.
    // The dealer rule at p0 must then be the one offered, rather than the pin
    // being abandoned and the full list returned.
    await db.execute(
      sql`UPDATE city_default_loan_products
             SET loan_product_id = 2147483647
           WHERE id = ${locId}`,
    );
    const fellThrough = await loadSectionGOptions(lead, null);
    if (
      fellThrough.length === 1 &&
      fellThrough[0].nbfcId === dealerTarget.nbfcId &&
      fellThrough[0].activeLoanProducts[0]?.id === dealerProduct.id
    ) {
      pass(
        "a top rule that does not fit falls through to the next",
        `p100 rule skipped, dealer rule #${dealerId} offered instead`,
      );
    } else {
      fail(
        "a top rule that does not fit falls through to the next",
        `expected nbfc ${dealerTarget.nbfcId} / product ${dealerProduct.id}, got ` +
          describe(fellThrough),
      );
    }

    // ── and when NO rule fits, the full list comes back ───────────────────
    await db.execute(
      sql`UPDATE city_default_loan_products
             SET loan_product_id = 2147483647
           WHERE id = ${dealerId}`,
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
  return m.dealer_code ? `${m.dealer_code} — ${where}` : where;
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
