import {
  FileText,
  ShieldCheck,
  UserRound,
  Users,
  FolderOpen,
  PackageCheck,
} from "lucide-react";
import type { CustomerDossier } from "@/lib/nbfc/dossier";
import { extractOcrFields, type OcrField } from "@/lib/nbfc/ocr-display";
import DossierActions from "./DossierActions";
import KycVerificationDetails from "./KycVerificationDetails";

// Verification-step customer dossier (Addendum V0.2 §6/§7) — the read-only
// review surface the NBFC sees before underwriting: everything the dealer
// gathered in Step 1 (capture), Step 2 (KYC) and Step 3 (co-borrower + docs),
// plus the product selection, with a Download (ZIP) + Next → Offer action bar.
// PII is shown in full (the picked NBFC is the lender of record).

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

function fmtInr(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function titleCase(s: string | null | undefined): string {
  if (!s) return "—";
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isImageUrl(url: string | null | undefined, type?: string | null): boolean {
  if (type && type.toLowerCase().startsWith("image")) return true;
  if (!url) return false;
  return /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i.test(url);
}

const STATUS_TONE: Record<string, string> = {
  verified: "bg-emerald-50 text-emerald-700 border-emerald-200",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  approved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  signed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  complete: "bg-emerald-50 text-emerald-700 border-emerald-200",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  uploaded: "bg-sky-50 text-sky-700 border-sky-200",
  in_progress: "bg-sky-50 text-sky-700 border-sky-200",
  reviewed: "bg-sky-50 text-sky-700 border-sky-200",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  not_started: "bg-slate-50 text-slate-500 border-slate-200",
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

function Field({
  k,
  v,
  span,
}: {
  k: string;
  v: React.ReactNode;
  span?: 1 | 2;
}) {
  return (
    <div className={span === 2 ? "col-span-2" : undefined}>
      <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
        {k}
      </dt>
      <dd className="mt-0.5 text-sm text-slate-700">
        {v == null || v === "" ? <span className="text-slate-300">—</span> : v}
      </dd>
    </div>
  );
}

function SectionCard({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[color:var(--color-brand-sky)]/10 text-[color:var(--color-brand-sky)]">
          {icon}
        </span>
        <div>
          <h3 className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
            {title}
          </h3>
          {hint ? <p className="text-[11px] text-slate-400">{hint}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function DocTile({
  label,
  url,
  type,
  status,
  ocrFields,
}: {
  label: string;
  url: string | null | undefined;
  type?: string | null;
  status?: string | null;
  ocrFields?: OcrField[];
}) {
  const img = isImageUrl(url, type);
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <a
        href={url ?? undefined}
        target="_blank"
        rel="noreferrer"
        className={`flex h-28 items-center justify-center bg-slate-50 ${
          url ? "hover:opacity-90" : "cursor-not-allowed"
        }`}
      >
        {img && url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="h-full w-full object-cover" />
        ) : (
          <FileText className="h-8 w-8 text-slate-300" />
        )}
      </a>
      <div className="flex items-center justify-between gap-2 px-2.5 py-2">
        <span className="truncate text-xs font-medium text-slate-600" title={label}>
          {titleCase(label)}
        </span>
        {status ? <StatusBadge status={status} /> : null}
      </div>
      {ocrFields && ocrFields.length > 0 ? (
        <dl className="space-y-0.5 border-t border-slate-100 bg-slate-50/60 px-2.5 py-2">
          {ocrFields.map((f) => (
            <div key={f.label} className="flex gap-1.5 text-[11px] leading-tight">
              <dt className="shrink-0 font-medium text-slate-400">{f.label}:</dt>
              <dd className="truncate text-slate-700" title={f.value}>
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

export default function CustomerDossierPanel({
  dossier,
  leadId,
  afterHero,
}: {
  dossier: CustomerDossier;
  leadId: string;
  /** Optional cards rendered right after the hero, before Customer details. */
  afterHero?: React.ReactNode;
}) {
  const { lead, productSelection: ps } = dossier;
  const batteryPhotos = (ps?.battery_photo_urls as string[] | null) ?? [];
  const chargerPhotos = (ps?.charger_photo_urls as string[] | null) ?? [];

  return (
    <div className="space-y-4">
      {/* Hero + actions */}
      <div className="overflow-hidden rounded-xl border border-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-3 bg-gradient-to-r from-[color:var(--color-brand-navy)] to-[color:var(--color-brand-sky)] px-5 py-4">
          <div className="flex items-center gap-3 text-white">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-sm font-bold">Customer Dossier</h2>
              <p className="text-[11px] text-white/80">
                Reviewed &amp; verified by the iTarang team — Steps 1–3
              </p>
            </div>
          </div>
        </div>
        <div className="bg-white px-5 py-3">
          <DossierActions leadId={leadId} />
        </div>
      </div>

      {afterHero}

      {/* 1 — Customer details */}
      <SectionCard
        icon={<UserRound className="h-4 w-4" />}
        title="Customer details"
        hint="Captured at lead intake (Step 1)"
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3">
          <Field k="Full name" v={lead.full_name ?? lead.owner_name} />
          <Field k="Phone" v={lead.phone ?? lead.mobile} />
          <Field k="Email" v={lead.owner_email} />
          <Field k="Date of birth" v={fmtDate(lead.dob)} />
          <Field k="Father / husband" v={lead.father_or_husband_name} />
          <Field
            k="Resident status"
            v={lead.resident_status ? titleCase(lead.resident_status) : null}
          />
          <Field k="City" v={lead.city} />
          <Field k="State" v={lead.state} />
          <Field
            k="KYC status"
            v={<StatusBadge status={lead.kyc_status} />}
          />
          <Field k="Permanent address" v={lead.permanent_address} span={2} />
          <Field k="Current address" v={lead.current_address} span={2} />
          <Field
            k="Health insurance"
            v={
              lead.has_health_insurance == null
                ? null
                : lead.has_health_insurance
                  ? "Yes"
                  : "No"
            }
          />
          <Field
            k="Life insurance"
            v={
              lead.has_life_insurance == null
                ? null
                : lead.has_life_insurance
                  ? "Yes"
                  : "No"
            }
          />
          <Field
            k="Consent"
            v={<StatusBadge status={lead.consent_status} />}
          />
        </dl>
      </SectionCard>

      {/* 2 — KYC verifications */}
      <SectionCard
        icon={<ShieldCheck className="h-4 w-4" />}
        title="KYC verifications"
        hint="Aadhaar / PAN / Bank / RC — verified via Decentro (Step 2)"
      >
        <KycVerificationDetails
          rows={dossier.customerKyc}
          aadhaar={dossier.aadhaar}
          docs={dossier.customerDocs}
          leadId={leadId}
          docFor="primary"
        />
      </SectionCard>

      {/* 3 — Documents */}
      <SectionCard
        icon={<FolderOpen className="h-4 w-4" />}
        title="Documents"
        hint="Uploaded KYC documents (Step 2)"
      >
        {dossier.customerDocs.length === 0 ? (
          <p className="text-sm text-slate-400">No documents uploaded.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {dossier.customerDocs.map((doc) => (
              <DocTile
                key={doc.id}
                label={doc.doc_type ?? doc.file_name ?? "Document"}
                url={doc.file_url}
                type={doc.file_type}
                ocrFields={extractOcrFields(doc.ocr_data, doc.doc_type)}
              />
            ))}
          </div>
        )}
      </SectionCard>

      {/* 4 — Co-borrower(s) */}
      {dossier.coBorrowers.length > 0 ? (
        <SectionCard
          icon={<Users className="h-4 w-4" />}
          title="Co-borrower"
          hint="Additional applicant (Step 3)"
        >
          <div className="space-y-5">
            {dossier.coBorrowers.map(({ info, docs }) => (
              <div key={info.id} className="space-y-3">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3">
                  <Field k="Full name" v={info.full_name} />
                  <Field k="Relationship" v={titleCase(info.relationship)} />
                  <Field k="Phone" v={info.phone} />
                  <Field k="Date of birth" v={fmtDate(info.dob)} />
                  <Field k="PAN" v={info.pan_no} />
                  <Field k="Aadhaar" v={info.aadhaar_no} />
                  <Field k="Income" v={fmtInr(info.income)} />
                  <Field
                    k="KYC status"
                    v={<StatusBadge status={info.kyc_status} />}
                  />
                  <Field
                    k="Consent"
                    v={<StatusBadge status={info.consent_status} />}
                  />
                </dl>
                {docs.length > 0 ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                    {docs.map((doc) => (
                      <DocTile
                        key={doc.id}
                        label={doc.document_type ?? doc.file_name ?? "Document"}
                        url={doc.document_url}
                        status={doc.verification_status ?? doc.status}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {dossier.coBorrowerKyc.length > 0 ? (
            <div className="mt-4">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Co-borrower KYC
              </p>
              <KycVerificationDetails
                rows={dossier.coBorrowerKyc}
                aadhaar={null}
                leadId={leadId}
                docFor="co_borrower"
              />
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {/* 5 — Supporting documents */}
      {dossier.supportingDocs.length > 0 ? (
        <SectionCard
          icon={<FileText className="h-4 w-4" />}
          title="Supporting documents"
          hint="Additional documents requested (Step 3)"
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {dossier.supportingDocs.map((od) => (
              <DocTile
                key={od.id}
                label={od.doc_label ?? od.document_name ?? "Document"}
                url={od.file_url ?? od.document_url}
                status={od.status ?? od.upload_status}
              />
            ))}
          </div>
        </SectionCard>
      ) : null}

      {/* 6 — Product selection */}
      <SectionCard
        icon={<PackageCheck className="h-4 w-4" />}
        title="Product selection"
        hint="Asset chosen by the customer (Section G)"
      >
        {ps ? (
          <>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3">
              <Field k="Battery serial" v={ps.battery_serial} />
              <Field k="Charger serial" v={ps.charger_serial} />
              <Field k="Category" v={ps.category} />
              <Field k="Model number" v={ps.model_number || dossier.productModel} />
              <Field k="Final price" v={fmtInr(ps.final_price)} />
              <Field k="Payment mode" v={titleCase(ps.payment_mode)} />
            </dl>
            {batteryPhotos.length > 0 || chargerPhotos.length > 0 ? (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {batteryPhotos.map((u, i) => (
                  <DocTile key={`b${i}`} label={`Battery ${i + 1}`} url={u} type="image" />
                ))}
                {chargerPhotos.map((u, i) => (
                  <DocTile key={`c${i}`} label={`Charger ${i + 1}`} url={u} type="image" />
                ))}
              </div>
            ) : null}
            {/* E-208 — Step-4 pre-sanction documents the dealer attached. */}
            {(() => {
              const docs = (ps.pre_sanction_doc_urls ?? []) as {
                url: string;
                name: string;
                type: string;
                size: number;
              }[];
              if (!Array.isArray(docs) || docs.length === 0) return null;
              return (
                <div className="mt-4">
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Pre-sanction documents ({docs.length})
                  </p>
                  <ul className="space-y-1.5">
                    {docs.map((d, i) => (
                      <li
                        key={`${d.url}-${i}`}
                        className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                      >
                        <a
                          href={d.url}
                          target="_blank"
                          rel="noreferrer"
                          className="min-w-0 flex-1 truncate font-medium text-[color:var(--color-brand-sky)] hover:underline"
                          title={d.name}
                        >
                          {d.name}
                        </a>
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-400">
                          {(d.type?.split("/")[1] || d.type || "file").slice(0, 8)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
          </>
        ) : (
          <p className="text-sm text-slate-400">No product selection recorded.</p>
        )}
      </SectionCard>
    </div>
  );
}
