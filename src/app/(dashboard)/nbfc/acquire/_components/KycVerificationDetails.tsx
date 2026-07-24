"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  digilockerTransactions,
  kycDocuments,
  kycVerifications,
} from "@/lib/db/schema";
import { extractOcrFields } from "@/lib/nbfc/ocr-display";

// The NBFC's OWN per-document verdict + supporting attachments (E-201/E-207),
// keyed by (doc_for, doc_key). Loaded once for the table and rendered in the
// per-row Action column.
interface VerdictAttachment {
  url: string;
  name: string;
  type: string;
  size: number;
}
interface NbfcVerdictRow {
  id: number;
  doc_for: string;
  doc_key: string;
  verdict: string;
  notes: string | null;
  attachments: VerdictAttachment[] | null;
  verified_at: string | null;
}

// What came BACK for a document after the NBFC asked for a correction: the
// admin's own upload + message (E-210, `verdict_id`-linked) and the dealer's
// re-upload travelling on the correction wrapper (E-200/E-209). Both are
// nbfc_doc_requests rows keyed to the same target_doc_key, so one thread fetch
// feeds the whole Response column.
interface ThreadItem {
  id: string;
  doc_label: string;
  upload_status: string | null;
  file_url: string | null;
  rejection_reason: string | null;
}
interface ThreadWrapper {
  id: string;
  request_type: string;
  status: string;
  doc_for: string;
  target_doc_key: string | null;
  nbfc_comments: string | null;
  admin_notes: string | null;
  attachments: VerdictAttachment[] | null;
  verdict_id: number | null;
  created_at: string;
  updated_at: string;
}
interface ThreadEntry {
  request: ThreadWrapper;
  items: ThreadItem[];
}

const DELIVERED = new Set(["pushed_to_nbfc", "closed"]);

/** When did this response land with the NBFC? Null while it's still in flight. */
function deliveredAt(w: ThreadWrapper): number | null {
  // An admin document reply (verdict_id set) is born 'pushed_to_nbfc'.
  if (!w.verdict_id && !DELIVERED.has(w.status)) return null;
  const t = new Date(w.updated_at ?? w.created_at).getTime();
  return isNaN(t) ? null : t;
}

// Map a Decentro verification_type to the canonical NBFC verdict doc_key.
function toDocKey(verificationType: string | null | undefined): string {
  const t = (verificationType ?? "").toLowerCase();
  if (t.includes("pan")) return "pan";
  if (t.includes("bank")) return "bank";
  if (t.includes("cibil") || t.includes("credit") || t.includes("equifax")) return "cibil";
  if (t.includes("rc") || t.includes("vehicle")) return "rc";
  if (t.includes("aadhaar") || t.includes("aadhar")) return "aadhaar";
  return t;
}

const VERDICT_TONE: Record<string, string> = {
  verified: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-rose-50 text-rose-700 border-rose-200",
  queried: "bg-amber-50 text-amber-700 border-amber-200",
};
const VERDICT_LABEL: Record<string, string> = {
  verified: "Approved",
  rejected: "Rejected",
  queried: "Correction",
  pending: "—",
};

// Read-only NBFC review of the Decentro KYC results. The same extracted detail
// the admin sees on /admin/kyc-review, surfaced for the lender of record — but
// without any of the admin's action UI (Accept/Reject/Re-run/OCR autofill).
// All data is already loaded server-side on the dossier; this component only
// parses `api_response` (jsonb) per verification_type and renders it.

type KycRow = typeof kycVerifications.$inferSelect;
type Aadhaar = typeof digilockerTransactions.$inferSelect;
type KycDoc = typeof kycDocuments.$inferSelect;

// ── shared formatting helpers (mirror CustomerDossierPanel) ─────────────────

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function titleCase(s: string | null | undefined): string {
  if (!s) return "—";
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const STATUS_TONE: Record<string, string> = {
  verified: "bg-emerald-50 text-emerald-700 border-emerald-200",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  accepted: "bg-emerald-50 text-emerald-700 border-emerald-200",
  uploaded: "bg-sky-50 text-sky-700 border-sky-200",
  in_progress: "bg-sky-50 text-sky-700 border-sky-200",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  no_history: "bg-amber-50 text-amber-700 border-amber-200",
  failed: "bg-rose-50 text-rose-700 border-rose-200",
  rejected: "bg-rose-50 text-rose-700 border-rose-200",
};

function StatusBadge({ status }: { status: string | null | undefined }) {
  const key = (status ?? "").toLowerCase();
  const cls = STATUS_TONE[key] ?? "bg-slate-50 text-slate-500 border-slate-200";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${cls}`}
    >
      {status ? titleCase(status) : "—"}
    </span>
  );
}

// ── small presentational primitives for the expanded detail panel ───────────

function DetailLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
      {children}
    </p>
  );
}

function KvTable({
  rows,
}: {
  rows: { label: string; value: React.ReactNode }[];
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.label} className="hover:bg-slate-50/60">
              <td className="px-3 py-2 text-slate-500">{r.label}</td>
              <td className="px-3 py-2 text-right font-medium text-slate-800">
                {r.value == null || r.value === "" ? (
                  <span className="text-slate-300">—</span>
                ) : (
                  r.value
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatchBadge({
  score,
  pass,
}: {
  score: number | null;
  pass: boolean;
}) {
  if (score === null) return <span className="text-xs text-slate-400">N/A</span>;
  if (score >= 80 && pass) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {score}% Strong match
      </span>
    );
  }
  if (pass) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        {score}% Weak match
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-700">
      <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
      {score}% Mismatch
    </span>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

// ── per-type detail renderers ────────────────────────────────────────────────

interface CrossMatchField {
  field: string;
  leadValue?: string | null;
  panValue?: string | null;
  aadhaarValue?: string | null;
  apiValue?: string | null;
  matchScore?: number | null;
  pass?: boolean;
}

function PanDetail({ row, docs }: { row: KycRow; docs: KycDoc[] }) {
  const resp = asObj(row.api_response);
  const data = asObj(resp?.data);
  const fields = (data?.crossMatchFields as CrossMatchField[] | undefined) ?? [];
  const message = str(resp?.message);

  if (fields.length === 0) {
    return <FallbackDetail row={row} note={message ?? undefined} docs={docs} />;
  }

  return (
    <div className="space-y-3">
      <DetailLabel>Verification match results</DetailLabel>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <th className="px-3 py-2">Field</th>
              <th className="px-3 py-2">As per lead</th>
              <th className="px-3 py-2">PAN card</th>
              <th className="px-3 py-2">Aadhaar</th>
              <th className="px-3 py-2">Match</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {fields.map((f) => (
              <tr
                key={f.field}
                className={
                  f.pass === false && f.matchScore != null ? "bg-rose-50/40" : ""
                }
              >
                <td className="px-3 py-2 font-semibold text-slate-700">
                  {titleCase(f.field)}
                </td>
                <td className="px-3 py-2 text-slate-600">
                  {f.leadValue || <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">
                  {f.panValue ?? f.apiValue ?? (
                    <span className="text-[10px] italic text-slate-300">
                      Not in response
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">
                  {f.aadhaarValue || <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2">
                  <MatchBadge
                    score={f.matchScore ?? null}
                    pass={f.pass ?? false}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {message ? <p className="text-xs text-slate-500">{message}</p> : null}
    </div>
  );
}

function BankDetail({ row, docs }: { row: KycRow; docs: KycDoc[] }) {
  const saved = asObj(row.api_response);
  if (!saved) return <FallbackDetail row={row} docs={docs} />;
  // DB stores the flat Decentro v2 body; fresh-verify wraps it as { data: {...} }.
  // Normalize both into one bag (mirrors BankCard).
  const nested = asObj(saved.data);
  const bank = nested ? { ...saved, ...nested } : saved;

  const accountStatus = str(bank.account_status ?? bank.accountStatus);
  const holder = str(
    bank.beneficiary_name ?? bank.beneficiaryName ?? bank.accountHolderName,
  );
  const nameMatch =
    bank.name_match_percentage ?? bank.nameMatchScore ?? row.match_score;
  const reference = str(
    bank.bank_reference_number ??
      bank.bankReferenceNumber ??
      bank.bankTxnId,
  );
  const validation = str(bank.validation_message);
  const message = str(saved.message);

  const isValid = (accountStatus ?? "").toLowerCase() === "valid";

  const bankRows = [
    {
      label: "Account status",
      value: accountStatus ? (
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${
                  isValid
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-rose-50 text-rose-700"
                }`}
              >
                {accountStatus}
              </span>
            ) : null,
          },
          { label: "Account holder (bank)", value: holder },
          {
            label: "Name match",
            value:
              nameMatch != null && nameMatch !== "" ? (
                <span
                  className={
                    Number(nameMatch) >= 80
                      ? "text-emerald-700"
                      : "text-rose-700"
                  }
                >
                  {Number(nameMatch)}%
                </span>
              ) : null,
          },
    { label: "Bank reference", value: reference },
    { label: "Validation", value: validation },
    { label: "Message", value: message },
  ].filter((r) => r.value != null);

  // Manually-accepted bank checks carry an api_response with no usable fields —
  // fall back to the uploaded bank document's OCR so the row isn't empty.
  if (bankRows.length === 0) return <FallbackDetail row={row} docs={docs} />;

  return (
    <div className="space-y-3">
      <DetailLabel>Verification results</DetailLabel>
      <KvTable rows={bankRows} />
    </div>
  );
}

function CibilDetail({ row }: { row: KycRow }) {
  const resp = asObj(row.api_response);
  const data = asObj(resp?.data);
  const consumerNotFound = Boolean(data?.consumerNotFound);
  const score =
    data?.score != null
      ? Number(data.score)
      : row.match_score != null
        ? Number(row.match_score)
        : null;
  const interpretation = asObj(data?.interpretation);
  const summary = asObj(data?.summary);
  const reportId = str(data?.reportId);
  const generatedAt = str(data?.generatedAt);

  if (consumerNotFound || (score == null && !summary)) {
    return (
      <div className="space-y-3">
        <DetailLabel>Verification result</DetailLabel>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-semibold">No credit history found</p>
          <p className="mt-1 text-amber-700">
            Consumer not found in the credit bureau — typically a first-time
            (new-to-credit) borrower.
          </p>
          {reportId ? (
            <p className="mt-2 text-xs text-amber-600">
              Report ID: {reportId}
              {generatedAt ? ` · Checked ${fmtDateTime(generatedAt)}` : ""}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const scoreColor =
    score == null
      ? "text-slate-400"
      : score >= 700
        ? "text-emerald-600"
        : score >= 650
          ? "text-amber-600"
          : "text-rose-600";

  return (
    <div className="space-y-3">
      <DetailLabel>Verification results</DetailLabel>
      <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-baseline gap-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Score
          </span>
          <span className={`text-3xl font-bold ${scoreColor}`}>
            {score ?? "—"}
          </span>
        </div>
        {interpretation?.rating ? (
          <p className="text-sm text-slate-600">
            Rating:{" "}
            <span className="font-semibold">{str(interpretation.rating)}</span>
            {interpretation.riskLevel
              ? ` · ${str(interpretation.riskLevel)} risk`
              : ""}
          </p>
        ) : null}
        {interpretation?.coBorrowerRequired ? (
          <p className="rounded-md bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
            Co-borrower KYC required for this score range.
          </p>
        ) : null}
        {reportId ? (
          <p className="text-xs text-slate-500">Report ID: {reportId}</p>
        ) : null}
        {generatedAt ? (
          <p className="text-xs text-slate-500">
            Generated: {fmtDateTime(generatedAt)}
          </p>
        ) : null}
      </div>
      {summary ? (
        <>
          <DetailLabel>Summary (full report)</DetailLabel>
          <KvTable
            rows={[
              { label: "Active loans", value: str(summary.activeLoans) },
              {
                label: "Total outstanding",
                value: str(summary.totalOutstanding),
              },
              {
                label: "Credit utilization",
                value: str(summary.creditUtilization),
              },
              {
                label: "Payment defaults",
                value: str(summary.paymentDefaults),
              },
              {
                label: "Recent enquiries",
                value: str(summary.recentEnquiries),
              },
              {
                label: "Oldest account age",
                value: str(summary.oldestAccountAge),
              },
              { label: "Credit mix", value: str(summary.creditMix) },
            ]}
          />
        </>
      ) : null}
    </div>
  );
}

function RcDetail({ row }: { row: KycRow }) {
  const resp = asObj(row.api_response);
  const data = asObj(resp?.data);
  const details = asObj(data?.rcDetails);
  if (!details) return <FallbackDetail row={row} />;

  const rcNumber = str(
    details.registrationNumber ?? details.rcNumber ?? data?.rcNumber,
  );
  const knownLabels: Record<string, string> = {
    chassisNumber: "Chassis number",
    engineNumber: "Engine number",
    registrationNumber: "Registration number",
    ownerName: "Owner name",
    vehicleType: "Vehicle type",
    makerModel: "Maker / model",
    registrationDate: "Registration date",
  };
  const rows = Object.entries(details)
    .map(([k, v]) => ({ label: knownLabels[k] ?? titleCase(k), value: str(v) }))
    .filter((r) => r.value != null);

  return (
    <div className="space-y-3">
      <DetailLabel>Vehicle (RC → chassis)</DetailLabel>
      {rcNumber ? (
        <p className="text-sm text-slate-600">
          RC number:{" "}
          <span className="font-mono font-medium text-slate-800">
            {rcNumber}
          </span>
        </p>
      ) : null}
      {rows.length > 0 ? (
        <KvTable rows={rows} />
      ) : (
        <p className="text-sm text-slate-400">No vehicle details in response.</p>
      )}
    </div>
  );
}

// Aadhaar cross-match field — Decentro/DigiLocker shape (similarity/threshold).
interface AadhaarCmField {
  field?: string;
  label?: string;
  leadValue?: string | null;
  aadhaarValue?: string | null;
  inputValue?: string | null;
  documentValue?: string | null;
  matchResult?: string;
  similarity?: number;
  threshold?: number;
  pass?: boolean;
}

interface AadhaarTableRow {
  label: string;
  leadValue: string | null;
  aadhaarValue: string | null;
  match: { similarity: number; threshold: number; pass: boolean } | null;
}

// Mirror of the admin AadhaarCard's buildAadhaarTableRows — assembles the
// Field / As-per-lead / As-per-Aadhaar / Match comparison from the cross-match
// fields, falling back to the raw extracted data for the Aadhaar column.
function buildAadhaarTableRows(
  extracted: Record<string, unknown>,
  fields: AadhaarCmField[],
): AadhaarTableRow[] {
  const cmByField = new Map<string, AadhaarCmField>();
  fields.forEach((f) => {
    if (f.field) cmByField.set(f.field.toLowerCase(), f);
  });
  const toMatch = (f: AadhaarCmField | undefined) => {
    if (!f || f.similarity == null) return null;
    const pass =
      f.pass ?? (f.matchResult === "strong" || f.matchResult === "moderate");
    return { similarity: f.similarity, threshold: f.threshold ?? 0, pass };
  };
  const cmLead = (f: AadhaarCmField | undefined) =>
    f?.leadValue ?? f?.inputValue ?? null;
  const cmAadhaar = (f: AadhaarCmField | undefined) =>
    f?.aadhaarValue ?? f?.documentValue ?? null;

  const gender =
    extracted.gender === "M"
      ? "Male"
      : extracted.gender === "F"
        ? "Female"
        : str(extracted.gender);
  const uid = str(extracted.uid ?? extracted.aadhaar_number);
  const maskedUid = uid ? `XXXX-XXXX-${uid.slice(-4)}` : null;

  const rows: AadhaarTableRow[] = [
    {
      label: "Name",
      leadValue: cmLead(cmByField.get("name")),
      aadhaarValue: cmAadhaar(cmByField.get("name")) || str(extracted.name),
      match: toMatch(cmByField.get("name")),
    },
    { label: "Aadhaar Number", leadValue: null, aadhaarValue: maskedUid, match: null },
    {
      label: "Date of Birth",
      leadValue: cmLead(cmByField.get("dob")),
      aadhaarValue: cmAadhaar(cmByField.get("dob")) || str(extracted.dob),
      match: toMatch(cmByField.get("dob")),
    },
    {
      label: "Gender",
      leadValue: cmLead(cmByField.get("gender")),
      aadhaarValue: cmAadhaar(cmByField.get("gender")) || gender,
      match: toMatch(cmByField.get("gender")),
    },
    {
      label: "Father / Husband",
      leadValue:
        cmLead(cmByField.get("careof")) || cmLead(cmByField.get("father_name")),
      aadhaarValue:
        cmAadhaar(cmByField.get("careof")) ||
        cmAadhaar(cmByField.get("father_name")) ||
        str(extracted.careof ?? extracted.careOf),
      match: toMatch(cmByField.get("careof") || cmByField.get("father_name")),
    },
    {
      label: "Address",
      leadValue: cmLead(cmByField.get("address")),
      aadhaarValue: cmAadhaar(cmByField.get("address")) || str(extracted.address),
      match: toMatch(cmByField.get("address")),
    },
  ];
  return rows.filter((r) => r.aadhaarValue || r.leadValue);
}

function AadhaarDetail({
  row,
  aadhaar,
}: {
  row: KycRow;
  aadhaar: Aadhaar | null;
}) {
  // Primary applicant: extracted data lives on the digilocker txn. Co-borrower:
  // it's folded into this row's api_response.data (aadhaarData / crossMatchResult).
  const respData = asObj(asObj(row.api_response)?.data);
  const extracted =
    asObj(aadhaar?.aadhaar_extracted_data) ??
    asObj(respData?.aadhaarData) ??
    asObj(respData?.aadhaar_extracted_data) ??
    {};
  const crossMatch =
    asObj(aadhaar?.cross_match_result) ??
    asObj(respData?.crossMatchResult) ??
    asObj(respData?.cross_match_result);

  const cmFields = Array.isArray(crossMatch?.fields)
    ? (crossMatch.fields as AadhaarCmField[])
    : [];

  // Preferred: the admin-style comparison table (needs cross-match fields[]).
  if (cmFields.length > 0) {
    const tableRows = buildAadhaarTableRows(extracted, cmFields);
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <DetailLabel>Aadhaar verification results</DetailLabel>
          {typeof crossMatch?.overallPass === "boolean" ? (
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                crossMatch.overallPass
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-rose-200 bg-rose-50 text-rose-700"
              }`}
            >
              {crossMatch.overallPass ? "Overall pass" : "Overall fail"}
            </span>
          ) : null}
        </div>
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2">Field name</th>
                <th className="px-3 py-2">As per lead</th>
                <th className="px-3 py-2">As per Aadhaar (DigiLocker)</th>
                <th className="px-3 py-2">Match</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tableRows.map((r) => (
                <tr key={r.label}>
                  <td className="px-3 py-2 font-semibold text-slate-700">
                    {r.label}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {r.leadValue || <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">
                    {r.aadhaarValue || <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {r.match ? (
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-medium ${
                          r.match.pass ? "text-emerald-700" : "text-rose-700"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            r.match.pass ? "bg-emerald-500" : "bg-rose-500"
                          }`}
                        />
                        {Math.round(r.match.similarity)}%
                        {!r.match.pass ? ` (need ${r.match.threshold}%)` : ""}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">N/A</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Fallback: no comparison fields — show extracted data + any flat-map chips.
  const kvRows = [
    { label: "Name", value: str(extracted.name) },
    { label: "Date of birth", value: str(extracted.dob) },
    { label: "Gender", value: str(extracted.gender) },
    { label: "Care of", value: str(extracted.careof ?? extracted.careOf) },
    { label: "Address", value: str(extracted.address) },
    { label: "District", value: str(extracted.district) },
    { label: "State", value: str(extracted.state) },
    { label: "Pincode", value: str(extracted.pincode) },
    {
      label: "Aadhaar (masked)",
      value: str(extracted.uid ?? extracted.aadhaar_number),
    },
  ].filter((r) => r.value != null);

  if (kvRows.length === 0 && !crossMatch) return <FallbackDetail row={row} />;

  return (
    <div className="space-y-3">
      {kvRows.length > 0 ? (
        <>
          <DetailLabel>Extracted Aadhaar data (DigiLocker)</DetailLabel>
          <KvTable rows={kvRows} />
        </>
      ) : null}
      {crossMatch ? <CrossMatchChips xm={crossMatch} /> : null}
    </div>
  );
}

function CrossMatchChips({ xm }: { xm: Record<string, unknown> }) {
  // Decentro/DigiLocker cross-match comes in two shapes: a flat
  // { field: {match, similarity} } map, or { fields: [{field, similarity, pass}] }.
  const entries: [string, unknown][] = Array.isArray(xm.fields)
    ? (xm.fields as Record<string, unknown>[]).map((f) => [
        String(f.field ?? ""),
        f,
      ])
    : Object.entries(xm).filter(([k]) => k !== "overallPass");
  if (entries.length === 0) return null;

  return (
    <div>
      <DetailLabel>Cross-match vs lead</DetailLabel>
      <div className="flex flex-wrap gap-2">
        {entries.map(([field, val]) => {
          const obj = asObj(val);
          const matched =
            obj && typeof obj.pass === "boolean"
              ? (obj.pass as boolean)
              : obj && typeof obj.match === "boolean"
                ? (obj.match as boolean)
                : typeof val === "boolean"
                  ? (val as boolean)
                  : null;
          const sim =
            obj && (typeof obj.similarity === "number" || typeof obj.score === "number")
              ? Number(obj.similarity ?? obj.score)
              : null;
          const tone =
            matched === true
              ? "border-emerald-200 text-emerald-700"
              : matched === false
                ? "border-rose-200 text-rose-700"
                : "border-slate-200 text-slate-600";
          const dot =
            matched === true
              ? "bg-emerald-500"
              : matched === false
                ? "bg-rose-500"
                : "bg-slate-400";
          return (
            <span
              key={field}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${tone}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
              {titleCase(field)}
              {sim != null ? ` · ${sim.toFixed(0)}%` : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// Pull the document(s) whose OCR backs this verification type, and surface the
// extracted fields — this is what the admin's "Autofill OCR" reads. Used when a
// verification was admin-accepted without storing a cross-match api_response.
const DOC_TYPES_FOR_VERIFICATION: Record<string, string[]> = {
  pan: ["pan_card"],
  bank: ["bank_statement", "cheque_1", "cheque_2", "cheque_3", "cheque_4", "passbook"],
  rc: ["rc_copy"],
  aadhaar: ["aadhaar_front", "aadhaar_back"],
};

function docOcrFallback(row: KycRow, docs: KycDoc[]): React.ReactNode | null {
  const t = (row.verification_type ?? "").toLowerCase();
  const family =
    t.includes("pan") ? "pan"
    : t.includes("bank") ? "bank"
    : t.includes("rc") || t.includes("vehicle") ? "rc"
    : t.includes("aadhaar") || t.includes("aadhar") ? "aadhaar"
    : null;
  if (!family) return null;
  const wanted = DOC_TYPES_FOR_VERIFICATION[family] ?? [];
  for (const doc of docs) {
    const dt = (doc.doc_type ?? "").toLowerCase();
    if (!wanted.includes(dt)) continue;
    const fields = extractOcrFields(doc.ocr_data, dt);
    if (fields.length > 0) {
      return (
        <div className="space-y-3">
          <DetailLabel>Extracted from uploaded document (OCR)</DetailLabel>
          <KvTable rows={fields.map((f) => ({ label: f.label, value: f.value }))} />
        </div>
      );
    }
  }
  return null;
}

function FallbackDetail({
  row,
  note,
  docs = [],
}: {
  row: KycRow;
  note?: string;
  docs?: KycDoc[];
}) {
  const resp = asObj(row.api_response);
  const data = asObj(resp?.data) ?? resp;
  const rows: { label: string; value: React.ReactNode }[] = [];
  if (row.match_score != null) {
    rows.push({ label: "Match score", value: `${row.match_score}%` });
  }
  if (data) {
    for (const [k, v] of Object.entries(data)) {
      const s = str(v);
      if (s != null && rows.length < 12) {
        rows.push({ label: titleCase(k), value: s });
      }
    }
  }
  if (rows.length > 0) {
    return (
      <div className="space-y-3">
        <DetailLabel>Verification detail</DetailLabel>
        <KvTable rows={rows} />
        {note ? <p className="text-xs text-slate-500">{note}</p> : null}
      </div>
    );
  }
  // No verification payload — fall back to the source document's OCR fields.
  const ocr = docOcrFallback(row, docs);
  if (ocr) return ocr;
  return (
    <p className="text-sm text-slate-400">
      {note ?? "No additional detail recorded for this verification."}
    </p>
  );
}

function renderDetail(
  row: KycRow,
  aadhaar: Aadhaar | null,
  docs: KycDoc[],
): React.ReactNode {
  const t = (row.verification_type ?? "").toLowerCase();
  if (t.includes("pan")) return <PanDetail row={row} docs={docs} />;
  if (t.includes("bank")) return <BankDetail row={row} docs={docs} />;
  if (t.includes("cibil") || t.includes("credit") || t.includes("equifax"))
    return <CibilDetail row={row} />;
  if (t.includes("rc") || t.includes("vehicle")) return <RcDetail row={row} />;
  if (t.includes("aadhaar") || t.includes("aadhar"))
    return <AadhaarDetail row={row} aadhaar={aadhaar} />;
  return <FallbackDetail row={row} docs={docs} />;
}

// ── main component ───────────────────────────────────────────────────────────

export default function KycVerificationDetails({
  rows,
  aadhaar,
  docs = [],
  leadId,
  docFor,
}: {
  rows: KycRow[];
  aadhaar: Aadhaar | null;
  docs?: KycDoc[];
  // When provided, an "Action" column lets the NBFC record its own verdict +
  // note + supporting uploads per document. Omit for a purely read-only table.
  leadId?: string;
  docFor?: "primary" | "co_borrower";
}) {
  // Hide the internal DigiO consent audit rows (esign_consent / esign_consent_sync)
  // and the address row — they aren't KYC document verdicts the NBFC reviews.
  const HIDDEN_TYPES = new Set([
    "address",
    "esign_consent",
    "esign_consent_sync",
  ]);
  const visible = rows.filter(
    (v) => !HIDDEN_TYPES.has((v.verification_type ?? "").toLowerCase()),
  );
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [verdicts, setVerdicts] = useState<Record<string, NbfcVerdictRow>>({});
  const [thread, setThread] = useState<ThreadEntry[]>([]);
  const actionable = Boolean(leadId && docFor);

  const loadVerdicts = useCallback(async () => {
    if (!leadId || !docFor) return;
    try {
      const [verdictRes, threadRes] = await Promise.all([
        fetch(`/api/nbfc/acquire/${leadId}/verify-doc`, { cache: "no-store" }),
        fetch(`/api/nbfc/acquire/${leadId}/doc-requests`, { cache: "no-store" }),
      ]);
      const verdictJson = await verdictRes.json();
      if (verdictJson.ok) {
        const map: Record<string, NbfcVerdictRow> = {};
        for (const v of (verdictJson.verdicts ?? []) as NbfcVerdictRow[]) {
          if ((v.doc_for ?? "primary") === docFor) map[v.doc_key] = v;
        }
        setVerdicts(map);
      }
      const threadJson = await threadRes.json();
      if (threadJson.ok) setThread((threadJson.thread ?? []) as ThreadEntry[]);
    } catch {
      // best-effort
    }
  }, [leadId, docFor]);

  useEffect(() => {
    if (actionable) loadVerdicts();
  }, [actionable, loadVerdicts]);

  if (visible.length === 0) {
    return <p className="text-sm text-slate-400">No verifications recorded.</p>;
  }

  // Everything the admin (or the dealer, via the admin) sent back, bucketed by
  // the document it answers — oldest first.
  const responsesFor = (docKey: string, verdict: NbfcVerdictRow | null) =>
    thread
      .filter(({ request: r }) => {
        if ((r.doc_for ?? "primary") !== docFor) return false;
        if (verdict && r.verdict_id === verdict.id) return true;
        return r.verdict_id == null && r.target_doc_key === docKey;
      })
      .sort(
        (a, b) =>
          new Date(a.request.created_at).getTime() -
          new Date(b.request.created_at).getTime(),
      );

  const colSpan = actionable ? 7 : 5;

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Admin action</th>
            <th className="px-3 py-2">Completed</th>
            {actionable ? <th className="px-3 py-2">Action</th> : null}
            {actionable ? <th className="px-3 py-2">Response</th> : null}
            <th className="px-3 py-2 text-right">Details</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {visible.map((v) => {
            const isOpen = open[v.id] ?? false;
            const docKey = toDocKey(v.verification_type);
            const verdict = verdicts[docKey] ?? null;
            const responses = actionable ? responsesFor(docKey, verdict) : [];
            // A response that landed AFTER our last verdict re-opens the row:
            // the Action control flips to "Re-review" so the NBFC decides again.
            const verdictAt = verdict?.verified_at
              ? new Date(verdict.verified_at).getTime()
              : 0;
            const needsReview = responses.some(({ request }) => {
              const at = deliveredAt(request);
              return at != null && at > verdictAt;
            });
            return (
              <Fragment key={v.id}>
                <tr className="hover:bg-slate-50/60">
                  <td
                    onClick={() => setOpen((o) => ({ ...o, [v.id]: !isOpen }))}
                    className="cursor-pointer px-3 py-2 font-medium text-slate-700"
                  >
                    {titleCase(v.verification_type)}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={v.status} />
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {v.admin_action ? titleCase(v.admin_action) : "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-500">
                    {fmtDate(v.completed_at ?? v.submitted_at)}
                  </td>
                  {actionable ? (
                    <td className="px-3 py-2">
                      <ActionCell
                        leadId={leadId as string}
                        docFor={docFor as "primary" | "co_borrower"}
                        docKey={docKey}
                        current={verdict}
                        needsReview={needsReview}
                        onDone={loadVerdicts}
                      />
                    </td>
                  ) : null}
                  {actionable ? (
                    <td className="px-3 py-2 align-top">
                      <ResponseCell
                        entries={responses}
                        verdictAt={verdictAt}
                        awaiting={
                          verdict?.verdict === "queried" ||
                          verdict?.verdict === "rejected"
                        }
                      />
                    </td>
                  ) : null}
                  <td
                    onClick={() => setOpen((o) => ({ ...o, [v.id]: !isOpen }))}
                    className="cursor-pointer px-3 py-2"
                  >
                    <span className="flex items-center justify-end gap-1 text-xs font-medium text-[color:var(--color-brand-sky)]">
                      {isOpen ? (
                        <>
                          Hide <ChevronDown className="h-3.5 w-3.5" />
                        </>
                      ) : (
                        <>
                          View details <ChevronRight className="h-3.5 w-3.5" />
                        </>
                      )}
                    </span>
                  </td>
                </tr>
                {isOpen ? (
                  <tr className="bg-slate-50/40">
                    <td colSpan={colSpan} className="px-4 py-4">
                      {renderDetail(v, aadhaar, docs)}
                      {v.admin_action_notes ? (
                        <p className="mt-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                          <span className="font-semibold text-slate-500">
                            Admin notes:{" "}
                          </span>
                          {v.admin_action_notes}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Per-row Response cell — what came back for this document ────────────────

const HOP_LABEL: Record<string, string> = {
  nbfc_raised: "Sent — with admin",
  admin_review: "With admin",
  forwarded_to_dealer: "Forwarded to dealer",
  with_customer: "Collecting from customer",
  dealer_review: "Dealer reviewing",
  admin_review_upload: "Admin reviewing upload",
  pushed_to_nbfc: "Response received",
  closed: "Closed",
  rejected: "Declined by admin",
};

function FileChip({ url, name }: { url: string; name: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1 truncate rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 hover:bg-sky-100"
    >
      <svg className="h-2.5 w-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
      </svg>
      <span className="truncate">{name}</span>
    </a>
  );
}

/**
 * Everything that came back to the NBFC for one document: the admin's message +
 * the documents shared with it (uploaded by the admin directly, or re-collected
 * from the dealer/customer). In-flight requests show their hop status instead,
 * so the NBFC always knows where its correction request stands.
 */
function ResponseCell({
  entries,
  verdictAt,
  awaiting,
}: {
  entries: ThreadEntry[];
  verdictAt: number;
  awaiting: boolean;
}) {
  if (entries.length === 0) {
    return (
      <span className="text-[11px] text-slate-400">
        {awaiting ? "Awaiting admin response" : "—"}
      </span>
    );
  }

  return (
    <div className="min-w-[13rem] max-w-[20rem] space-y-1.5">
      {entries.map(({ request: r, items }) => {
        const landed = deliveredAt(r);
        const isNew = landed != null && landed > verdictAt;
        const fromAdmin = r.verdict_id != null;
        const files = (r.attachments ?? []).filter((a) => a?.url);
        const returned = landed != null ? items.filter((it) => it.file_url) : [];
        return (
          <div
            key={r.id}
            className={`rounded-md border px-2 py-1.5 ${
              isNew
                ? "border-emerald-300 bg-emerald-50/70"
                : "border-slate-200 bg-white"
            }`}
          >
            <div className="flex items-center justify-between gap-1.5">
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                {isNew ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                ) : null}
                {fromAdmin
                  ? "Admin document"
                  : (HOP_LABEL[r.status] ?? r.status)}
              </span>
              <span className="shrink-0 text-[10px] text-slate-400">
                {fmtDateTime(r.updated_at ?? r.created_at)}
              </span>
            </div>

            {r.nbfc_comments ? (
              <p className="mt-0.5 whitespace-pre-line text-[11px] leading-snug text-slate-600">
                {/* On a forwarded correction the comments are the NBFC's own
                    ask — label it so the admin's reply reads as the answer. */}
                {!fromAdmin ? (
                  <span className="font-semibold text-slate-400">
                    Your request:{" "}
                  </span>
                ) : null}
                {r.nbfc_comments}
              </p>
            ) : null}
            {r.admin_notes && r.admin_notes !== r.nbfc_comments ? (
              <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
                <span className="font-semibold">Admin:</span> {r.admin_notes}
              </p>
            ) : null}

            {files.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {files.map((a, i) => (
                  <FileChip key={i} url={a.url} name={a.name} />
                ))}
              </div>
            ) : null}

            {returned.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {returned.map((it) => (
                  <FileChip
                    key={it.id}
                    url={it.file_url as string}
                    name={it.doc_label}
                  />
                ))}
              </div>
            ) : landed == null && items.length > 0 ? (
              <p className="mt-1 text-[10px] text-slate-400">
                {items.map((it) => it.doc_label).join(", ")} — awaiting upload
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ── Per-row Action cell — the NBFC's own verdict + note + supporting uploads ──

const ACTIONS: { key: "verified" | "rejected" | "queried"; label: string }[] = [
  { key: "verified", label: "Approve" },
  { key: "rejected", label: "Reject" },
  { key: "queried", label: "Request correction" },
];

function ActionCell({
  leadId,
  docFor,
  docKey,
  current,
  needsReview,
  onDone,
}: {
  leadId: string;
  docFor: "primary" | "co_borrower";
  docKey: string;
  current: NbfcVerdictRow | null;
  /** A response landed after our last verdict — the row is open again. */
  needsReview: boolean;
  onDone: () => void;
}) {
  const [openForm, setOpenForm] = useState(false);
  const [verdict, setVerdict] = useState<"verified" | "rejected" | "queried">(
    "verified",
  );
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      form.append("doc_for", docFor);
      form.append("doc_key", docKey);
      form.append("verdict", verdict);
      if (notes.trim()) form.append("notes", notes.trim());
      files.forEach((f) => form.append("files", f));
      const res = await fetch(`/api/nbfc/acquire/${leadId}/verify-doc/action`, {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (json.ok) {
        setOpenForm(false);
        setNotes("");
        setFiles([]);
        onDone();
      } else {
        setErr(json.error ?? "Could not save");
      }
    } catch {
      setErr("Network error");
    } finally {
      setBusy(false);
    }
  };

  const cur = current?.verdict ?? "pending";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpenForm((o) => !o)}
        title={
          needsReview
            ? "A response came back — record your decision again"
            : undefined
        }
        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold transition ${
          needsReview
            ? "border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-100"
            : (VERDICT_TONE[cur] ??
              "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
        }`}
      >
        {/* A response reopens the row: the stale verdict gives way to a fresh
            "Re-review" so the NBFC acts on what came back. */}
        {needsReview ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
            Re-review
          </>
        ) : (
          (VERDICT_LABEL[cur] ?? "Action")
        )}
        <ChevronDown className="h-3 w-3" />
      </button>
      {current?.attachments && current.attachments.length > 0 ? (
        <span className="ml-1 text-[10px] text-slate-400">
          · {current.attachments.length} file
          {current.attachments.length > 1 ? "s" : ""}
        </span>
      ) : null}
      {needsReview && cur !== "pending" ? (
        <p className="mt-0.5 text-[10px] text-slate-400">
          was {VERDICT_LABEL[cur] ?? cur}
        </p>
      ) : null}

      {openForm ? (
        <div className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
          <div className="mb-2 flex gap-1">
            {ACTIONS.map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => setVerdict(a.key)}
                className={`flex-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition ${
                  verdict === a.key
                    ? VERDICT_TONE[a.key]
                    : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
          <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {verdict === "verified" ? "Note (optional)" : "Message to admin"}
            {verdict !== "verified" ? <span className="text-rose-500"> *</span> : null}
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder={
              verdict === "verified"
                ? "Optional note…"
                : "Explain the reason / what needs correcting…"
            }
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
          />
          <label className="mt-2 mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Attach supporting documents (optional)
          </label>
          <input
            type="file"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="w-full text-[11px] file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-[11px]"
          />
          {files.length > 0 ? (
            <p className="mt-1 text-[10px] text-emerald-600">
              {files.length} file{files.length > 1 ? "s" : ""} attached — will be sent to the admin.
            </p>
          ) : null}
          {err ? (
            <p className="mt-1.5 text-[11px] text-rose-600">{err}</p>
          ) : null}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy || (verdict !== "verified" && !notes.trim())}
              onClick={submit}
              title={
                verdict !== "verified" && !notes.trim()
                  ? "Add a message explaining the reason"
                  : ""
              }
              className="rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "Send to admin"}
            </button>
            <button
              type="button"
              onClick={() => setOpenForm(false)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-[11px] font-medium text-slate-600"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
