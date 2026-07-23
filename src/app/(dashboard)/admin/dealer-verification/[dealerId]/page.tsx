"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import RequestCorrectionDialog from "@/components/admin/dealer-verification/RequestCorrectionDialog";
import CorrectionResponsePanel, {
  type CorrectionRound,
} from "@/components/admin/dealer-verification/CorrectionResponsePanel";
import {
  ArrowLeft,
  Building2,
  FileCheck2,
  ShieldCheck,
  Landmark,
  CircleAlert,
  CheckCircle2,
  XCircle,
  Clock3,
  Download,
  ExternalLink,
  RefreshCw,
  FileSignature,
  FileText,
  Pencil,
  Plus,
  X,
  Save,
  Languages,
  AlertTriangle,
  GitBranch,
  MessageCircle,
  UploadCloud,
  Loader2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

type DuplicateFlag = "none" | "branch" | "duplicate" | "pan-mismatch";

type DuplicateExistingAccount = {
  dealerCode: string;
  companyName: string | null;
  pan: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
};

type DuplicateCheckResult = {
  conflict: DuplicateFlag;
  existing: DuplicateExistingAccount | null;
  message: string | null;
  isBranchDealer?: boolean;
};

// ─── Types ───────────────────────────────────────────────────────────────────

type DocumentItem = {
  id?: string;
  name: string;
  url?: string | null;
  status?: string;
  documentType?: string;
  verificationStatus?: string | null;
  docStatus?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  uploadedAt?: string | null;
  rejectionReason?: string | null;
  storagePath?: string | null;
  bucketName?: string | null;
};

type AgreementParty = {
  name?: string | null;
  designation?: string | null;
  email?: string | null;
  mobile?: string | null;
  address?: string | null;
  signingMethod?: string | null;
};

type AgreementData = {
  agreementId?: string | null;
  signerName?: string | null;
  signerEmail?: string | null;
  status?: string | null;
  copyUrl?: string | null;
  signedAgreementUrl?: string | null;
  agreementName?: string | null;
  agreementVersion?: string | null;
  dateOfSigning?: string | null;
  mouDate?: string | null;
  financierName?: string | null;
  dealerSignerName?: string | null;
  dealerSignerDesignation?: string | null;
  dealerSignerEmail?: string | null;
  dealerSignerPhone?: string | null;
  dealerSigningMethod?: string | null;
  financierSignatory?: AgreementParty | null;
  itarangSignatory1?: AgreementParty | null;
  itarangSignatory2?: AgreementParty | null;
  signingOrder?: string[] | null;
  isOemFinancing?: boolean;
  vehicleType?: string | null;
  manufacturer?: string | null;
  brand?: string | null;
  statePresence?: string | null;
};

type OwnershipPerson = {
  id?: string;
  name?: string;
  phone?: string;
  landline?: string;
  email?: string;
  age?: string;
  addressLine1?: string;
  city?: string;
  district?: string;
  state?: string;
  pinCode?: string;
};

type AddressRoleUI = "billing" | "dispatch" | "other";
type GstAddressUI = {
  id: string;
  label: string;
  addressLine1: string;
  city: string;
  district: string;
  state: string;
  pincode: string;
  raw: string;
  roles: AddressRoleUI[];
};
type GstAddressesUI = {
  additionalCount: number;
  principal: GstAddressUI;
  additional: GstAddressUI[];
};

type DealerReviewData = {
  id: string;
  dealerId: string;
  companyName?: string;
  companyAddress?: string;
  gstNumber?: string;
  panNumber?: string;
  cinNumber?: string;
  companyType?: string;
  ownerName?: string;
  ownerPhone?: string;
  ownerEmail?: string;
  ownerAadhaarNo?: string;
  bankName?: string;
  accountNumber?: string;
  beneficiaryName?: string;
  ifscCode?: string;
  bankBranch?: string;
  accountType?: string;
  ownerAddressLine1?: string;
  ownerCity?: string;
  ownerDistrict?: string;
  ownerState?: string;
  ownerPinCode?: string;
  salesManagerName?: string;
  salesManagerEmail?: string;
  salesManagerMobile?: string;
  partners?: OwnershipPerson[];
  directors?: OwnershipPerson[];
  agreementLanguage?: string;   // ✅ NEW
  financeEnabled?: boolean;
  onboardingStatus?: string;
  reviewStatus?: string;
  submittedAt?: string | null;
  correctionRemarks?: string | null;
  rejectionRemarks?: string | null;
  correctionRound?: CorrectionRound | null;
  documents?: DocumentItem[];
  missingDocuments?: { type: string; label: string }[];
  agreement?: AgreementData | null;
  // E-167: collection channel + bot verification warnings.
  source?: string | null;
  waPhone?: string | null;
  verificationWarnings?: string[];
  // GST Principal + Additional Places of Business with billing/dispatch/other tags.
  gstAddresses?: GstAddressesUI;
};

type AgreementSignerRow = {
  id: string;
  signerRole: string;
  signerName: string;
  signerEmail?: string | null;
  signerMobile?: string | null;
  signingMethod?: string | null;
  signerStatus: string;
  signedAt?: string | null;
  providerSigningUrl?: string | null;
};

type AgreementTimelineItem = {
  id: string;
  eventType: string;
  signerRole?: string | null;
  eventStatus?: string | null;
  createdAt?: string | null;
};

type AgreementTrackingResponse = {
  applicationId: string;
  agreementId?: string | null;
  requestId?: string | null;
  agreementStatus?: string | null;
  reviewStatus?: string | null;
  signedAgreementUrl?: string | null;
  auditTrailUrl?: string | null;
  completionStatus?: string | null;
  stampStatus?: string | null;
  failureReason?: string | null;
  lastActionTimestamp?: string | null;
  canReInitiate?: boolean;
  signers: AgreementSignerRow[];
  timeline: AgreementTimelineItem[];
};

// ✅ NEW — shape for the edit form
type CompanyEditForm = {
  companyName: string;
  companyAddress: string;
  gstNumber: string;
  panNumber: string;
  cinNumber: string;
  companyType: string;
  ownerName: string;
  ownerPhone: string;
  ownerEmail: string;
  ownerAadhaarNo: string;
  bankName: string;
  accountNumber: string;
  beneficiaryName: string;
  ifscCode: string;
  bankBranch: string;
  accountType: string;
  ownerAddressLine1: string;
  ownerCity: string;
  ownerDistrict: string;
  ownerState: string;
  ownerPinCode: string;
  salesManagerName: string;
  salesManagerEmail: string;
  salesManagerMobile: string;
};


const AGREEMENT_LANGUAGE_OPTIONS = [
  { value: "english", label: "English Agreement" },
  { value: "hindi",   label: "Hindi Agreement"   },
  { value: "bengali", label: "Bengali Agreement"  },
];

// ─── SectionCard ─────────────────────────────────────────────────────────────

function SectionCard({
  title,
  subtitle,
  icon,
  children,
  headerRight,   // ✅ NEW optional slot for Edit button
}: {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  headerRight?: React.ReactNode;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.26 }}
      className="rounded-[28px] border border-slate-200 bg-white shadow-sm"
    >
      <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
        <div className="flex items-start gap-4">
          <div className="rounded-2xl bg-slate-50 p-3 text-slate-700">{icon}</div>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
            {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
          </div>
        </div>
        {headerRight && <div className="flex-shrink-0 pt-1">{headerRight}</div>}
      </div>
      <div className="p-6">{children}</div>
    </motion.section>
  );
}

// Document slots an admin can add/replace from the review panel. Values match
// the document_type strings stored across the web + WhatsApp onboarding flows.
const ADMIN_DOC_TYPES: { value: string; label: string }[] = [
  { value: "gst", label: "GST Certificate" },
  { value: "company_pan", label: "Company PAN" },
  { value: "bank_statement", label: "Bank Statement" },
  { value: "cancelled_cheque", label: "Cancelled Cheque" },
  { value: "udyam", label: "Udyam Registration" },
  { value: "itr", label: "ITR" },
  { value: "owner_photo", label: "Owner Photo" },
  { value: "owner_aadhaar", label: "Owner Aadhaar" },
  { value: "partner_photo", label: "Partner Photo" },
  { value: "partnership_deed", label: "Partnership Deed" },
  { value: "mou", label: "MOU" },
  { value: "aoa", label: "AOA" },
];

// ─── InfoField (read-only) ────────────────────────────────────────────────────

function InfoField({
  label,
  value,
  optional,
}: {
  label: string;
  value?: string | null;
  /** Truly-optional fields (landline, age, …) are not flagged when empty. */
  optional?: boolean;
}) {
  const isEmpty = !(value && String(value).trim());
  // Highlight empty/null values during review so the admin can spot gaps —
  // unless the field is explicitly optional.
  const flag = isEmpty && !optional;
  return (
    <div
      className={`rounded-2xl px-4 py-4 ${
        flag ? "border border-amber-300 bg-amber-50/70" : "bg-slate-50"
      }`}
    >
      <p
        className={`text-[11px] font-semibold uppercase tracking-[0.16em] ${
          flag ? "text-amber-700" : "text-slate-500"
        }`}
      >
        {label}
      </p>
      <p
        className={`mt-2 break-words text-sm font-medium ${
          flag ? "text-amber-700" : "text-slate-900"
        }`}
      >
        {isEmpty ? (
          <span className="inline-flex items-center gap-2">
            Not available
            {flag && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                Missing
              </span>
            )}
          </span>
        ) : (
          value
        )}
      </p>
    </div>
  );
}

// ✅ NEW — EditableField (edit mode)
function EditableField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-blue-200 bg-blue-50/40 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        {label}
      </p>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
      />
    </div>
  );
}

function SubsectionHeading({ label }: { label: string }) {
  return (
    <div className="mb-3 mt-6 flex items-center gap-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
        {label}
      </p>
      <div className="h-px flex-1 bg-slate-200" />
    </div>
  );
}

function OwnershipPersonCard({
  heading,
  person,
}: {
  heading: string;
  person: {
    name?: string;
    phone?: string;
    landline?: string;
    email?: string;
    age?: string;
    addressLine1?: string;
    city?: string;
    district?: string;
    state?: string;
    pinCode?: string;
  };
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
      <h4 className="mb-3 text-sm font-semibold text-slate-700">{heading}</h4>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <InfoField label="Name" value={person?.name} />
        <InfoField label="Phone" value={person?.phone} />
        <InfoField label="Email" value={person?.email} />
        <InfoField label="Landline" value={person?.landline} optional />
        <InfoField label="Age" value={person?.age} optional />
        <div className="md:col-span-2">
          <InfoField label="Address Line 1" value={person?.addressLine1} />
        </div>
        <InfoField label="City" value={person?.city} />
        <InfoField label="District" value={person?.district} />
        <InfoField label="State" value={person?.state} />
        <InfoField label="Pin Code" value={person?.pinCode} />
      </div>
    </div>
  );
}

// ─── GST Places of Business address cards ─────────────────────────────────────

const GST_ROLE_OPTIONS: { value: AddressRoleUI; label: string }[] = [
  { value: "billing", label: "Billing" },
  { value: "dispatch", label: "Dispatch" },
  { value: "other", label: "Other" },
];

function roleTextClasses(role: AddressRoleUI) {
  switch (role) {
    case "billing": return "font-semibold text-emerald-700";
    case "dispatch": return "font-semibold text-blue-700";
    default: return "font-semibold text-slate-700";
  }
}

/** Human display line for an address in read mode. */
function addressDisplay(a: GstAddressUI): string {
  if (a.raw && a.raw.trim()) return a.raw;
  return [a.addressLine1, a.city, a.district, a.state, a.pincode]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join(", ");
}

function GstAddressCard({
  address,
  editing,
  onFieldChange,
  onToggleRole,
  onRemove,
  removable,
}: {
  address: GstAddressUI;
  editing: boolean;
  onFieldChange: (field: keyof GstAddressUI, value: string) => void;
  onToggleRole: (role: AddressRoleUI) => void;
  onRemove?: () => void;
  removable?: boolean;
}) {
  const roles = Array.isArray(address.roles) ? address.roles : [];
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-700">{address.label}</h4>
        {editing && removable && onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-100"
          >
            Remove
          </button>
        ) : null}
      </div>

      {editing ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="md:col-span-2">
            <EditableField label="Address Line 1" value={address.addressLine1} onChange={(v) => onFieldChange("addressLine1", v)} />
          </div>
          <EditableField label="City"     value={address.city}     onChange={(v) => onFieldChange("city", v)} />
          <EditableField label="District" value={address.district} onChange={(v) => onFieldChange("district", v)} />
          <EditableField label="State"    value={address.state}    onChange={(v) => onFieldChange("state", v)} />
          <EditableField label="Pin Code" value={address.pincode}  onChange={(v) => onFieldChange("pincode", v)} />
        </div>
      ) : (
        <InfoField label="Address" value={addressDisplay(address)} />
      )}

      {/* Role checkboxes — always interactive (no edit mode needed). The admin
          can tick one or several (Billing / Dispatch / Other) per address. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Role
        </span>
        {GST_ROLE_OPTIONS.map((opt) => {
          const active = roles.includes(opt.value);
          return (
            <label
              key={opt.value}
              className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700"
            >
              <input
                type="checkbox"
                checked={active}
                onChange={() => onToggleRole(opt.value)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-2 focus:ring-blue-200"
              />
              <span className={active ? roleTextClasses(opt.value) : ""}>{opt.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ─── Badges (unchanged) ───────────────────────────────────────────────────────

function StatusBadge({ value }: { value?: string | null }) {
  const status = (value || "").toLowerCase();
  const classes =
    status === "completed" || status === "approved" || status === "succeed"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : status === "submitted" || status === "pending_admin_review" || status === "pending_sales_head"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : status === "under_review"
      ? "border-blue-200 bg-blue-50 text-blue-700"
      : status === "under_correction" || status === "correction_requested" || status === "action_needed"
      ? "border-orange-200 bg-orange-50 text-orange-700"
      : status === "rejected"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold capitalize ${classes}`}>
      {(value || "Unknown").replaceAll("_", " ")}
    </span>
  );
}

function AgreementBadge({ value }: { value?: string | null }) {
  const status = (value || "").toLowerCase();
  const classes =
    status === "completed" || status === "signed"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : status === "pending"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : status === "failed" || status === "expired"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : status === "viewed" || status === "sign_pending" || status === "sent_for_signature" || status === "sent_to_external_party"
      ? "border-blue-200 bg-blue-50 text-blue-700"
      : status === "partially_signed"
      ? "border-indigo-200 bg-indigo-50 text-indigo-700"
      : status === "not available" || status === ""
      ? "border-slate-200 bg-slate-50 text-slate-700"
      : "border-indigo-200 bg-indigo-50 text-indigo-700";
  return (
    <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold capitalize ${classes}`}>
      {(value || "Not available").replaceAll("_", " ")}
    </span>
  );
}

function SignerStatusBadge({ value }: { value?: string | null }) {
  const status = (value || "").toLowerCase();
  const classes =
    status === "signed"   ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : status === "viewed" ? "border-indigo-200 bg-indigo-50 text-indigo-700"
    : status === "sent"   ? "border-blue-200 bg-blue-50 text-blue-700"
    : status === "failed" ? "border-rose-200 bg-rose-50 text-rose-700"
    : status === "expired"? "border-amber-200 bg-amber-50 text-amber-700"
    : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold capitalize ${classes}`}>
      {(value || "pending").replaceAll("_", " ")}
    </span>
  );
}

// ─── ActionCard (unchanged) ───────────────────────────────────────────────────

function ActionCard({
  remarks, setRemarks, submitting,
  onApprove, onCorrection, onReject, onBack,
  financeEnabled, agreementStatus,
  duplicate,
  onboardingStatus,
  branchAck, setBranchAck,
}: {
  remarks: string;
  setRemarks: (value: string) => void;
  submitting: boolean;
  onApprove: () => void;
  onCorrection: () => void;
  onReject: () => void;
  onBack: () => void;
  financeEnabled?: boolean;
  agreementStatus?: string | null;
  duplicate?: DuplicateCheckResult | null;
  onboardingStatus?: string;
  branchAck: boolean;
  setBranchAck: (value: boolean) => void;
}) {
  const financeGateBlock =
    !!financeEnabled && (agreementStatus || "").toLowerCase() !== "completed";
  const duplicateBlock =
    duplicate?.conflict === "duplicate" ||
    duplicate?.conflict === "pan-mismatch";
  // Mirror the server guard at /api/admin/dealer-verifications/[id]/approve.
  // Blocking the button locally turns an alert popup into clear inline state.
  const submissionGateBlock =
    !!onboardingStatus && onboardingStatus !== "submitted";
  // Branch approvals must be explicitly acknowledged — the server rejects
  // them with 409 otherwise.
  const branchAckBlock = duplicate?.conflict === "branch" && !branchAck;
  const approvalBlocked =
    financeGateBlock || duplicateBlock || submissionGateBlock || branchAckBlock;

  return (
    <motion.aside
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.28 }}
      className="sticky top-6 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
    >
      <div className="flex items-center gap-3">
        <div className="rounded-2xl bg-slate-50 p-3 text-slate-700">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Review Action</h3>
          <p className="mt-1 text-sm text-slate-500">
            Approve, request corrections, or reject the application.
          </p>
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-start gap-3">
          <CircleAlert className="mt-0.5 h-4 w-4 text-slate-500" />
          <p className="text-sm text-slate-600">
            Add clear review notes for corrections or rejection so the sales team can act quickly.
          </p>
        </div>
      </div>

      {submissionGateBlock && (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <Clock3 className="mt-0.5 h-4 w-4 text-amber-600" />
            <p className="text-sm text-amber-800">
              Approval is blocked — the dealer hasn&apos;t submitted onboarding yet
              (current status:&nbsp;
              <span className="font-semibold">
                {(onboardingStatus || "").replaceAll("_", " ") || "draft"}
              </span>
              ). Ask the dealer to complete and submit the onboarding form before
              approving.
            </p>
          </div>
        </div>
      )}

      {financeGateBlock && (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <Clock3 className="mt-0.5 h-4 w-4 text-amber-600" />
            <p className="text-sm text-amber-800">
              Approval is blocked until the finance agreement reaches completed status.
            </p>
          </div>
        </div>
      )}

      {duplicate?.conflict === "branch" && duplicate.existing && (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <GitBranch className="mt-0.5 h-4 w-4 text-amber-600" />
            <div className="text-sm text-amber-900">
              <p className="font-semibold">Branch dealer — will link to existing account</p>
              <p className="mt-1 text-amber-800">
                This GSTIN already belongs to{" "}
                <strong>{duplicate.existing.companyName || duplicate.existing.dealerCode}</strong>{" "}
                (<code className="text-xs">{duplicate.existing.dealerCode}</code>). Addresses differ —
                approving will link this dealer as an additional location under the existing legal
                entity. Shared fields (GSTIN, PAN, bank details) will be read-only for this dealer.
              </p>
              <label className="mt-3 flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={branchAck}
                  onChange={(e) => setBranchAck(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-amber-300 accent-amber-600"
                />
                <span className="text-sm font-medium text-amber-900">
                  I understand this dealer will NOT get its own account — it won&apos;t
                  appear separately in inventory/dealer dropdowns and will operate under{" "}
                  {duplicate.existing.companyName || duplicate.existing.dealerCode}.
                </span>
              </label>
            </div>
          </div>
        </div>
      )}

      {duplicate?.conflict === "duplicate" && duplicate.existing && (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-rose-600" />
            <div className="text-sm text-rose-900">
              <p className="font-semibold">Approval blocked — duplicate dealer</p>
              <p className="mt-1 text-rose-800">
                Another dealer with the same GSTIN, PAN, and address already exists (
                <code className="text-xs">{duplicate.existing.dealerCode}</code>
                {duplicate.existing.companyName ? ` — ${duplicate.existing.companyName}` : ""}).
              </p>
            </div>
          </div>
        </div>
      )}

      {duplicate?.conflict === "pan-mismatch" && duplicate.existing && (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-rose-600" />
            <div className="text-sm text-rose-900">
              <p className="font-semibold">Approval blocked — PAN mismatch</p>
              <p className="mt-1 text-rose-800">
                This GSTIN is registered under a different PAN (
                <code className="text-xs">{duplicate.existing.pan || "unknown"}</code>). The data
                appears inconsistent — verify the applicant's PAN before approving.
              </p>
            </div>
          </div>
        </div>
      )}

      <textarea
        value={remarks}
        onChange={(e) => setRemarks(e.target.value)}
        placeholder="Write correction notes or rejection reason..."
        className="mt-5 min-h-[160px] w-full rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-900 outline-none transition focus:border-blue-400"
      />

      <div className="mt-5 grid grid-cols-1 gap-3">
        <button onClick={onApprove} disabled={submitting || approvalBlocked}
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
          <CheckCircle2 className="h-4 w-4" /> Approve & Activate
        </button>
        <button onClick={onCorrection} disabled={submitting}
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-amber-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50">
          <Clock3 className="h-4 w-4" /> Request Correction
        </button>
        <button onClick={onReject} disabled={submitting || !remarks.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-rose-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50">
          <XCircle className="h-4 w-4" /> Reject Application
        </button>
        <button onClick={onBack}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
          <ArrowLeft className="h-4 w-4" /> Back to Queue
        </button>
      </div>
    </motion.aside>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DealerReviewPage() {
  const params = useParams();
  const router = useRouter();
  const dealerId = params?.dealerId as string;

  const [data, setData]         = useState<DealerReviewData | null>(null);
  const [remarks, setRemarks]   = useState("");
  const [loading, setLoading]   = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // Explicit admin acknowledgement for branch-classified approvals — the
  // approve endpoint returns 409 without it.
  const [branchAck, setBranchAck] = useState(false);

  // ✅ NEW — edit state
  const [isEditing, setIsEditing]   = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editForm, setEditForm]     = useState<CompanyEditForm>({
    companyName: "", companyAddress: "", gstNumber: "", panNumber: "",
    cinNumber: "", companyType: "", ownerName: "", ownerPhone: "",
    ownerEmail: "", ownerAadhaarNo: "", bankName: "", accountNumber: "", beneficiaryName: "", ifscCode: "",
    bankBranch: "", accountType: "",
    ownerAddressLine1: "", ownerCity: "", ownerDistrict: "", ownerState: "", ownerPinCode: "",
    salesManagerName: "", salesManagerEmail: "", salesManagerMobile: "",
  });

  // GST Places of Business (principal + additional) with billing/dispatch/other
  // role tags. Edited in-place during edit mode; PATCHed alongside editForm.
  const [gstAddresses, setGstAddresses] = useState<GstAddressesUI | null>(null);
  const [gstSaving, setGstSaving] = useState(false);

  // ✅ NEW — agreement language state
  const [agreementLanguage, setAgreementLanguage] = useState("english");
  const [langSaving, setLangSaving]               = useState(false);
  const [langSaved, setLangSaved]                 = useState(false);

  const [agreementActionLoading, setAgreementActionLoading] = useState<
    "initiate" | "refresh" | "reinitiate" | "retry" | null
  >(null);
  // iTarang-side counter-signers, entered by the reviewing admin. For WhatsApp
  // dealers there is no Step-5 config, so these are the only source. Signer 1 is
  // mandatory; signer 2 is optional (validated only if any field is filled).
  const [itarangSigner, setItarangSigner] = useState({
    name: "",
    email: "",
    mobile: "",
  });
  const [itarangSigner2, setItarangSigner2] = useState({
    name: "",
    email: "",
    mobile: "",
  });
  // Signer 2 is hidden until the admin explicitly adds it via the + button.
  const [showSigner2, setShowSigner2] = useState(false);

  // Hard-coded iTarang Signer 1 default for WhatsApp dealers. WhatsApp dealers
  // have no Step-5 wizard to carry a signatory, and the same authorized
  // signatory counter-signs every WhatsApp agreement — so we pre-fill it once
  // the application loads. Only fills when the fields are still empty, so an
  // admin edit is never clobbered; the values remain editable before initiating.
  useEffect(() => {
    if ((data?.source || "").toLowerCase() !== "whatsapp") return;
    setItarangSigner((s) =>
      s.name || s.email || s.mobile
        ? s
        : {
            name: "Chirag garg",
            email: "chirag.itarang@gmail.com",
            mobile: "8796278200",
          },
    );
  }, [data?.source]);
  const [tracking, setTracking]             = useState<AgreementTrackingResponse | null>(null);
  const [trackingLoading, setTrackingLoading] = useState(false);
  const [auditTrailLoading, setAuditTrailLoading] = useState(false);
  // Manual agreement completion — upload the final signed agreement + audit
  // trail by hand when Digio signing was completed out-of-band.
  const [manualSignedFile, setManualSignedFile] = useState<File | null>(null);
  const [manualAuditFile, setManualAuditFile]   = useState<File | null>(null);
  const [manualUploading, setManualUploading]   = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateCheckResult | null>(null);
  const [correctionDialogOpen, setCorrectionDialogOpen] = useState(false);
  // Admin add/replace document
  const [docUploadType, setDocUploadType] = useState("gst");
  const [docUploadMode, setDocUploadMode] = useState<"add" | "replace">("add");
  const [docUploadFile, setDocUploadFile] = useState<File | null>(null);
  const [docUploading, setDocUploading] = useState(false);
  const [cancellingCorrection, setCancellingCorrection] = useState(false);

  // ─── loaders ───────────────────────────────────────────────────────────────

  const loadAgreementTracking = async () => {
    try {
      setTrackingLoading(true);
      const res  = await fetch(`/api/admin/dealer-verifications/${dealerId}/agreement-tracking`, { cache: "no-store" });
      const json = await res.json();
      if (json.success) setTracking(json.data); else setTracking(null);
    } catch (error) {
      console.error("Failed to load agreement tracking", error);
      setTracking(null);
    } finally {
      setTrackingLoading(false);
    }
  };

  useEffect(() => {
    const loadDealer = async () => {
      try {
        const res  = await fetch(`/api/admin/dealer-verifications/${dealerId}`);
        const json = await res.json();

        if (json.success) {
          const d: DealerReviewData = json.data;
          setData(d);

          // ✅ seed edit form & language from DB
          setEditForm({
            companyName:    d.companyName    || "",
            companyAddress: d.companyAddress || "",
            gstNumber:      d.gstNumber      || "",
            panNumber:      d.panNumber      || "",
            cinNumber:      d.cinNumber      || "",
            companyType:    d.companyType    || "",
            ownerName:      d.ownerName      || "",
            ownerPhone:     d.ownerPhone     || "",
            ownerEmail:     d.ownerEmail     || "",
            ownerAadhaarNo: d.ownerAadhaarNo || "",
            bankName:       d.bankName       || "",
            accountNumber:  d.accountNumber  || "",
            beneficiaryName: d.beneficiaryName || "",
            ifscCode:       d.ifscCode       || "",
            bankBranch:     d.bankBranch     || "",
            accountType:    d.accountType    || "",
            ownerAddressLine1: d.ownerAddressLine1 || "",
            ownerCity:      d.ownerCity      || "",
            ownerDistrict:  d.ownerDistrict  || "",
            ownerState:     d.ownerState     || "",
            ownerPinCode:   d.ownerPinCode   || "",
            salesManagerName:   d.salesManagerName   || "",
            salesManagerEmail:  d.salesManagerEmail  || "",
            salesManagerMobile: d.salesManagerMobile || "",
          });
          setGstAddresses(d.gstAddresses ?? null);
          setAgreementLanguage(d.agreementLanguage || "english");
        } else {
          setData(null);
        }
      } catch (error) {
        console.error("Failed to load dealer review data", error);
        setData(null);
        setTracking(null);
      } finally {
        // Render the page as soon as the (fast) detail fetch resolves. The
        // agreement-tracking panel and duplicate-check load independently below
        // with their own loading states — they must NOT block the page, because
        // agreement-tracking can do a slow Digio sync.
        setLoading(false);
      }

      // Agreement tracking — own loading state (trackingLoading); fire-and-forget.
      loadAgreementTracking();

      // Duplicate detection — non-blocking. If this errors we still show the
      // review page, just without the alert card.
      (async () => {
        try {
          const dupRes = await fetch(
            `/api/admin/dealer-verifications/${dealerId}/duplicate-check`
          );
          const dupJson = await dupRes.json();
          if (dupJson?.success) {
            setDuplicate({
              conflict: dupJson.conflict,
              existing: dupJson.existing,
              message: dupJson.message,
              isBranchDealer: dupJson.isBranchDealer,
            });
          }
        } catch (dupErr) {
          console.error("Failed to load duplicate-check", dupErr);
        }
      })();
    };

    if (dealerId) loadDealer();
  }, [dealerId]);

  // ─── edit handlers ─────────────────────────────────────────────────────────

  const handleEditField = (field: keyof CompanyEditForm) => (value: string) =>
    setEditForm((prev) => ({ ...prev, [field]: value }));

  // ─── GST address edit helpers ────────────────────────────────────────────────
  // Map an id-keyed mutation across principal + additional cards.
  const mutateGstAddress = (
    id: string,
    fn: (a: GstAddressUI) => GstAddressUI,
  ) =>
    setGstAddresses((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        principal: prev.principal.id === id ? fn(prev.principal) : prev.principal,
        additional: prev.additional.map((a) => (a.id === id ? fn(a) : a)),
      };
    });

  const handleGstFieldChange =
    (id: string) => (field: keyof GstAddressUI, value: string) =>
      mutateGstAddress(id, (a) => ({ ...a, [field]: value }));

  // Persist the gstAddresses object on its own (role checkboxes auto-save so the
  // admin can tag billing/dispatch/other directly, without entering edit mode).
  const persistGstAddresses = async (next: GstAddressesUI) => {
    try {
      setGstSaving(true);
      const res = await fetch(`/api/admin/dealer-verifications/${dealerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gstAddresses: next }),
      });
      const json = await res.json();
      if (json.success) {
        setData((prev) => (prev ? { ...prev, gstAddresses: next } : prev));
      } else {
        toast.error(json.message || "Failed to save address roles");
      }
    } catch (err) {
      console.error("Save GST roles error:", err);
      toast.error("Failed to save address roles");
    } finally {
      setGstSaving(false);
    }
  };

  // Toggle a role checkbox → update state AND auto-save immediately.
  const handleGstToggleRole = (id: string) => (role: AddressRoleUI) => {
    if (!gstAddresses) return;
    const apply = (a: GstAddressUI): GstAddressUI => {
      if (a.id !== id) return a;
      const roles = Array.isArray(a.roles) ? a.roles : [];
      return {
        ...a,
        roles: roles.includes(role)
          ? roles.filter((r) => r !== role)
          : [...roles, role],
      };
    };
    const next: GstAddressesUI = {
      ...gstAddresses,
      principal: apply(gstAddresses.principal),
      additional: gstAddresses.additional.map(apply),
    };
    setGstAddresses(next);
    void persistGstAddresses(next);
  };

  const handleAddGstAddress = () =>
    setGstAddresses((prev) => {
      const base: GstAddressesUI =
        prev ?? {
          additionalCount: 0,
          principal: {
            id: "principal",
            label: "Principal Place of Business",
            addressLine1: "", city: "", district: "", state: "", pincode: "", raw: "",
            roles: [],
          },
          additional: [],
        };
      const nextIndex = base.additional.length + 1;
      return {
        ...base,
        additional: [
          ...base.additional,
          {
            id: `add-${Date.now()}-${nextIndex}`,
            label: `Additional Place ${nextIndex}`,
            addressLine1: "", city: "", district: "", state: "", pincode: "", raw: "",
            roles: [],
          },
        ],
      };
    });

  const handleRemoveGstAddress = (id: string) =>
    setGstAddresses((prev) =>
      prev
        ? { ...prev, additional: prev.additional.filter((a) => a.id !== id) }
        : prev,
    );

  // Cards as a flat, ordered list for rendering + role-count validation.
  const gstAddressCards: GstAddressUI[] = gstAddresses
    ? [gstAddresses.principal, ...gstAddresses.additional]
    : [];
  const billingCount = gstAddressCards.filter((a) => a.roles?.includes("billing")).length;
  const dispatchCount = gstAddressCards.filter((a) => a.roles?.includes("dispatch")).length;
  const gstRoleWarning =
    gstAddressCards.length > 0 && (billingCount !== 1 || dispatchCount !== 1);

  const handleCancelEdit = () => {
    if (!data) return;
    setEditForm({
      companyName:    data.companyName    || "",
      companyAddress: data.companyAddress || "",
      gstNumber:      data.gstNumber      || "",
      panNumber:      data.panNumber      || "",
      cinNumber:      data.cinNumber      || "",
      companyType:    data.companyType    || "",
      ownerName:      data.ownerName      || "",
      ownerPhone:     data.ownerPhone     || "",
      ownerEmail:     data.ownerEmail     || "",
      ownerAadhaarNo: data.ownerAadhaarNo || "",
      bankName:       data.bankName       || "",
      accountNumber:  data.accountNumber  || "",
      beneficiaryName: data.beneficiaryName || "",
      ifscCode:       data.ifscCode       || "",
      bankBranch:     data.bankBranch     || "",
      accountType:    data.accountType    || "",
      ownerAddressLine1: data.ownerAddressLine1 || "",
      ownerCity:      data.ownerCity      || "",
      ownerDistrict:  data.ownerDistrict  || "",
      ownerState:     data.ownerState     || "",
      ownerPinCode:   data.ownerPinCode   || "",
      salesManagerName:   data.salesManagerName   || "",
      salesManagerEmail:  data.salesManagerEmail  || "",
      salesManagerMobile: data.salesManagerMobile || "",
    });
    setGstAddresses(data.gstAddresses ?? null);
    setIsEditing(false);
  };

  const handleSaveEdit = async () => {
    setEditSaving(true);
    try {
      const res  = await fetch(`/api/admin/dealer-verifications/${dealerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...editForm,
          ...(gstAddresses ? { gstAddresses } : {}),
        }),
      });
      const json = await res.json();
      if (!json.success) { toast.error(json.message || "Failed to save"); return; }

      // optimistic local update so UI reflects new values immediately
      setData((prev) =>
        prev ? { ...prev, ...editForm, ...(gstAddresses ? { gstAddresses } : {}) } : prev,
      );
      setIsEditing(false);
    } catch (err) {
      console.error("Save error:", err);
      toast.error("Something went wrong while saving.");
    } finally {
      setEditSaving(false);
    }
  };

  // ─── agreement language handler ────────────────────────────────────────────

  const handleLanguageChange = async (value: string) => {
    setAgreementLanguage(value);
    setLangSaving(true);
    setLangSaved(false);
    try {
      const res  = await fetch(`/api/admin/dealer-verifications/${dealerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreementLanguage: value }),
      });
      const json = await res.json();
      if (json.success) {
        setLangSaved(true);
        setTimeout(() => setLangSaved(false), 3000);
      } else {
        toast.error(json.message || "Failed to save language");
      }
    } catch (err) {
      console.error("Language save error:", err);
    } finally {
      setLangSaving(false);
    }
  };

  // ─── derived values ────────────────────────────────────────────────────────

  const documentCountLabel = useMemo(() => {
    const count = data?.documents?.length || 0;
    return count > 0 ? `${count} uploaded` : "No documents uploaded";
  }, [data?.documents]);

  const agreementStatusForUi    = tracking?.agreementStatus || data?.agreement?.status || null;
  const normalizedAgreementStatus = (agreementStatusForUi || "").toLowerCase();

  const hasInitiatedAgreement = !!(
    tracking?.requestId || tracking?.agreementId ||
    ["sent_for_signature","sent_to_external_party","sign_pending","viewed","partially_signed","signed","completed"]
      .includes(normalizedAgreementStatus)
  );

  const isAgreementCompleted = normalizedAgreementStatus === "completed";

  const verificationChecklist = useMemo(() => ({
    companyReady:   !!(data?.companyName && data?.gstNumber && data?.panNumber && data?.companyType),
    documentsReady: (data?.documents?.length || 0) > 0,
    bankReady:      !!(data?.bankName && data?.accountNumber && data?.beneficiaryName && data?.ifscCode),
    agreementReady: data?.financeEnabled
      ? (agreementStatusForUi || "").toLowerCase() === "completed"
      : true,
  }), [data, agreementStatusForUi]);

  const signedAgreementReady = ["signed","completed"].includes((agreementStatusForUi || "").toLowerCase());
  const isRejected           = (data?.onboardingStatus || "").toLowerCase() === "rejected";
  // The iTarang counter-signer is only captured/shown on this page for WhatsApp
  // dealers — web dealers carry their iTarang signatory from the Step-5 wizard
  // config (data.agreement.itarangSignatory1), so the admin neither enters nor
  // sees an iTarang Signers block for them.
  const isWhatsAppDealer     = (data?.source || "web").toLowerCase() === "whatsapp";

  // Primary signer = the dealer signer on the executed agreement. Once signing
  // completes, the reliable source is the synced signers table (tracking), which
  // Digio populates with the real name/email — the stored agreement snapshot is
  // often blank (WhatsApp dealers never fill a Step-5 signatory). Fall back to
  // the snapshot fields so nothing regresses for web dealers.
  const primarySigner = useMemo(() => {
    const dealerSigner = tracking?.signers?.find((s) => s.signerRole === "dealer");
    const trackedName =
      dealerSigner?.signerName && dealerSigner.signerName !== "Not available"
        ? dealerSigner.signerName
        : "";
    const name =
      trackedName ||
      data?.agreement?.signerName ||
      data?.agreement?.dealerSignerName ||
      "";
    const email =
      dealerSigner?.signerEmail ||
      data?.agreement?.signerEmail ||
      data?.agreement?.dealerSignerEmail ||
      "";
    return { name, email };
  }, [tracking?.signers, data?.agreement]);

  const reloadDealer = async () => {
    try {
      const [dr, tr] = await Promise.all([
        fetch(`/api/admin/dealer-verifications/${dealerId}`, { cache: "no-store" }),
        fetch(`/api/admin/dealer-verifications/${dealerId}/agreement-tracking`, { cache: "no-store" }),
      ]);
      const dj = await dr.json();
      const tj = await tr.json();
      if (dj.success) setData(dj.data);
      if (tj.success) setTracking(tj.data);
    } catch (error) {
      console.error("Failed to refresh", error);
    }
  };

  const handleCancelCorrection = async () => {
    if (cancellingCorrection) return;
    if (!window.confirm(
      "Cancel this correction request? The dealer's link will stop working and the application returns to review.",
    )) return;
    setCancellingCorrection(true);
    try {
      const res = await fetch(
        `/api/admin/dealer-verifications/${dealerId}/cancel-correction`,
        { method: "POST" },
      );
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error(json?.message || `Cancel failed (HTTP ${res.status})`);
        return;
      }
      toast.success(json.message || "Correction request cancelled");
      await reloadDealer();
    } catch (err) {
      console.error("Cancel correction failed", err);
      toast.error("Cancel failed");
    } finally {
      setCancellingCorrection(false);
    }
  };

  const handleDocUpload = async () => {
    if (!docUploadFile) { toast.error("Choose a file to upload."); return; }
    if (!docUploadType) { toast.error("Select a document type."); return; }
    setDocUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", docUploadFile);
      fd.append("documentType", docUploadType);
      fd.append("mode", docUploadMode);
      const res = await fetch(
        `/api/admin/dealer-verifications/${dealerId}/upload-document`,
        { method: "POST", body: fd },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast.error(json.message || "Upload failed");
        return;
      }
      toast.success(json.message || "Document uploaded");
      setDocUploadFile(null);
      await reloadDealer();
    } catch (err) {
      console.error("Admin doc upload failed", err);
      toast.error("Upload failed");
    } finally {
      setDocUploading(false);
    }
  };

  const handleAuditTrailDownload = async () => {
    if (!hasInitiatedAgreement) { toast.error("Agreement has not been initiated yet."); return; }
    if (!isAgreementCompleted)  { toast.error("Audit trail available only after agreement completion."); return; }

    setAuditTrailLoading(true);
    try {
      const res = await fetch(`/api/admin/dealer-verifications/${dealerId}/audit-trail`);
      const ct = res.headers.get("content-type") || "";

      if (!res.ok) {
        if (ct.includes("json")) {
          const err = await res.json().catch(() => null);
          toast.error(err?.message || `Audit trail download failed (HTTP ${res.status})`);
        } else {
          toast.error(`Audit trail download failed (HTTP ${res.status})`);
        }
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-trail-${dealerId}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err: any) {
      toast.error(err?.message || "Failed to download audit trail");
    } finally {
      setAuditTrailLoading(false);
    }
  };

  const handleManualUpload = async () => {
    if (!manualSignedFile || !manualAuditFile) {
      toast.error("Select both the signed agreement PDF and the audit trail PDF.");
      return;
    }
    setManualUploading(true);
    try {
      const fd = new FormData();
      fd.append("signedAgreement", manualSignedFile);
      fd.append("auditTrail", manualAuditFile);

      const res = await fetch(
        `/api/admin/dealer-verifications/${dealerId}/upload-signed-agreement`,
        { method: "POST", body: fd },
      );
      let json: any = null;
      try { json = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok || !json?.success) {
        toast.error(json?.message || `Upload failed (HTTP ${res.status})`);
        return;
      }
      toast.success(json.message || "Agreement marked completed.");
      setManualSignedFile(null);
      setManualAuditFile(null);
      await reloadDealer();
    } catch (err: any) {
      toast.error(err?.message || "Something went wrong while uploading documents");
    } finally {
      setManualUploading(false);
    }
  };

  const handleAgreementAction = async (action: "initiate" | "refresh" | "reinitiate" | "retry") => {
    if (data?.onboardingStatus === "rejected") { toast.error("This application is rejected and locked."); return; }

    // Resolve the iTarang signer: admin-entered form wins, else any saved config.
    const itarang1 = (itarangSigner.name || itarangSigner.email || itarangSigner.mobile)
      ? {
          name: itarangSigner.name.trim(),
          email: itarangSigner.email.trim(),
          mobile: itarangSigner.mobile.replace(/[^\d]/g, ""),
          signingMethod: "aadhaar_esign",
        }
      : data?.agreement?.itarangSignatory1 || null;

    // iTarang signer 2 is optional: only included (and validated) if the admin
    // started filling it in. Empty → null so we don't fabricate a 3rd signer.
    const itarang2Started = showSigner2 && !!(itarangSigner2.name || itarangSigner2.email || itarangSigner2.mobile);
    const itarang2 = itarang2Started
      ? {
          name: itarangSigner2.name.trim(),
          email: itarangSigner2.email.trim(),
          mobile: itarangSigner2.mobile.replace(/[^\d]/g, ""),
          signingMethod: "aadhaar_esign",
        }
      : data?.agreement?.itarangSignatory2 || null;

    if (action === "initiate" || action === "reinitiate") {
      const isEmail = (v?: string | null) => !!v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      const isPhone = (v?: string | null) => !!v && v.replace(/[^\d]/g, "").length >= 10;

      if (!itarang1?.name || !isEmail(itarang1?.email) || !isPhone(itarang1?.mobile)) {
        toast.error("Enter the iTarang Signer 1 name, a valid email, and a 10-digit phone before initiating.");
        return;
      }
      if (itarang2Started && (!itarang2?.name || !isEmail(itarang2?.email) || !isPhone(itarang2?.mobile))) {
        toast.error("iTarang Signer 2 is optional, but if added it needs a valid name, email, and 10-digit phone.");
        return;
      }
    }

    setAgreementActionLoading(action);
    try {
      const payload = action === "initiate" || action === "reinitiate"
        ? { agreementConfig: {
            agreementName: data?.agreement?.agreementName || "Dealer Finance Enablement Agreement",
            agreementVersion: "v1.0",
            dateOfSigning: data?.agreement?.dateOfSigning || "",
            mouDate: data?.agreement?.mouDate || "",
            financierName: data?.agreement?.financierName || "",
            dealerSignerName: data?.agreement?.dealerSignerName || "",
            dealerSignerDesignation: data?.agreement?.dealerSignerDesignation || "",
            dealerSignerEmail: data?.agreement?.dealerSignerEmail || "",
            dealerSignerPhone: data?.agreement?.dealerSignerPhone || "",
            dealerSigningMethod: data?.agreement?.dealerSigningMethod || "",
            financierSignatory: data?.agreement?.financierSignatory || null,
            itarangSignatory1:  itarang1,
            itarangSignatory2:  itarang2,
            signingOrder: ["dealer","financier","itarang_1","itarang_2"],
            isOemFinancing: !!data?.agreement?.isOemFinancing,
            vehicleType: data?.agreement?.vehicleType || "",
            manufacturer: data?.agreement?.manufacturer || "",
            brand: data?.agreement?.brand || "",
            statePresence: data?.agreement?.statePresence || "",
          }}
        : {};

      const res  = await fetch(`/api/admin/dealer-verifications/${dealerId}/${action}-agreement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "initiate" || action === "reinitiate" ? payload : {}),
      });
      let json: any = null;
      try { json = await res.json(); } catch { json = null; }
      if (!res.ok || !json?.success) { toast.error(json?.message || "Agreement action failed"); return; }
      await reloadDealer();
    } catch (error) {
      console.error(`Failed to ${action} agreement`, error);
      toast.error("Something went wrong while processing agreement action");
    } finally {
      setAgreementActionLoading(null);
    }
  };

  const handleApprove = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/dealer-verifications/${dealerId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledgeBranch: branchAck }),
      });
      let json: any = null;
      try { json = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok || !json?.success) {
        toast.error(json?.message || `Approve failed (HTTP ${res.status})`);
        return;
      }
      router.push("/admin/dealer-verification");
    } catch (err: any) {
      toast.error(err?.message || "Something went wrong while approving");
    } finally { setSubmitting(false); }
  };

  // TEST-ONLY: skip the Digio agreement + signing flow and approve the dealer
  // directly. Hits the same /approve endpoint with devBypassAgreement so the
  // dealer still gets real credentials + welcome email/WhatsApp, just without
  // the signing round-trip. Not part of the normal production path.
  const handleDevApprove = async () => {
    if (data?.onboardingStatus === "rejected") { toast.error("This application is rejected and locked."); return; }
    if (!window.confirm("Testing only: approve this dealer directly, skipping the agreement & signing flow? They will receive login credentials and a welcome message.")) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/dealer-verifications/${dealerId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledgeBranch: true, devBypassAgreement: true }),
      });
      let json: any = null;
      try { json = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok || !json?.success) {
        toast.error(json?.message || `Direct approve failed (HTTP ${res.status})`);
        return;
      }
      toast.success(json?.emailSent ? "Dealer approved — welcome credentials sent." : "Dealer approved.");
      router.push("/admin/dealer-verification");
    } catch (err: any) {
      toast.error(err?.message || "Something went wrong while approving");
    } finally { setSubmitting(false); }
  };

  const handleCorrection = () => {
    setCorrectionDialogOpen(true);
  };

  const handleReject = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/dealer-verifications/${dealerId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remarks }),
      });
      let json: any = null;
      try { json = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok || !json?.success) {
        toast.error(json?.message || `Reject failed (HTTP ${res.status})`);
        return;
      }
      router.push("/admin/dealer-verification");
    } catch (err: any) {
      toast.error(err?.message || "Something went wrong while rejecting");
    } finally { setSubmitting(false); }
  };

  // ─── loading / error states ────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="rounded-[28px] border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
        Loading dealer review...
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-[28px] border border-rose-200 bg-rose-50 p-6 text-sm text-rose-600 shadow-sm">
        Dealer review data not found.
      </div>
    );
  }

  // ✅ NEW — Edit / Save / Cancel button cluster for the section header
  const companyCardHeaderRight = (
    <div className="flex items-center gap-2">
      {isEditing ? (
        <>
          <button
            onClick={handleCancelEdit}
            disabled={editSaving}
            className="inline-flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" /> Cancel
          </button>
          <button
            onClick={handleSaveEdit}
            disabled={editSaving}
            className="inline-flex items-center gap-1.5 rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {editSaving ? "Saving…" : "Save Changes"}
          </button>
        </>
      ) : (
        <button
          onClick={() => setIsEditing(true)}
          className="inline-flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
      )}
    </div>
  );

  // ─── render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-8">

      {/* ── page header (unchanged) ── */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28 }}
        className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-slate-400">Dealer Review</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">
              {[data.ownerName, data.companyName].map((v) => (v || "").trim()).filter(Boolean).join(" / ") || "Dealer Application"}
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-500">
              Validate company data, uploaded documents, and agreement workflow before final activation.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {(data.source || "web").toLowerCase() === "whatsapp" && (
              <span
                title={`Collected via the WhatsApp onboarding bot${data.waPhone ? ` (+${data.waPhone})` : ""}. Fields were auto-extracted; review the verification warnings below.`}
                className="inline-flex items-center gap-1.5 rounded-2xl border border-green-200 bg-green-50 px-3 py-2 text-xs font-semibold text-green-700"
              >
                <MessageCircle className="h-3.5 w-3.5" />
                WhatsApp{data.waPhone ? ` · +${data.waPhone}` : ""}
              </span>
            )}
            <StatusBadge value={data.onboardingStatus} />
            <StatusBadge value={data.reviewStatus} />
            {data.financeEnabled ? <AgreementBadge value={agreementStatusForUi} /> : null}
            <a
              href={`/admin/dealer-verification/${dealerId}/nbfcs`}
              className="inline-flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
              title="NBFCs explicitly blocked for this dealer. By default, all geo-matched NBFCs auto-enroll into Section G."
            >
              <Landmark className="h-3.5 w-3.5" />
              Excluded NBFCs
            </a>
          </div>
        </div>

        {data.onboardingStatus === "correction_requested" && (
          <div className="mt-6 rounded-2xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-800">
            <div className="flex items-start gap-3">
              <CircleAlert className="mt-0.5 h-4 w-4" />
              <div>
                <p className="font-semibold">Correction Requested</p>
                <p className="mt-1">Admin has requested corrections for this application. Update the required details and save the form for re-validation.</p>
                {data?.correctionRemarks && <p className="mt-2 text-xs"><strong>Remarks:</strong> {data.correctionRemarks}</p>}
                <button
                  type="button"
                  onClick={handleCancelCorrection}
                  disabled={cancellingCorrection}
                  className="mt-3 inline-flex items-center gap-2 rounded-full border border-orange-300 bg-white px-3 py-1.5 text-xs font-semibold text-orange-700 transition hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {cancellingCorrection ? "Cancelling…" : "Cancel correction request"}
                </button>
              </div>
            </div>
          </div>
        )}

        {data.onboardingStatus === "rejected" && (
          <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            <div className="flex items-start gap-3">
              <XCircle className="mt-0.5 h-4 w-4" />
              <div>
                <p className="font-semibold">Application Rejected</p>
                <p className="mt-1">This onboarding application has been rejected and is now locked.</p>
                {data?.rejectionRemarks && <p className="mt-2 text-xs"><strong>Reason:</strong> {data.rejectionRemarks}</p>}
              </div>
            </div>
          </div>
        )}

        {Array.isArray(data.verificationWarnings) && data.verificationWarnings.length > 0 && (
          <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <div>
                <p className="font-semibold">
                  {data.verificationWarnings.length} verification warning
                  {data.verificationWarnings.length !== 1 ? "s" : ""} from automated checks
                </p>
                <p className="mt-1 text-xs text-rose-600">
                  The WhatsApp bot ran document checks (Decentro) during collection. These did not pass cleanly — verify manually before approving.
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                  {data.verificationWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Submitted At</p>
            <p className="mt-2 text-sm font-medium text-slate-900">
              {data.submittedAt ? new Date(data.submittedAt).toLocaleString() : "Not available"}
            </p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Company Type</p>
            <p className="mt-2 text-sm font-medium capitalize text-slate-900">
              {(data.companyType || "Not available").replaceAll("_", " ")}
            </p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Document Status</p>
            <p className="mt-2 text-sm font-medium text-slate-900">{documentCountLabel}</p>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Verification Progress</p>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "Company Details",    ready: verificationChecklist.companyReady },
              { label: "Documents Uploaded", ready: verificationChecklist.documentsReady },
              { label: "Bank Details",       ready: verificationChecklist.bankReady },
              { label: data.financeEnabled ? "Agreement" : "No Finance Agreement", ready: verificationChecklist.agreementReady },
            ].map(({ label, ready }) => (
              <div key={label} className="flex items-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-medium text-slate-700">
                {ready ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Clock3 className="h-4 w-4 text-amber-500" />}
                {label}
              </div>
            ))}
          </div>
        </div>
      </motion.div>

      {/* ── main grid ── */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">

          {/* ✅ SECTION 1 — Company Details (now editable) */}
          <SectionCard
            title="Section 1 — Company Details"
            subtitle="Review legal entity details, registered identifiers, and payout information."
            icon={<Building2 className="h-5 w-5" />}
            headerRight={companyCardHeaderRight}
          >
            {/* editing hint banner */}
            {isEditing && (
              <div className="mb-4 flex items-center gap-2 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3">
                <Pencil className="h-4 w-4 text-blue-500" />
                <p className="text-sm font-medium text-blue-700">
                  Editing mode — click Save Changes to persist to the database.
                </p>
              </div>
            )}

            <SubsectionHeading label="Company & Registered Details" />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {isEditing ? (
                <>
                  <EditableField label="Company Name"           value={editForm.companyName}    onChange={handleEditField("companyName")} />
                  <EditableField label="Company Address"        value={editForm.companyAddress} onChange={handleEditField("companyAddress")} />
                  <EditableField label="GST Number"             value={editForm.gstNumber}      onChange={handleEditField("gstNumber")} />
                  <EditableField label="PAN Number"             value={editForm.panNumber}      onChange={handleEditField("panNumber")} />
                  {/* A sole proprietorship is not an incorporated company and has no CIN. */}
                  {editForm.companyType !== "sole_proprietorship" && (
                    <EditableField label="CIN Number"           value={editForm.cinNumber}      onChange={handleEditField("cinNumber")} />
                  )}
                  <EditableField label="Company Type"           value={editForm.companyType}    onChange={handleEditField("companyType")} />
                  <EditableField label="Primary Contact Name"   value={editForm.ownerName}      onChange={handleEditField("ownerName")} />
                  <EditableField label="Primary Contact Phone"  value={editForm.ownerPhone}     onChange={handleEditField("ownerPhone")} />
                  <EditableField label="Primary Contact Email"  value={editForm.ownerEmail}     onChange={handleEditField("ownerEmail")} />
                  <EditableField label="Owner Aadhaar (12 digits)" value={editForm.ownerAadhaarNo} onChange={handleEditField("ownerAadhaarNo")} />
                </>
              ) : (
                <>
                  <InfoField label="Company Name"          value={data.companyName} />
                  <InfoField label="Company Address"       value={data.companyAddress} />
                  <InfoField label="GST Number"            value={data.gstNumber} />
                  <InfoField label="PAN Number"            value={data.panNumber} />
                  {/* A sole proprietorship is not an incorporated company and has no CIN. */}
                  {data.companyType !== "sole_proprietorship" && (
                    <InfoField label="CIN Number"          value={data.cinNumber} />
                  )}
                  <InfoField label="Company Type"          value={data.companyType?.replaceAll("_", " ")} />
                  <InfoField label="Primary Contact Name"  value={data.ownerName} />
                  <InfoField label="Primary Contact Phone" value={data.ownerPhone} />
                  <InfoField label="Primary Contact Email" value={data.ownerEmail} />
                  <InfoField label="Owner Aadhaar"         value={data.ownerAadhaarNo ? `XXXX XXXX ${data.ownerAadhaarNo.slice(-4)}` : "Not on file"} />
                </>
              )}
            </div>

            {/* GST Places of Business — principal + additional addresses the
                admin tags as billing / dispatch / other. */}
            {gstAddressCards.length > 0 && (
              <>
                <SubsectionHeading label="GST Places of Business" />
                <p className="mb-3 flex items-center gap-2 text-xs text-slate-500">
                  Tick the role(s) for each address — Billing, Dispatch and/or
                  Other. You can tick one or several; changes save automatically.
                  {gstSaving && (
                    <span className="inline-flex items-center gap-1 text-blue-600">
                      <Loader2 className="h-3 w-3 animate-spin" /> Saving…
                    </span>
                  )}
                </p>
                {gstRoleWarning && (
                  <div className="mb-3 flex items-center gap-2 rounded-2xl border border-amber-300 bg-amber-50/70 px-4 py-3">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <p className="text-sm font-medium text-amber-700">
                      Assign exactly one Billing address and one Dispatch address
                      ({billingCount} billing, {dispatchCount} dispatch selected).
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-4">
                  {gstAddresses && (
                    <GstAddressCard
                      address={gstAddresses.principal}
                      editing={isEditing}
                      onFieldChange={handleGstFieldChange(gstAddresses.principal.id)}
                      onToggleRole={handleGstToggleRole(gstAddresses.principal.id)}
                    />
                  )}
                  {gstAddresses?.additional.map((addr) => (
                    <GstAddressCard
                      key={addr.id}
                      address={addr}
                      editing={isEditing}
                      onFieldChange={handleGstFieldChange(addr.id)}
                      onToggleRole={handleGstToggleRole(addr.id)}
                      removable
                      onRemove={() => handleRemoveGstAddress(addr.id)}
                    />
                  ))}
                </div>
                {isEditing && (
                  <button
                    type="button"
                    onClick={handleAddGstAddress}
                    className="mt-3 inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                  >
                    + Add address
                  </button>
                )}
              </>
            )}

            {/* Owner residential address — only applies to sole proprietorship */}
            {(data.companyType === "sole_proprietorship" ||
              isEditing ||
              data.ownerAddressLine1 ||
              data.ownerCity ||
              data.ownerPinCode) && (
              <>
                <SubsectionHeading label="Owner Residential Address" />
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {isEditing ? (
                    <>
                      <EditableField label="Address Line 1" value={editForm.ownerAddressLine1} onChange={handleEditField("ownerAddressLine1")} />
                      <EditableField label="City"           value={editForm.ownerCity}         onChange={handleEditField("ownerCity")} />
                      <EditableField label="District"       value={editForm.ownerDistrict}     onChange={handleEditField("ownerDistrict")} />
                      <EditableField label="State"          value={editForm.ownerState}        onChange={handleEditField("ownerState")} />
                      <EditableField label="Pin Code"       value={editForm.ownerPinCode}      onChange={handleEditField("ownerPinCode")} />
                    </>
                  ) : (
                    <>
                      <InfoField label="Address Line 1" value={data.ownerAddressLine1} />
                      <InfoField label="City"           value={data.ownerCity} />
                      <InfoField label="District"       value={data.ownerDistrict} />
                      <InfoField label="State"          value={data.ownerState} />
                      <InfoField label="Pin Code"       value={data.ownerPinCode} />
                    </>
                  )}
                </div>
              </>
            )}

            <SubsectionHeading label="Bank Details" />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {isEditing ? (
                <>
                  <EditableField label="Bank Name"        value={editForm.bankName}        onChange={handleEditField("bankName")} />
                  <EditableField label="Account Number"   value={editForm.accountNumber}   onChange={handleEditField("accountNumber")} />
                  <EditableField label="Beneficiary Name" value={editForm.beneficiaryName} onChange={handleEditField("beneficiaryName")} />
                  <EditableField label="IFSC Code"        value={editForm.ifscCode}        onChange={handleEditField("ifscCode")} />
                  <EditableField label="Bank Branch"      value={editForm.bankBranch}      onChange={handleEditField("bankBranch")} />
                  <EditableField label="Account Type"     value={editForm.accountType}     onChange={handleEditField("accountType")} />
                </>
              ) : (
                <>
                  <InfoField label="Bank Name"        value={data.bankName} />
                  <InfoField label="Account Number"   value={data.accountNumber} />
                  <InfoField label="Beneficiary Name" value={data.beneficiaryName} />
                  <InfoField label="IFSC Code"        value={data.ifscCode} />
                  <InfoField label="Bank Branch"      value={data.bankBranch} />
                  <InfoField
                    label="Account Type"
                    value={
                      data.accountType
                        ? data.accountType.charAt(0).toUpperCase() + data.accountType.slice(1)
                        : ""
                    }
                  />
                </>
              )}
            </div>

            <SubsectionHeading label="Sales Manager" />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {isEditing ? (
                <>
                  <EditableField label="Name"   value={editForm.salesManagerName}   onChange={handleEditField("salesManagerName")} />
                  <EditableField label="Email"  value={editForm.salesManagerEmail}  onChange={handleEditField("salesManagerEmail")} />
                  <EditableField label="Mobile" value={editForm.salesManagerMobile} onChange={handleEditField("salesManagerMobile")} />
                </>
              ) : (
                <>
                  <InfoField label="Name"   value={data.salesManagerName} />
                  <InfoField label="Email"  value={data.salesManagerEmail} />
                  <InfoField label="Mobile" value={data.salesManagerMobile} />
                </>
              )}
            </div>

            {/* Read-only partner / director roster — admins can request
                corrections on these via the existing correction flow. */}
            {(data.partners?.length || 0) > 0 && (
              <>
                <SubsectionHeading label={`Partners (${data.partners?.length})`} />
                <div className="space-y-3">
                  {data.partners!.map((p, i) => (
                    <OwnershipPersonCard key={p.id || `partner-${i}`} heading={`Partner ${i + 1}`} person={p} />
                  ))}
                </div>
              </>
            )}

            {(data.directors?.length || 0) > 0 && (
              <>
                <SubsectionHeading label={`Directors (${data.directors?.length})`} />
                <div className="space-y-3">
                  {data.directors!.map((d, i) => (
                    <OwnershipPersonCard key={d.id || `director-${i}`} heading={`Director ${i + 1}`} person={d} />
                  ))}
                </div>
              </>
            )}
          </SectionCard>

          {/* ── Section 2 — Document Verification (unchanged) ── */}
          <SectionCard
            title="Section 2 — Document Verification"
            subtitle="Validate uploaded onboarding and compliance records."
            icon={<FileCheck2 className="h-5 w-5" />}
          >
            {data.missingDocuments && data.missingDocuments.length > 0 && (
              <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <p className="text-sm font-semibold text-amber-800">
                    {data.missingDocuments.length} document
                    {data.missingDocuments.length > 1 ? "s" : ""} missing
                  </p>
                </div>
                <p className="mt-1 text-xs text-amber-700">
                  {(data.ownerName || data.companyName || "This dealer")}
                  {data.waPhone ? ` (WhatsApp +${data.waPhone})` : ""} hasn&apos;t provided:
                </p>
                <ul className="mt-2 space-y-1">
                  {data.missingDocuments.map((m) => (
                    <li key={m.type} className="text-sm font-medium text-amber-900">
                      • {m.label}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.documents && data.documents.length > 0 ? (
              <div className="space-y-3">
                {data.documents.map((doc, index) => (
                  <motion.div
                    key={doc.id || `${doc.name}-${index}`}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22, delay: index * 0.04 }}
                    className="flex flex-col gap-3 rounded-2xl border border-slate-200 p-4 md:flex-row md:items-center md:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900">{doc.name}</p>
                      {doc.documentType && <p className="mt-1 text-xs text-slate-400">Type: {doc.documentType.replaceAll("_", " ")}</p>}
                      {doc.rejectionReason && <p className="mt-1 text-xs text-rose-500">Reason: {doc.rejectionReason}</p>}
                    </div>
                    {doc.url ? (
                      <a href={doc.url} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
                        <ExternalLink className="h-4 w-4" /> View Document
                      </a>
                    ) : (
                      <span className="text-sm text-slate-400">No link available</span>
                    )}
                  </motion.div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
                No uploaded documents available yet.
              </div>
            )}

            {/* Admin add / replace document */}
            {!isRejected && (
              <div className="mt-6 rounded-2xl border border-blue-200 bg-blue-50/50 p-5">
                <div className="flex items-start gap-3">
                  <UploadCloud className="mt-0.5 h-5 w-5 text-blue-600" />
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-blue-900">Add or replace a document</p>
                    <p className="mt-1 text-xs text-blue-800">
                      Upload a missing document, or replace an existing one (the previous copy is
                      kept as superseded history).
                    </p>
                    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-700">Document type</label>
                        <select
                          value={docUploadType}
                          onChange={(e) => setDocUploadType(e.target.value)}
                          className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                        >
                          {ADMIN_DOC_TYPES.map((d) => (
                            <option key={d.value} value={d.value}>{d.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-700">Mode</label>
                        <select
                          value={docUploadMode}
                          onChange={(e) => setDocUploadMode(e.target.value as "add" | "replace")}
                          className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                        >
                          <option value="add">Add</option>
                          <option value="replace">Replace</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-700">File (PDF / image)</label>
                        <input
                          type="file"
                          accept="application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp"
                          onChange={(e) => setDocUploadFile(e.target.files?.[0] || null)}
                          className="mt-2 block w-full text-xs text-slate-700 file:mr-3 file:rounded-xl file:border-0 file:bg-blue-100 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-blue-800 hover:file:bg-blue-200"
                        />
                      </div>
                      <div className="flex items-end">
                        <button
                          onClick={handleDocUpload}
                          disabled={docUploading || !docUploadFile}
                          className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
                        >
                          <UploadCloud className="h-4 w-4" />
                          {docUploading ? "Uploading…" : docUploadMode === "replace" ? "Replace" : "Add"}
                        </button>
                      </div>
                    </div>
                    {docUploadFile && (
                      <p className="mt-2 truncate text-xs text-emerald-700">✓ {docUploadFile.name}</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </SectionCard>

          {/* ── Section 3 — Agreement Verification (unchanged) ── */}
          {data.financeEnabled === true && (
            <SectionCard
              title="Section 3 — Agreement Verification"
              subtitle="Review agreement execution state for finance-enabled dealer onboarding."
              icon={<Landmark className="h-5 w-5" />}
            >
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <InfoField label="Agreement ID" value={tracking?.agreementId || data.agreement?.agreementId || undefined} />
                <div className="rounded-2xl bg-slate-50 px-4 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Agreement Status</p>
                  <div className="mt-2"><AgreementBadge value={agreementStatusForUi || undefined} /></div>
                </div>
                <InfoField label="Primary Signer Name"  value={primarySigner.name  || undefined} />
                <InfoField label="Primary Signer Email" value={primarySigner.email || undefined} />
              </div>

              <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="mb-1 flex items-center gap-2">
                  <Languages className="h-4 w-4 text-slate-500" />
                  <p className="text-sm font-semibold text-slate-800">Agreement Language</p>
                  {langSaving && (
                    <span className="text-xs text-slate-400">Saving…</span>
                  )}
                  {langSaved && !langSaving && (
                    <span className="inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                      ✓ Saved
                    </span>
                  )}
                </div>
                <p className="mb-3 text-xs text-slate-500">
                  Select the language for the dealer agreement document.
                </p>
                <select
                  value={agreementLanguage}
                  onChange={(e) => handleLanguageChange(e.target.value)}
                  className="h-11 w-full max-w-xs rounded-2xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 cursor-pointer"
                >
                  {AGREEMENT_LANGUAGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                {(signedAgreementReady || tracking?.signedAgreementUrl) && (
                  <button onClick={() => window.open(`/api/admin/dealer-verifications/${dealerId}/download-signed-agreement`, "_blank")}
                    className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700">
                    <Download className="h-4 w-4" /> Download Signed Agreement
                  </button>
                )}
                <button onClick={handleAuditTrailDownload}
                  disabled={auditTrailLoading || isRejected || !isAgreementCompleted}
                  className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  <FileText className="h-4 w-4" />
                  {auditTrailLoading ? "Downloading Audit Trail…" : "Download Audit Trail"}
                </button>
              </div>

              {/* Manual agreement completion — for agreements whose completion
                  can't be synced from Digio: an expired signer link, signing
                  finished out-of-band on the Digio dashboard, or a document
                  created in a different Digio environment that 404s here. Shown
                  for any initiated-but-not-completed agreement. Upload the final
                  PDFs to mark it completed and unblock approval. */}
              {hasInitiatedAgreement && !isAgreementCompleted && !isRejected && (
                <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/60 p-5">
                  <div className="flex items-start gap-3">
                    <UploadCloud className="mt-0.5 h-5 w-5 text-amber-600" />
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-amber-900">
                        Agreement completed outside iTarang?
                      </p>
                      <p className="mt-1 text-xs text-amber-800">
                        If all parties signed on the Digio dashboard (e.g. a signer&apos;s link
                        expired here), upload the final <strong>signed agreement</strong> and
                        <strong> audit trail</strong> PDFs. This stores both documents and marks
                        the agreement <strong>completed</strong> so the dealer can be approved.
                      </p>

                      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div>
                          <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-700">
                            Signed Agreement (PDF)
                          </label>
                          <input
                            type="file"
                            accept="application/pdf,.pdf"
                            onChange={(e) => setManualSignedFile(e.target.files?.[0] || null)}
                            className="mt-2 block w-full text-xs text-slate-700 file:mr-3 file:rounded-xl file:border-0 file:bg-amber-100 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-amber-800 hover:file:bg-amber-200"
                          />
                          {manualSignedFile && (
                            <p className="mt-1 truncate text-xs text-emerald-700">✓ {manualSignedFile.name}</p>
                          )}
                        </div>
                        <div>
                          <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-700">
                            Audit Trail (PDF)
                          </label>
                          <input
                            type="file"
                            accept="application/pdf,.pdf"
                            onChange={(e) => setManualAuditFile(e.target.files?.[0] || null)}
                            className="mt-2 block w-full text-xs text-slate-700 file:mr-3 file:rounded-xl file:border-0 file:bg-amber-100 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-amber-800 hover:file:bg-amber-200"
                          />
                          {manualAuditFile && (
                            <p className="mt-1 truncate text-xs text-emerald-700">✓ {manualAuditFile.name}</p>
                          )}
                        </div>
                      </div>

                      <button
                        onClick={handleManualUpload}
                        disabled={manualUploading || !manualSignedFile || !manualAuditFile}
                        className="mt-4 inline-flex items-center gap-2 rounded-2xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <UploadCloud className="h-4 w-4" />
                        {manualUploading ? "Saving…" : "Save & Mark Completed"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* iTarang Signer 1 — entered by the reviewing admin. Required to
                  initiate; the dealer signer is auto-filled from the owner
                  contact on the backend. WhatsApp-only: web dealers carry their
                  iTarang signatory from the Step-5 wizard config. */}
              {isWhatsAppDealer && !hasInitiatedAgreement && !isRejected && (
                <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
                  <div className="mb-1 flex items-center gap-2">
                    <FileSignature className="h-4 w-4 text-slate-500" />
                    <p className="text-sm font-semibold text-slate-800">iTarang Signer 1</p>
                    <span className="text-xs text-rose-500">*required</span>
                  </div>
                  <p className="mb-3 text-xs text-slate-500">
                    The iTarang authorized signatory who counter-signs this agreement.
                    They&apos;ll be notified by <strong>email</strong>.
                    {(data.source || "web").toLowerCase() === "whatsapp"
                      ? " The dealer receives their sign link on WhatsApp."
                      : ""}
                  </p>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    <input
                      value={itarangSigner.name}
                      onChange={(e) => setItarangSigner((s) => ({ ...s, name: e.target.value }))}
                      placeholder="Full name"
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    />
                    <input
                      type="email"
                      value={itarangSigner.email}
                      onChange={(e) => setItarangSigner((s) => ({ ...s, email: e.target.value }))}
                      placeholder="Email"
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    />
                    <input
                      value={itarangSigner.mobile}
                      onChange={(e) => setItarangSigner((s) => ({ ...s, mobile: e.target.value }))}
                      placeholder="Phone (10 digits)"
                      inputMode="numeric"
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    />
                  </div>

                  {/* iTarang Signer 2 — optional. Hidden until the admin clicks
                      "Add iTarang Signer 2". */}
                  {!showSigner2 ? (
                    <button
                      type="button"
                      onClick={() => setShowSigner2(true)}
                      className="mt-5 inline-flex items-center gap-2 rounded-2xl border border-dashed border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-blue-400 hover:text-blue-600"
                    >
                      <Plus className="h-4 w-4" /> Add iTarang Signer 2
                    </button>
                  ) : (
                    <div className="mt-5 border-t border-slate-100 pt-4">
                      <div className="mb-1 flex items-center gap-2">
                        <FileSignature className="h-4 w-4 text-slate-400" />
                        <p className="text-sm font-semibold text-slate-700">iTarang Signer 2</p>
                        <span className="text-xs text-slate-400">optional</span>
                        <button
                          type="button"
                          onClick={() => { setShowSigner2(false); setItarangSigner2({ name: "", email: "", mobile: "" }); }}
                          className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-slate-400 transition hover:text-rose-500"
                        >
                          <X className="h-3.5 w-3.5" /> Remove
                        </button>
                      </div>
                      <p className="mb-3 text-xs text-slate-500">
                        Second iTarang authorized signatory. Also notified by <strong>email</strong>.
                      </p>
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        <input
                          value={itarangSigner2.name}
                          onChange={(e) => setItarangSigner2((s) => ({ ...s, name: e.target.value }))}
                          placeholder="Full name"
                          className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                        />
                        <input
                          type="email"
                          value={itarangSigner2.email}
                          onChange={(e) => setItarangSigner2((s) => ({ ...s, email: e.target.value }))}
                          placeholder="Email"
                          className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                        />
                        <input
                          value={itarangSigner2.mobile}
                          onChange={(e) => setItarangSigner2((s) => ({ ...s, mobile: e.target.value }))}
                          placeholder="Phone (10 digits)"
                          inputMode="numeric"
                          className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* After initiation: show iTarang signers read-only (sourced from the
                  persisted signer rows, so the values can't be edited).
                  WhatsApp-only — web dealers don't surface an iTarang Signers
                  block on this page. */}
              {isWhatsAppDealer && hasInitiatedAgreement && (tracking?.signers?.some((s) => (s.signerRole || "").startsWith("itarang"))) && (
                <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-5">
                  <div className="mb-3 flex items-center gap-2">
                    <FileSignature className="h-4 w-4 text-slate-500" />
                    <p className="text-sm font-semibold text-slate-800">iTarang Signers</p>
                    <span className="text-xs text-slate-400">locked after initiation</span>
                  </div>
                  <div className="space-y-3">
                    {tracking!.signers!
                      .filter((s) => (s.signerRole || "").startsWith("itarang"))
                      .map((s) => (
                        <div key={s.id} className="grid grid-cols-1 gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 md:grid-cols-3">
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                              {s.signerRole?.replaceAll("_", " ")}
                            </p>
                            <p className="text-sm font-medium text-slate-900">{s.signerName || "—"}</p>
                          </div>
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Email</p>
                            <p className="text-sm text-slate-700">{s.signerEmail || "—"}</p>
                          </div>
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Phone</p>
                            <p className="text-sm text-slate-700">{s.signerMobile || "—"}</p>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              <div className="mt-5 flex flex-wrap gap-3">
                {!hasInitiatedAgreement && (
                  <button onClick={() => handleAgreementAction("initiate")}
                    disabled={agreementActionLoading !== null || isRejected}
                    className="inline-flex items-center gap-2 rounded-2xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                    <FileSignature className="h-4 w-4" />
                    {agreementActionLoading === "initiate" ? "Initiating…" : "Initiate Agreement"}
                  </button>
                )}
                {hasInitiatedAgreement && (
                  <button onClick={() => handleAgreementAction("refresh")}
                    disabled={agreementActionLoading !== null || isRejected}
                    className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                    <RefreshCw className="h-4 w-4" />
                    {agreementActionLoading === "refresh" ? "Refreshing…" : "Refresh Status"}
                  </button>
                )}
                {tracking?.canReInitiate && (
                  <button onClick={() => handleAgreementAction("reinitiate")}
                    disabled={agreementActionLoading !== null || isRejected}
                    className="inline-flex items-center gap-2 rounded-2xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
                    <RefreshCw className="h-4 w-4" />
                    {agreementActionLoading === "reinitiate" ? "Re-initiating…" : "Re-initiate Agreement"}
                  </button>
                )}
                {(agreementStatusForUi || "").toLowerCase() === "signed" && !data.agreement?.copyUrl && (
                  <button onClick={() => handleAgreementAction("retry")}
                    disabled={agreementActionLoading !== null || isRejected}
                    className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                    <Download className="h-4 w-4" />
                    {agreementActionLoading === "retry" ? "Retrying…" : "Retry Download Signed Copy"}
                  </button>
                )}

                {/* TEST-ONLY: skip agreement + signing, approve dealer directly. */}
                <button onClick={handleDevApprove}
                  disabled={submitting || isRejected}
                  className="inline-flex items-center gap-2 rounded-2xl border-2 border-dashed border-purple-400 bg-purple-50 px-4 py-2 text-sm font-semibold text-purple-700 hover:bg-purple-100 disabled:opacity-50">
                  <Zap className="h-4 w-4" />
                  {submitting ? "Approving…" : "⚡ Direct Approve (Test)"}
                </button>
              </div>
              <p className="mt-2 text-xs text-purple-600">
                Testing only — skips the agreement &amp; signing flow and approves the dealer directly, sending login credentials + welcome message.
              </p>

              {/* Tracking table */}
              <div className="mt-8 rounded-[24px] border border-slate-200 bg-white shadow-sm">
                <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900">Agreement Tracking Table</h3>
                    <p className="mt-1 text-sm text-slate-500">Signer-wise agreement progress and available actions.</p>
                  </div>
                  {tracking?.failureReason && (
                    <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">
                      {tracking.failureReason}
                    </div>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full">
                    <thead className="bg-slate-50">
                      <tr className="text-left text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                        <th className="px-6 py-4">Agreement ID</th>
                        <th className="px-6 py-4">Signer Name</th>
                        <th className="px-6 py-4">Signer Email</th>
                        <th className="px-6 py-4">Signer Status</th>
                        <th className="px-6 py-4">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trackingLoading ? (
                        <tr><td colSpan={5} className="px-6 py-8 text-sm text-slate-500">Loading agreement tracking…</td></tr>
                      ) : tracking?.signers?.length ? (
                        tracking.signers.map((signer) => (
                          <tr key={signer.id} className="border-t border-slate-200 text-sm text-slate-700">
                            <td className="px-6 py-4 font-medium text-slate-900">{tracking.agreementId || "Not available"}</td>
                            <td className="px-6 py-4">
                              <div className="font-medium text-slate-900">{signer.signerName || "Not available"}</div>
                              <div className="mt-1 text-xs uppercase tracking-[0.12em] text-slate-400">{signer.signerRole?.replaceAll("_", " ")}</div>
                            </td>
                            <td className="px-6 py-4">
                              <div>{signer.signerEmail || "Not available"}</div>
                              {signer.signerMobile && <div className="mt-1 text-xs text-slate-500">{signer.signerMobile}</div>}
                            </td>
                            <td className="px-6 py-4"><SignerStatusBadge value={signer.signerStatus} /></td>
                            <td className="px-6 py-4">
                              {(() => {
                                const hasSigned = (signer.signerStatus || "").toLowerCase() === "signed";
                                if (tracking?.canReInitiate) {
                                  return (
                                    <button onClick={() => handleAgreementAction("reinitiate")}
                                      disabled={agreementActionLoading !== null || isRejected}
                                      className="inline-flex items-center gap-2 rounded-2xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
                                      <RefreshCw className="h-4 w-4" />
                                      {agreementActionLoading === "reinitiate" ? "Re-initiating…" : "Re-initiate Agreement"}
                                    </button>
                                  );
                                }
                                if (!hasSigned && signer.providerSigningUrl) {
                                  return (
                                    <a href={signer.providerSigningUrl} target="_blank" rel="noopener noreferrer"
                                      className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600 hover:text-blue-700">
                                      <ExternalLink className="h-4 w-4" /> Open Link
                                    </a>
                                  );
                                }
                                return <span className="text-slate-400">No action</span>;
                              })()}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr><td colSpan={5} className="px-6 py-8 text-sm text-slate-500">No agreement tracking rows available yet.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Timeline */}
              <div className="mt-6 rounded-[24px] border border-slate-200 bg-slate-50 p-5">
                <div className="flex items-center gap-3">
                  <div className="rounded-2xl bg-white p-3 text-slate-700 shadow-sm"><Clock3 className="h-5 w-5" /></div>
                  <div>
                    <h3 className="text-lg font-semibold text-slate-900">Agreement Activity Timeline</h3>
                    <p className="mt-1 text-sm text-slate-500">Latest Digio agreement events and signer progress history.</p>
                  </div>
                </div>
                <div className="mt-5 space-y-3">
                  {tracking?.timeline?.length ? (
                    tracking.timeline.map((event) => (
                      <div key={event.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">{(event.eventType || "event").replaceAll("_", " ")}</p>
                            <p className="mt-1 text-xs uppercase tracking-[0.12em] text-slate-400">
                              {event.signerRole ? event.signerRole.replaceAll("_", " ") : "system"}
                            </p>
                          </div>
                          <div className="flex flex-col items-start gap-2 md:items-end">
                            <AgreementBadge value={event.eventStatus || undefined} />
                            <p className="text-xs text-slate-500">
                              {event.createdAt ? new Date(event.createdAt).toLocaleString() : "Not available"}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-4 text-sm text-slate-500">
                      No timeline events available yet.
                    </div>
                  )}
                </div>
              </div>
            </SectionCard>
          )}

          {data.correctionRound &&
          (data.correctionRound.status === "submitted" ||
            data.correctionRound.status === "pending") ? (
            <CorrectionResponsePanel
              dealerId={data.id}
              round={data.correctionRound}
              onApplied={reloadDealer}
            />
          ) : null}
        </div>

        <ActionCard
          remarks={remarks}
          setRemarks={setRemarks}
          submitting={submitting || isRejected}
          onApprove={handleApprove}
          onCorrection={handleCorrection}
          onReject={handleReject}
          onBack={() => router.push("/admin/dealer-verification")}
          financeEnabled={data.financeEnabled}
          agreementStatus={agreementStatusForUi}
          duplicate={duplicate}
          onboardingStatus={data.onboardingStatus}
          branchAck={branchAck}
          setBranchAck={setBranchAck}
        />
      </div>

      <RequestCorrectionDialog
        open={correctionDialogOpen}
        onClose={() => setCorrectionDialogOpen(false)}
        dealerId={data.id}
        companyName={data.companyName}
        onRequested={reloadDealer}
      />
    </div>
  );
}