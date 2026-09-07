/**
 * The vendor portal's battery payload — does the spec actually arrive, and does
 * nothing else ride along with it?
 *
 * READ-ONLY. It imports the real threadsForVendor + toVendorThread rather than
 * restating their SQL, per CLAUDE.md: the bug this guards against was a missing
 * SELECT, and a test that restated the query would have reproduced the miss.
 *
 * The bug: toVendorLine has always emitted the E-191 spec — chemistry,
 * kilograms, rated cycles, IOT brand, the working/non-working split — and the
 * quotation PDF has always printed it. threadsForVendor never selected the
 * columns, so every field arrived `undefined` and the portal showed
 * "62V 33Ah · Dead" and nothing else. A vendor was pricing a lot from an email
 * attachment because the screen would not tell them what the battery was.
 *
 * Two assertions, and the second matters more than the first:
 *   1. the spec reaches the serialized payload (the fix works), and
 *   2. VENDOR_FORBIDDEN_KEYS still appear nowhere at any depth (the fix did not
 *      cost us the masking that makes the portal safe to show at all).
 *
 *   npm run verify:vendor-thread-spec
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { vendorLineMeta } from "@/lib/buyback/format";
import { toVendorThread, VENDOR_FORBIDDEN_KEYS } from "@/lib/buyback/serialize";
import { threadsForVendor } from "@/lib/buyback/vendors";

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) failures++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
};

/** Every string value anywhere in the payload, for the leak scan. */
function deepKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) deepKeys(v, into);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      deepKeys(v, into);
    }
  }
  return into;
}

async function main() {
  // Pick a vendor that actually has a thread — an empty result would let this
  // script "pass" while proving nothing, which is the failure mode of every
  // fixture-free check.
  const rows = await db.execute(sql`
    SELECT sv.entity_id, a.business_entity_name AS name, count(vt.id)::int AS threads
      FROM scrap_vendors sv
      JOIN accounts a       ON a.id = sv.entity_id
      JOIN vendor_threads vt ON vt.vendor_id = sv.id
     GROUP BY sv.entity_id, a.business_entity_name
     ORDER BY threads DESC
     LIMIT 1
  `);
  const vendor = (rows as unknown as Array<Record<string, unknown>>)[0];

  if (!vendor) {
    console.log("\n  SKIP  no scrap vendor on this database has a quotation thread.");
    console.log("        Route a request to a vendor first, then re-run.\n");
    return;
  }

  console.log(`\nVendor: ${vendor.name} — ${vendor.threads} thread(s)\n`);

  const threads = (await threadsForVendor(String(vendor.entity_id))).map((t) =>
    toVendorThread({
      thread_id: t.thread_id,
      quotation_no: t.quotation_no ?? "—",
      status: t.status,
      pickup_city: t.pickup_city,
      pickup_state: t.pickup_state,
      sent_at: t.sent_at,
      responded_at: t.responded_at,
      has_vendor_po: t.has_vendor_po,
      proforma: t.proforma,
      lines: t.lines,
    }),
  );

  ok(threads.length > 0, `threadsForVendor returned ${threads.length} thread(s)`);

  const lines = threads.flatMap((t) => t.lines);
  ok(lines.length > 0, `${lines.length} battery line(s) across them`);

  // 1. The spec arrives. Reported per field: a dealer may legitimately have left
  //    one blank, so what matters is that SOME line carries each — a column the
  //    query forgot is null on EVERY line, which is the signature to look for.
  const specFields = [
    "variant_type",
    "brand",
    "chemistry",
    "form_factor",
    "nominal_voltage",
    "nominal_ampere",
    "unit_weight_kg",
    "warranty_cycles",
    "iot_battery",
  ] as const;

  console.log("  Declared spec, by field:");
  for (const field of specFields) {
    const present = lines.filter((l) => l[field] !== null && l[field] !== undefined).length;
    console.log(
      `    ${present > 0 ? "·" : "!"} ${field.padEnd(18)} ${present}/${lines.length} line(s)`,
    );
  }

  const anySpec = lines.some((l) => vendorLineMeta(l).length > 0);
  ok(anySpec, "at least one line renders a non-empty spec meta line");

  // line_weight_kg is DERIVED (qty × unit weight), so it proves the numeric came
  // through as a number and not as an unparsed string.
  const weighed = lines.filter((l) => l.line_weight_kg !== null);
  ok(
    weighed.length === 0 || weighed.every((l) => Number.isFinite(l.line_weight_kg)),
    `line_weight_kg computes on all ${weighed.length} line(s) that declared a unit weight`,
  );

  // 2. Nothing rode along. The whole reason the portal is safe to show.
  const keys = deepKeys(threads);
  const leaked = VENDOR_FORBIDDEN_KEYS.filter((k) => keys.has(k));
  ok(leaked.length === 0, `no forbidden key in the payload${leaked.length ? `: ${leaked}` : ""}`);

  // A sample, so a human can eyeball what the vendor will actually read.
  const sample = lines.find((l) => vendorLineMeta(l).length > 0) ?? lines[0];
  if (sample) {
    console.log(`\n  Sample line as the vendor sees it:`);
    console.log(`    ${sample.spec_label} · ${sample.condition} ×${sample.quantity}`);
    console.log(`    ${vendorLineMeta(sample).join(" · ") || "(no spec declared)"}`);
    console.log(`    ${sample.photos.length} photo(s)\n`);
  }

  console.log(failures === 0 ? "All checks passed.\n" : `${failures} check(s) FAILED.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => process.exit(failures === 0 ? 0 : 1));
