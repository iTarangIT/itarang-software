/**
 * E-218 — classify existing expense rows into spend buckets.
 *
 * Run: node --import tsx --env-file=.env.local scripts/_backfill-expense-buckets.ts [--apply] [--limit=N]
 *
 * Without --apply it only reports. New invoices get a bucket at ingest (the
 * extractor asks for one in the call it was already making), so this exists for
 * the rows that predate E-218 — re-reading their PDFs would be needlessly
 * expensive when vendor, description and project tag are already stored as text.
 *
 * Two passes:
 *   1. bucketRules.ts over every row — free, deterministic, catches the repeat
 *      vendors that make up most of the ledger.
 *   2. one batched, text-only model call per ~40 remaining rows.
 *
 * Idempotent and safe to re-run:
 *   - only rows with `bucket IS NULL` are considered, so a second pass is a
 *     no-op rather than a re-classification;
 *   - which also means a human's correction (bucket_source='manual') is never
 *     touched, because it is not null.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { bucketFromRules } from "@/lib/expenses/bucketRules";
import { resolveBucket } from "@/lib/expenses/resolveBucket";
import {
  classifyBuckets,
  BUCKET_MODEL,
  type BucketCandidate,
  type BucketVerdict,
} from "@/lib/ai/invoices/classifyBucket";
import { EXPENSE_BUCKETS, expenseBucketLabel, type ExpenseBucket } from "@/lib/expenses";

const APPLY = process.argv.includes("--apply");
const LIMIT = (() => {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  const n = arg ? Number(arg.split("=")[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 2000;
})();

const inr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

async function main() {
  const rows = await db
    .select({
      id: expenseSubmissions.id,
      vendor: expenseSubmissions.vendor,
      description: expenseSubmissions.description,
      project_tag: expenseSubmissions.project_tag,
      department: expenseSubmissions.department,
      category: expenseSubmissions.category,
      amount: expenseSubmissions.amount,
      file_name: expenseSubmissions.file_name,
    })
    .from(expenseSubmissions)
    .where(isNull(expenseSubmissions.bucket))
    .limit(LIMIT);

  if (rows.length === 0) {
    console.log("Nothing to classify — every expense row already has a bucket.");
    process.exit(0);
  }

  console.log(
    `${rows.length} unclassified row(s)${APPLY ? "" : "  (dry run — pass --apply to write)"}\n`,
  );

  // --- pass 1: rules -------------------------------------------------------
  const ruled = new Map<string, { bucket: ExpenseBucket; rule: string }>();
  const unmatched: BucketCandidate[] = [];

  for (const r of rows) {
    const match = bucketFromRules({
      vendor: r.vendor,
      description: r.description,
      project_tag: r.project_tag,
      category: r.category,
    });
    if (match) {
      ruled.set(r.id, match);
    } else {
      unmatched.push({
        id: r.id,
        vendor: r.vendor,
        description: r.description,
        project_tag: r.project_tag,
        department: r.department,
        amount: r.amount != null ? Number(r.amount) : null,
      });
    }
  }

  console.log(`  pass 1 — rules      : ${ruled.size} matched (free)`);

  // --- pass 2: the model, for what the rules could not name ----------------
  let verdicts = new Map<string, BucketVerdict>();
  if (unmatched.length > 0) {
    const batches = Math.ceil(unmatched.length / 40);
    console.log(
      `  pass 2 — classifier : ${unmatched.length} row(s) in ${batches} batch(es) via ${BUCKET_MODEL}`,
    );
    if (APPLY) {
      verdicts = await classifyBuckets(unmatched, {
        onBatch: ({ index, total, size, failed }) => {
          console.log(
            failed
              ? `      batch ${index + 1}/${total} (${size} rows) FAILED: ${failed}`
              : `      batch ${index + 1}/${total} (${size} rows) ok`,
          );
        },
      });
    } else {
      console.log("      (skipped in dry run — no model calls are made)");
    }
  } else {
    console.log("  pass 2 — classifier : nothing left for the model");
  }

  // --- resolve + report ----------------------------------------------------
  const tally = new Map<string, { count: number; total: number }>();
  const bySource = { rule: 0, ai: 0, default: 0 } as Record<string, number>;
  let written = 0;

  for (const r of rows) {
    const ruleMatch = ruled.get(r.id);
    const verdict = verdicts.get(r.id);
    const resolved = ruleMatch
      ? { bucket: ruleMatch.bucket, source: "rule" as const }
      : resolveBucket({
          vendor: r.vendor,
          description: r.description,
          project_tag: r.project_tag,
          category: r.category,
          aiBucket: verdict?.bucket,
          aiConfidence: verdict?.confidence,
        });

    const amount = Number(r.amount ?? 0);
    const cell = tally.get(resolved.bucket) ?? { count: 0, total: 0 };
    cell.count += 1;
    cell.total += amount;
    tally.set(resolved.bucket, cell);
    bySource[resolved.source] = (bySource[resolved.source] ?? 0) + 1;

    if (APPLY) {
      const updated = await db
        .update(expenseSubmissions)
        .set({
          bucket: resolved.bucket,
          bucket_source: resolved.source,
          updated_at: new Date(),
        })
        // Re-check the NULL here, not just in the SELECT: a scan or an admin
        // edit could have bucketed this row while the model calls were in
        // flight, and that answer is fresher than ours.
        .where(and(eq(expenseSubmissions.id, r.id), isNull(expenseSubmissions.bucket)))
        .returning({ id: expenseSubmissions.id });
      written += updated.length;
    }
  }

  console.log("\n  bucket           rows        amount");
  console.log("  ---------------------------------------------");
  for (const b of EXPENSE_BUCKETS) {
    const cell = tally.get(b.value) ?? { count: 0, total: 0 };
    console.log(
      `  ${expenseBucketLabel(b.value).padEnd(16)} ${String(cell.count).padStart(4)}  ${inr(
        cell.total,
      ).padStart(14)}`,
    );
  }

  console.log(
    `\n  decided by: ${bySource.rule ?? 0} rule · ${bySource.ai ?? 0} model · ${
      bySource.default ?? 0
    } fallback to "others"`,
  );

  if (APPLY) {
    console.log(`\n${written} row(s) written.`);
  } else {
    console.log(
      "\nDry run — nothing written, and no model calls were made, so the rows" +
        '\nabove that would go to the classifier are shown under "others".' +
        "\nRe-run with --apply to classify and write.",
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
