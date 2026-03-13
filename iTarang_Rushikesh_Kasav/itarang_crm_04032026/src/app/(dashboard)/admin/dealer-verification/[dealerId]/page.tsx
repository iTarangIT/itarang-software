'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function DealerReviewPage() {
  const params = useParams();
  const router = useRouter();
  const dealerId = params?.dealerId as string;

  const [data, setData] = useState<any>(null);
  const [remarks, setRemarks] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const loadDealer = async () => {
      try {
        const res = await fetch(`/api/admin/dealer-verifications/${dealerId}`);
        const json = await res.json();
        if (json.success) {
          setData(json.data);
        }
      } catch (error) {
        console.error('Failed to load dealer review data', error);
      } finally {
        setLoading(false);
      }
    };

    if (dealerId) loadDealer();
  }, [dealerId]);

  const handleApprove = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/dealer-verifications/${dealerId}/approve`, {
        method: 'POST',
      });
      const json = await res.json();
      if (json.success) {
        router.push('/admin/dealer-verification');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCorrection = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/dealer-verifications/${dealerId}/request-correction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remarks }),
      });
      const json = await res.json();
      if (json.success) {
        router.push('/admin/dealer-verification');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/dealer-verifications/${dealerId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remarks }),
      });
      const json = await res.json();
      if (json.success) {
        router.push('/admin/dealer-verification');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-sm text-gray-500">Loading dealer review...</div>;
  }

  if (!data) {
    return <div className="p-6 text-sm text-red-500">Dealer review data not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Review Dealer</h1>
        <p className="mt-1 text-sm text-gray-500">
          Validate onboarding submission and decide final status.
        </p>
      </div>

      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900">Section 1 — Company Details</h2>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <Field label="Company Name" value={data.companyName} />
          <Field label="Company Address" value={data.companyAddress} />
          <Field label="GST" value={data.gstNumber} />
          <Field label="PAN" value={data.panNumber} />
          <Field label="Company Type" value={data.companyType} />
          <Field label="Bank Name" value={data.bankName} />
          <Field label="Account Number" value={data.accountNumber} />
          <Field label="Beneficiary Name" value={data.beneficiaryName} />
          <Field label="IFSC" value={data.ifscCode} />
        </div>
      </section>

      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900">Section 2 — Document Verification</h2>
        <div className="mt-4 space-y-3">
          {(data.documents || []).map((doc: any) => (
            <div key={doc.name} className="flex items-center justify-between rounded-xl border border-gray-100 px-4 py-3">
              <span className="text-sm font-medium text-gray-800">{doc.name}</span>
              <a
                href={doc.url}
                target="_blank"
                className="text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                View
              </a>
            </div>
          ))}
        </div>
      </section>

      {data.financeEnabled === true && (
        <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900">Section 3 — Agreement Verification</h2>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <Field label="Agreement ID" value={data.agreement?.agreementId} />
            <Field label="Signer Name" value={data.agreement?.signerName} />
            <Field label="Signer Email" value={data.agreement?.signerEmail} />
            <Field label="Agreement Status" value={data.agreement?.status} />
          </div>
          {data.agreement?.copyUrl && (
            <a
              href={data.agreement.copyUrl}
              target="_blank"
              className="mt-4 inline-flex rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              View / Download Agreement
            </a>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900">Section 4 — Review Action</h2>
        <textarea
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="Write correction notes or rejection reason here..."
          className="mt-4 min-h-[120px] w-full rounded-xl border border-gray-300 p-4 text-sm outline-none focus:border-blue-500"
        />

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            onClick={() => router.push('/admin/dealer-verification')}
            className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Back
          </button>

          <button
            onClick={handleApprove}
            disabled={submitting}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Approve
          </button>

          <button
            onClick={handleCorrection}
            disabled={submitting || !remarks.trim()}
            className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
          >
            Request Correction
          </button>

          <button
            onClick={handleReject}
            disabled={submitting || !remarks.trim()}
            className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  return (
    <div className="rounded-xl bg-gray-50 px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-2 font-medium text-gray-900">{value || 'Not available'}</p>
    </div>
  );
}