"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  digilockerTransactions,
  kycDocuments,
  kycVerifications,
} from "@/lib/db/schema";
import { extractOcrFields } from "@/lib/nbfc/ocr-display";

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
}: {
  rows: KycRow[];
  aadhaar: Aadhaar | null;
  docs?: KycDoc[];
}) {
  const visible = rows.filter(
    (v) => (v.verification_type ?? "").toLowerCase() !== "address",
  );
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (visible.length === 0) {
    return <p className="text-sm text-slate-400">No verifications recorded.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Admin action</th>
            <th className="px-3 py-2">Completed</th>
            <th className="px-3 py-2 text-right">Details</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {visible.map((v) => {
            const isOpen = open[v.id] ?? false;
            return (
              <Fragment key={v.id}>
                <tr
                  onClick={() => setOpen((o) => ({ ...o, [v.id]: !isOpen }))}
                  className="cursor-pointer hover:bg-slate-50/60"
                >
                  <td className="px-3 py-2 font-medium text-slate-700">
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
                  <td className="px-3 py-2">
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
                    <td colSpan={5} className="px-4 py-4">
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
