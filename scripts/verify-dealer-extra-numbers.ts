/**
 * E-279 — verify the extra main-dealer numbers feature against a real DB.
 * READ-ONLY: no writes, safe on any environment.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-dealer-extra-numbers.ts [EXTRA-WA-PHONE]
 *
 * [EXTRA-WA-PHONE] (optional) is a number already added on the admin
 * "Multiple dealer" tab (digits, e.g. 919876543210) — when given, the script
 * additionally asserts it resolves to the full main-dealer identity.
 *
 * What it asserts:
 *   1. dealer_extra_numbers exists with the partial unique active-phone index.
 *   2. Every ACTIVE row points at an active dealers row that has a
 *      role='dealer' users row (leads.uploader_id source) — a row failing this
 *      fails closed into onboarding on WhatsApp.
 *   3. No ACTIVE row's phone collides with an active operator (E-214), an
 *      active salesperson (E-277), an approved application wa_phone, or an
 *      active dealers.owner_phone — the add-time conflict matrix invariants.
 *   4. With a phone arg: resolveWhatsAppDealer() returns matchedVia='extra'
 *      with a non-null dealerUserId, and the phone is part of the dealer's
 *      outbound push channel set.
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

async function main() {
  const phoneArg = (process.argv[2] || "").replace(/\D/g, "");

  const { db } = await import("@/lib/db");
  const { and, eq, inArray, sql } = await import("drizzle-orm");
  const {
    dealerExtraNumbers,
    dealerOnboardingApplications,
    dealers,
    dealerSalespersons,
    users,
    whatsappOperators,
  } = await import("@/lib/db/schema");
  const { phoneLookupVariants } = await import("@/lib/ai/phone");

  console.log(
    "DB HOST:",
    new URL(process.env.DATABASE_URL ?? "http://none").hostname,
    "\n",
  );

  // 1 — table + partial unique index.
  try {
    const idx = await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'dealer_extra_numbers'
        AND indexname = 'dealer_extra_numbers_active_phone_key'
    `);
    const rows = (idx as unknown as { rows?: { indexdef: string }[] }).rows ??
      (idx as unknown as { indexdef: string }[]);
    const def = Array.isArray(rows) && rows[0] ? rows[0].indexdef : "";
    if (def && /WHERE\s*\(?\s*is_active/i.test(def)) {
      pass("partial unique active-phone index present");
    } else if (def) {
      fail("active-phone index", `unexpected definition: ${def}`);
    } else {
      fail(
        "active-phone index",
        "missing — is E-279 applied to this database?",
      );
    }
  } catch (err) {
    fail(
      "dealer_extra_numbers table",
      `query failed (${err instanceof Error ? err.message : err}) — is E-279 applied?`,
    );
    console.log(`\n${failed} failure(s).`);
    process.exit(1);
  }

  const active = await db
    .select({
      id: dealerExtraNumbers.id,
      dealerCode: dealerExtraNumbers.dealer_code,
      waPhone: dealerExtraNumbers.wa_phone,
      displayName: dealerExtraNumbers.display_name,
    })
    .from(dealerExtraNumbers)
    .where(eq(dealerExtraNumbers.is_active, true));
  console.log(`ACTIVE extra numbers: ${active.length}\n`);

  // 2 — each active row has an active dealer with a dealer login user.
  for (const row of active) {
    const [d] = await db
      .select({ id: dealers.dealer_id })
      .from(dealers)
      .where(
        and(
          eq(dealers.dealer_id, row.dealerCode),
          eq(dealers.onboarding_status, "active"),
        ),
      )
      .limit(1);
    if (!d) {
      fail(
        `dealer active: ${row.waPhone}`,
        `dealer ${row.dealerCode} is not active — number fails closed`,
      );
      continue;
    }
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(eq(users.dealer_id, row.dealerCode), eq(users.role, "dealer")),
      )
      .limit(1);
    if (u) {
      pass(`row healthy: +${row.waPhone} → ${row.dealerCode}`);
    } else {
      fail(
        `dealer login: ${row.waPhone}`,
        `dealer ${row.dealerCode} has no role='dealer' user — lead creation would fail closed`,
      );
    }
  }

  // 3 — collision invariants (mirrors the add-time conflict matrix).
  for (const row of active) {
    const variants = [
      ...new Set([row.waPhone, ...phoneLookupVariants(row.waPhone)]),
    ];
    const [op] = await db
      .select({ id: whatsappOperators.id })
      .from(whatsappOperators)
      .where(
        and(
          inArray(whatsappOperators.wa_phone, variants),
          eq(whatsappOperators.is_active, true),
        ),
      )
      .limit(1);
    if (op) fail(`no operator collision: ${row.waPhone}`, "is an active operator");

    const [sp] = await db
      .select({ id: dealerSalespersons.id })
      .from(dealerSalespersons)
      .where(
        and(
          inArray(dealerSalespersons.wa_phone, variants),
          eq(dealerSalespersons.is_active, true),
        ),
      )
      .limit(1);
    if (sp)
      fail(`no salesperson collision: ${row.waPhone}`, "is an active salesperson");

    const [app] = await db
      .select({ code: dealerOnboardingApplications.dealer_code })
      .from(dealerOnboardingApplications)
      .where(
        and(
          inArray(dealerOnboardingApplications.wa_phone, variants),
          eq(dealerOnboardingApplications.onboarding_status, "approved"),
          eq(dealerOnboardingApplications.dealer_account_status, "active"),
        ),
      )
      .limit(1);
    if (app)
      fail(
        `no primary-app collision: ${row.waPhone}`,
        `is dealer ${app.code}'s application wa_phone`,
      );

    const [own] = await db
      .select({ code: dealers.dealer_id })
      .from(dealers)
      .where(
        and(
          inArray(dealers.owner_phone, variants),
          eq(dealers.onboarding_status, "active"),
        ),
      )
      .limit(1);
    if (own)
      fail(
        `no owner-phone collision: ${row.waPhone}`,
        `is dealer ${own.code}'s owner_phone`,
      );

    if (!op && !sp && !app && !own) {
      pass(`no identity collisions: +${row.waPhone}`);
    }
  }

  // 4 — resolution + push channel for the given phone.
  if (phoneArg) {
    const { resolveWhatsAppDealer } = await import(
      "@/lib/whatsapp/dealer-identity"
    );
    const resolved = await resolveWhatsAppDealer(phoneArg);
    if (!resolved) {
      fail(`resolve +${phoneArg}`, "resolveWhatsAppDealer returned null");
    } else if (resolved.matchedVia !== "extra") {
      fail(
        `resolve +${phoneArg}`,
        `matchedVia='${resolved.matchedVia}' (expected 'extra') — the number matches a primary channel first`,
      );
    } else if (!resolved.dealerUserId) {
      fail(
        `resolve +${phoneArg}`,
        `matched dealer ${resolved.dealerCode} but dealerUserId is null — gate 12 will not route it`,
      );
    } else {
      pass(
        `resolve +${phoneArg}`,
        `→ ${resolved.dealerCode} (${resolved.dealerName ?? "?"}), matchedVia=extra, full main-dealer scope`,
      );
      // Push-channel inclusion, re-derived the way dealerChannelForLead builds
      // its set (that function is module-private).
      const extras = await db
        .select({ waPhone: dealerExtraNumbers.wa_phone })
        .from(dealerExtraNumbers)
        .where(
          and(
            eq(dealerExtraNumbers.dealer_code, resolved.dealerCode),
            eq(dealerExtraNumbers.is_active, true),
          ),
        );
      if (extras.some((e) => e.waPhone === phoneArg)) {
        pass(
          `push channel +${phoneArg}`,
          "active row present — dealerChannelForLead merges it",
        );
      } else {
        fail(
          `push channel +${phoneArg}`,
          "no active dealer_extra_numbers row stores this exact phone form",
        );
      }
    }
  } else {
    console.log(
      "\n(no phone arg — skipped the resolveWhatsAppDealer live check)",
    );
  }

  console.log(
    `\n${steps.length} checks, ${failed} failure(s).${failed ? "" : " ALL GREEN."}`,
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
