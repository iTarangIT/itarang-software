// Tracker ID 51 #3 — bulk-imported Ecofy leads in the CRM at once.
//
// A bulk import is committed in Ecofy as a background job (FR-03.5). Until
// now its leads reached the CRM only when Ecofy pushed them back. Once the
// import is COMMITTED the CRM now reads Ecofy's own row report
// (GET /imports/{id}/report.csv: row_no, result, case_no, reasons, …), finds
// each case by its number (GET /cases?q=<caseNo>) and upserts it into
// ecofy_leads with the same version-guarded upsert a push uses — keyed on
// Ecofy's case id, so the later push (or a second sync) updates the same row
// instead of adding one. No pending/placeholder rows: every row the CRM adds
// is a real Ecofy case at its real stage and version.
//
// Pure: no DB, no env, no network. The I/O lives in service.ts
// (syncEcofyImportToCrm).

import Papa from "papaparse";

/** Report results that point at a case. REJECTED rows have none. */
const CASE_RESULTS = new Set(["CREATED", "REOPENED", "DUPLICATE", "NEW_LINKED"]);

export interface ImportReportRow {
    rowNo: number;
    result: string;
    caseNo: string | null;
}

/** Parse Ecofy's import report CSV (header row; columns in any order). */
export function parseImportReport(csv: string): ImportReportRow[] {
    const text = csv.replace(/^﻿/, "");
    const parsed = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim().toLowerCase(),
    });
    return parsed.data
        .map((r) => ({
            rowNo: Number(r.row_no),
            result: String(r.result ?? "").trim().toUpperCase(),
            caseNo: String(r.case_no ?? "").trim() || null,
        }))
        .filter((r) => Number.isFinite(r.rowNo));
}

/**
 * The distinct case numbers an import touched, in row order. Two rows can
 * point at one case (a duplicate linked to an open case, or an in-file
 * duplicate of a created row): the case is fetched once.
 */
export function caseNosToSync(rows: ImportReportRow[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of rows) {
        if (!r.caseNo || !CASE_RESULTS.has(r.result)) continue;
        const key = r.caseNo.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r.caseNo);
    }
    return out;
}

/**
 * GET /cases?q= is a substring search over case number, name, mobile and
 * city, so "ECF-12" also matches "ECF-120". Only an exact case-number match
 * counts; anything else is "not found" (the push brings it later).
 */
export function pickCaseByNo<T extends { caseNo?: unknown; id?: unknown }>(cases: T[] | null | undefined, caseNo: string): T | null {
    const want = caseNo.trim().toUpperCase();
    const hits = (cases ?? []).filter(
        (c) => typeof c.id === "string" && typeof c.caseNo === "string" && c.caseNo.trim().toUpperCase() === want,
    );
    return hits.length === 1 ? hits[0] : null;
}

/**
 * Does the CRM hold this case? The same rule as Ecofy's push: S0 is Ecofy's
 * own qualification and never sent (an Ecofy-owned open case a row was
 * linked to as a duplicate may still be there). Everything else is mirrored.
 */
export function isMirroredStage(stage: unknown): boolean {
    return typeof stage === "string" && stage !== "" && stage !== "S0";
}

export type ImportSyncOutcome = "added" | "updated" | "skipped_s0" | "not_found" | "failed";

export interface ImportSyncResult {
    importId: string;
    status: string;
    /** Rows in Ecofy's report. */
    reportRows: number;
    /** Distinct cases the report points at. */
    cases: number;
    /** Cases looked at in this run (capped; the rest arrive with Ecofy's push). */
    checked: number;
    added: number;
    updated: number;
    skippedS0: number;
    notFound: number;
    failed: number;
}

export function tallyImportSync(
    base: Pick<ImportSyncResult, "importId" | "status" | "reportRows" | "cases">,
    outcomes: ImportSyncOutcome[],
): ImportSyncResult {
    const n = (o: ImportSyncOutcome) => outcomes.filter((x) => x === o).length;
    return {
        ...base,
        checked: outcomes.length,
        added: n("added"),
        updated: n("updated"),
        skippedS0: n("skipped_s0"),
        notFound: n("not_found"),
        failed: n("failed"),
    };
}
