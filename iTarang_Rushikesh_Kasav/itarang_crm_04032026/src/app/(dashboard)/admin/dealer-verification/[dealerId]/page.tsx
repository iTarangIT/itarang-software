"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import Link from "next/link";
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
} from "lucide-react";

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

type AgreementData = {
  agreementId?: string | null;
  signerName?: string | null;
  signerEmail?: string | null;
  status?: string | null;
  copyUrl?: string | null;
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
  bankName?: string;
  accountNumber?: string;
  beneficiaryName?: string;
  ifscCode?: string;
  financeEnabled?: boolean;
  onboardingStatus?: string;
  reviewStatus?: string;
  submittedAt?: string | null;
  documents?: DocumentItem[];
  agreement?: AgreementData | null;
};

function SectionCard({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.26 }}
      className="rounded-[28px] border border-slate-200 bg-white shadow-sm"
    >
      <div className="flex items-start gap-4 border-b border-slate-200 px-6 py-5">
        <div className="rounded-2xl bg-slate-50 p-3 text-slate-700">{icon}</div>
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
        </div>
      </div>
      <div className="p-6">{children}</div>
    </motion.section>
  );
}

function InfoField({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div className="rounded-2xl bg-slate-50 px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        {label}
      </p>
      <p className="mt-2 break-words text-sm font-medium text-slate-900">
        {value && String(value).trim() ? value : "Not available"}
      </p>
    </div>
  );
}

function StatusBadge({ value }: { value?: string | null }) {
  const status = (value || "").toLowerCase();

  const classes =
    status === "completed" || status === "approved" || status === "succeed"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : status === "submitted" || status === "pending_admin_review"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : status === "under_review"
      ? "border-blue-200 bg-blue-50 text-blue-700"
      : status === "under_correction" || status === "correction_requested"
      ? "border-orange-200 bg-orange-50 text-orange-700"
      : status === "rejected"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : "border-slate-200 bg-slate-50 text-slate-700";

  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold capitalize ${classes}`}
    >
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
      : status === "not available" || status === ""
      ? "border-slate-200 bg-slate-50 text-slate-700"
      : "border-blue-200 bg-blue-50 text-blue-700";

  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold capitalize ${classes}`}
    >
      {value || "Not available"}
    </span>
  );
}

function ActionCard({
  remarks,
  setRemarks,
  submitting,
  onApprove,
  onCorrection,
  onReject,
  onBack,
}: {
  remarks: string;
  setRemarks: (value: string) => void;
  submitting: boolean;
  onApprove: () => void;
  onCorrection: () => void;
  onReject: () => void;
  onBack: () => void;
}) {
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

      <textarea
        value={remarks}
        onChange={(e) => setRemarks(e.target.value)}
        placeholder="Write correction notes or rejection reason..."
        className="mt-5 min-h-[160px] w-full rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-900 outline-none transition focus:border-blue-400"
      />

      <div className="mt-5 grid grid-cols-1 gap-3">
        <button
          onClick={onApprove}
          disabled={submitting}
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
        >
          <CheckCircle2 className="h-4 w-4" />
          Approve & Activate
        </button>

        <button
          onClick={onCorrection}
          disabled={submitting || !remarks.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-amber-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-amber-600 disabled:opacity-50"
        >
          <Clock3 className="h-4 w-4" />
          Request Correction
        </button>

        <button
          onClick={onReject}
          disabled={submitting || !remarks.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-rose-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-50"
        >
          <XCircle className="h-4 w-4" />
          Reject Application
        </button>

        <button
          onClick={onBack}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Queue
        </button>
      </div>
    </motion.aside>
  );
}

export default function DealerReviewPage() {
  const params = useParams();
  const router = useRouter();
  const dealerId = params?.dealerId as string;

  const [data, setData] = useState<DealerReviewData | null>(null);
  const [remarks, setRemarks] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const loadDealer = async () => {
      try {
        const res = await fetch(`/api/admin/dealer-verifications/${dealerId}`);
        const json = await res.json();

        if (json.success) {
          setData(json.data);
        } else {
          setData(null);
        }
      } catch (error) {
        console.error("Failed to load dealer review data", error);
        setData(null);
      } finally {
        setLoading(false);
      }
    };

    if (dealerId) {
      loadDealer();
    }
  }, [dealerId]);

  const documentCountLabel = useMemo(() => {
    const count = data?.documents?.length || 0;
    return count > 0 ? `${count} uploaded` : "No documents uploaded";
  }, [data?.documents]);

  const handleApprove = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/dealer-verifications/${dealerId}/approve`, {
        method: "POST",
      });
      const json = await res.json();
      if (json.success) {
        router.push("/admin/dealer-verification");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCorrection = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/dealer-verifications/${dealerId}/request-correction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remarks }),
      });
      const json = await res.json();
      if (json.success) {
        router.push("/admin/dealer-verification");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/dealer-verifications/${dealerId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remarks }),
      });
      const json = await res.json();
      if (json.success) {
        router.push("/admin/dealer-verification");
      }
    } finally {
      setSubmitting(false);
    }
  };

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

  return (
    <div className="space-y-8">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28 }}
        className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-slate-400">
              Dealer Review
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">
              {data.companyName || "Dealer Application"}
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-500">
              Validate company data, uploaded documents, and agreement workflow before final
              activation.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge value={data.onboardingStatus} />
            <StatusBadge value={data.reviewStatus} />
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Submitted At
            </p>
            <p className="mt-2 text-sm font-medium text-slate-900">
              {data.submittedAt ? new Date(data.submittedAt).toLocaleString() : "Not available"}
            </p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Company Type
            </p>
            <p className="mt-2 text-sm font-medium capitalize text-slate-900">
              {(data.companyType || "Not available").replaceAll("_", " ")}
            </p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Document Status
            </p>
            <p className="mt-2 text-sm font-medium text-slate-900">{documentCountLabel}</p>
          </div>
        </div>
      </motion.div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <SectionCard
            title="Section 1 — Company Details"
            subtitle="Review legal entity details, registered identifiers, and payout information."
            icon={<Building2 className="h-5 w-5" />}
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <InfoField label="Company Name" value={data.companyName} />
              <InfoField label="Company Address" value={data.companyAddress} />
              <InfoField label="GST Number" value={data.gstNumber} />
              <InfoField label="PAN Number" value={data.panNumber} />
              <InfoField label="CIN Number" value={data.cinNumber} />
              <InfoField label="Company Type" value={data.companyType?.replaceAll("_", " ")} />

              {data.companyType === "proprietorship" && (
                <>
                  <InfoField label="Owner Name" value={data.ownerName} />
                  <InfoField label="Owner Phone" value={data.ownerPhone} />
                  <InfoField label="Owner Email" value={data.ownerEmail} />
                </>
              )}

              <InfoField label="Bank Name" value={data.bankName} />
              <InfoField label="Account Number" value={data.accountNumber} />
              <InfoField label="Beneficiary Name" value={data.beneficiaryName} />
              <InfoField label="IFSC Code" value={data.ifscCode} />
            </div>
          </SectionCard>

          <SectionCard
            title="Section 2 — Document Verification"
            subtitle="Validate uploaded onboarding and compliance records."
            icon={<FileCheck2 className="h-5 w-5" />}
          >
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

                      <p className="mt-1 text-sm text-slate-500">
                        {(doc.verificationStatus ||
                          doc.docStatus ||
                          doc.status ||
                          "Uploaded"
                        ).replaceAll("_", " ")}
                      </p>

                      {doc.documentType ? (
                        <p className="mt-1 text-xs text-slate-400">
                          Type: {doc.documentType.replaceAll("_", " ")}
                        </p>
                      ) : null}

                      {doc.rejectionReason ? (
                        <p className="mt-1 text-xs text-rose-500">
                          Reason: {doc.rejectionReason}
                        </p>
                      ) : null}
                    </div>

                    {doc.url ? (
                      <a
                        href={doc.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                      >
                        <ExternalLink className="h-4 w-4" />
                        View Document
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
          </SectionCard>

          {data.financeEnabled === true && (
            <SectionCard
              title="Section 3 — Agreement Verification"
              subtitle="Review agreement execution state for finance-enabled dealer onboarding."
              icon={<Landmark className="h-5 w-5" />}
            >
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <InfoField label="Agreement ID" value={data.agreement?.agreementId || undefined} />
                <div className="rounded-2xl bg-slate-50 px-4 py-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Agreement Status
                  </p>
                  <div className="mt-2">
                    <AgreementBadge value={data.agreement?.status || undefined} />
                  </div>
                </div>
                <InfoField label="Signer Name" value={data.agreement?.signerName || undefined} />
                <InfoField
                  label="Signer Email"
                  value={data.agreement?.signerEmail || undefined}
                />
              </div>

              {data.agreement?.copyUrl ? (
                <Link
                  href={data.agreement.copyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-5 inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  <Download className="h-4 w-4" />
                  View / Download Agreement
                </Link>
              ) : (
                <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                  Agreement copy is not available yet.
                </div>
              )}
            </SectionCard>
          )}
        </div>

        <ActionCard
          remarks={remarks}
          setRemarks={setRemarks}
          submitting={submitting}
          onApprove={handleApprove}
          onCorrection={handleCorrection}
          onReject={handleReject}
          onBack={() => router.push("/admin/dealer-verification")}
        />
      </div>
    </div>
  );
}