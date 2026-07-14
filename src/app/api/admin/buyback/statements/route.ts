/**
 * GET  /api/admin/buyback/statements  — the imports, with what came of each
 * POST /api/admin/buyback/statements  — upload a bank statement (M13 / U9)
 *
 * The STATEMENT method's front door. An admin uploads the bank's CSV/XLSX; the
 * rows are parsed, stored, and matched against the settlements iTarang EXPECTS.
 *
 * NOTHING IS SETTLED HERE. The upload produces suggestions — rows with a deal and
 * a leg pencilled against them — and stops. The settlement itself is created by
 * the confirm route, by a human, at an amount re-derived from deal_line_locks. An
 * import that quietly paid out every row it recognised would be a bank statement
 * with write access to the ledger.
 *
 * The uploaded file is kept in S3 because it IS the proof: a STATEMENT settlement
 * carries no proof file of its own (E-187's CHECK demands one only for MANUAL,
 * precisely so this path does not have to fake one), so the original workbook is
 * the only artefact there is to show.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { bankStatementImports, bankStatementRows } from "@/lib/db/schema";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { ValidationError } from "@/lib/buyback/errors";
import { parseStatement, suggestMatches } from "@/lib/buyback/statement";
import { BUYBACK_BUCKET, statementKey } from "@/lib/buyback/storage";
import { putObject } from "@/lib/storage/s3";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXT: Record<string, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
};

interface ImportListRow {
  id: string;
  filename: string;
  account_label: string | null;
  row_count: number;
  matched_count: number;
  suggested_count: number;
  ignored_count: number;
  imported_by: string | null;
  created_at: Date;
}

export const GET = withErrorHandler(async () => {
  await requireBuybackAdmin();

  // Counted from the rows, not read off bank_statement_imports' counters: rows
  // get matched long after the import, so the stored counters are a snapshot and
  // the rows are the truth.
  const rows = (await db.execute(sql`
    SELECT
      i.id, i.filename, i.account_label, i.created_at,
      u.name AS imported_by,
      count(r.id)::int                                              AS row_count,
      count(r.id) FILTER (WHERE r.status = 'MATCHED')::int          AS matched_count,
      count(r.id) FILTER (WHERE r.status = 'SUGGESTED')::int        AS suggested_count,
      count(r.id) FILTER (WHERE r.status = 'IGNORED')::int          AS ignored_count
    FROM bank_statement_imports i
    LEFT JOIN bank_statement_rows r ON r.import_id = i.id
    LEFT JOIN users u ON u.id = i.imported_by
    GROUP BY i.id, u.name
    ORDER BY i.created_at DESC
    LIMIT 100
  `)) as unknown as ImportListRow[];

  return successResponse({ imports: rows });
});

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireBuybackAdmin();

  const form = await req.formData();
  const file = form.get("file");
  const accountLabel = (form.get("account_label") as string | null)?.trim() || null;

  if (!file || typeof file !== "object" || !("arrayBuffer" in file)) {
    throw new ValidationError("Attach the bank statement (CSV or Excel).");
  }

  const upload = file as File;
  if (upload.size > MAX_BYTES) {
    throw new ValidationError("That statement is over 5 MB. Split it by month and re-upload.");
  }

  const ext = (upload.name.split(".").pop() ?? "").toLowerCase();
  const contentType = ALLOWED_EXT[ext];
  if (!contentType) {
    throw new ValidationError("Only a CSV or Excel bank statement can be imported.");
  }

  const buffer = Buffer.from(await upload.arrayBuffer());
  const parsed = parseStatement(buffer, upload.name);

  if (parsed.length === 0) {
    // Not an empty statement — an unreadable one. The parser drops junk rows
    // silently, so zero readable rows means it never found the columns.
    throw new ValidationError(
      "No transactions could be read from that file. The statement needs a date column and either an amount column or separate debit/credit columns.",
    );
  }

  // The id is minted here so the S3 key can be derived from it and the object
  // uploaded BEFORE the transaction — a failed upload must not leave an import
  // row pointing at bytes that were never written.
  const importId = randomUUID();
  const key = statementKey(importId, ext);
  await putObject(BUYBACK_BUCKET, key, buffer, contentType);

  const outcome = await db.transaction(async (tx) => {
    await tx.insert(bankStatementImports).values({
      id: importId,
      filename: upload.name,
      s3_key: key,
      account_label: accountLabel,
      row_count: parsed.length,
      imported_by: actor.id,
    });

    const inserted = await tx
      .insert(bankStatementRows)
      .values(
        parsed.map((r) => ({
          import_id: importId,
          txn_date: r.txn_date,
          amount: r.amount.toString(),
          txn_ref: r.txn_ref,
          description: r.description,
        })),
      )
      .returning({
        id: bankStatementRows.id,
        amount: bankStatementRows.amount,
        txn_ref: bankStatementRows.txn_ref,
        description: bankStatementRows.description,
      });

    const suggestions = await suggestMatches(inserted, tx);

    return { suggested: suggestions.length };
  });

  return successResponse(
    {
      import_id: importId,
      filename: upload.name,
      rows_imported: parsed.length,
      rows_suggested: outcome.suggested,
    },
    201,
  );
});
