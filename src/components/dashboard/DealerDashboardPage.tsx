'use client';

import Link from 'next/link';
import {
  Building2,
  FileCheck,
  ShieldCheck,
  Clock3,
  Lock,
  Plus,
  Wallet,
  PackagePlus,
  LifeBuoy,
} from 'lucide-react';

type DealerData = {
  full_name: string;
  dealer_id?: string;
  company_type?: string;
  gst_number?: string;
  finance_enabled?: boolean;
  submitted_at?: string;
  onboarding_status?: 'draft' | 'submitted' | 'under_review' | 'rejected' | 'succeed';
};

interface DealerDashboardProps {
  dealer: DealerData;
}

export default function DealerDashboardPage({ dealer }: DealerDashboardProps) {
  const onboardingStatus = dealer?.onboarding_status || 'draft';
  const isApproved = onboardingStatus === 'succeed';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Dealer Dashboard - {dealer?.full_name || 'Dealer'}
        </h1>
        <p className="mt-1 text-base text-slate-500">
          {isApproved
            ? 'Overview of your solar & EV business'
            : 'Your onboarding is under review. Full dashboard access will unlock after approval.'}
        </p>
      </div>

      {!isApproved && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-xl bg-amber-100 p-2">
              <Clock3 className="h-5 w-5 text-amber-700" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-amber-900">
                Account under review
              </h2>
              <p className="mt-1 text-sm text-amber-800">
                Your onboarding has been submitted successfully. Once the status changes to
                <span className="font-semibold"> succeed</span>, your complete dealer dashboard
                and business modules will be unlocked.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm">
          <div className="mb-6 flex items-start justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">
                Dealer Identity
              </p>
              <h2 className="mt-3 text-4xl font-semibold tracking-tight text-slate-900">
                {dealer?.full_name || 'Not Available'}
              </h2>
              <p className="mt-2 max-w-2xl text-sm text-slate-500">
                This dealer identity is used for onboarding verification, account activation,
                and secure platform access.
              </p>
            </div>

            <div className="rounded-2xl bg-blue-50 p-3">
              <Building2 className="h-6 w-6 text-blue-700" />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <InfoBox label="Dealer Name" value={dealer?.full_name || 'Not Available'} />
            <InfoBox label="Dealer ID" value={dealer?.dealer_id || 'Pending Approval'} highlight />
            <InfoBox label="Company Type" value={formatLabel(dealer?.company_type) || 'Not Available'} />
            <InfoBox label="GST Number" value={dealer?.gst_number || 'Not Available'} />
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm">
          <div className="mb-6 flex items-start gap-3">
            <div className="rounded-2xl bg-violet-50 p-3">
              <FileCheck className="h-6 w-6 text-violet-700" />
            </div>
            <div>
              <h3 className="text-2xl font-semibold tracking-tight text-slate-900">
                Onboarding Status
              </h3>
              <p className="text-sm text-slate-500">Application snapshot</p>
            </div>
          </div>

          <StatusPill status={onboardingStatus} />

          <div className="mt-5 space-y-4">
            <MetricBox
              label="Finance Enabled"
              value={dealer?.finance_enabled ? 'Yes' : 'No'}
            />
            <MetricBox
              label="Submitted At"
              value={dealer?.submitted_at || 'Not submitted'}
            />
          </div>
        </div>
      </div>

      {!isApproved ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          <ReviewTimelineCard />

          <LockedActionCard
            icon={<Plus className="h-6 w-6" />}
            title="New Lead"
            description="Lead creation will unlock after your onboarding is approved."
          />

          <LockedActionCard
            icon={<Wallet className="h-6 w-6" />}
            title="Process Loan"
            description="Loan processing becomes available once compliance review is completed."
          />

          <LockedActionCard
            icon={<PackagePlus className="h-6 w-6" />}
            title="Add Asset"
            description="Asset registration is enabled after your dealer account is activated."
          />

          <SupportCard />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          <ActionCard
            href="/lead-management"
            icon={<Plus className="h-7 w-7" />}
            title="New Lead"
            description="Create a new customer lead"
            primary
          />

          <ActionCard
            href="/dealer-portal/loans/facilitation"
            icon={<Wallet className="h-7 w-7" />}
            title="Process Loan"
            description="Upload docs for financing"
          />

          <ActionCard
            href="/asset-management"
            icon={<PackagePlus className="h-7 w-7" />}
            title="Add Asset"
            description="Register new vehicle or battery"
          />
        </div>
      )}
    </div>
  );
}

function formatLabel(value?: string) {
  if (!value) return '';
  return value.replace(/_/g, ' ');
}

function InfoBox({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-2xl border p-5 ${highlight ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-slate-50'}`}>
      <p className="text-sm uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 break-words">
        {value}
      </p>
    </div>
  );
}

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-slate-50 px-5 py-4">
      <p className="text-sm uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-xl font-semibold tracking-tight text-slate-900 break-words">
        {value}
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const classMap: Record<string, string> = {
    draft: 'bg-slate-100 text-slate-700 border-slate-200',
    submitted: 'bg-blue-50 text-blue-700 border-blue-200',
    under_review: 'bg-amber-50 text-amber-700 border-amber-200',
    rejected: 'bg-red-50 text-red-700 border-red-200',
    succeed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  };

  const labelMap: Record<string, string> = {
    draft: 'Draft',
    submitted: 'Submitted',
    under_review: 'Under Review',
    rejected: 'Rejected',
    succeed: 'Approved',
  };

  return (
    <div className={`inline-flex rounded-2xl border px-4 py-3 text-base font-semibold ${classMap[status] || classMap.draft}`}>
      {labelMap[status] || status}
    </div>
  );
}

function ActionCard({
  href,
  icon,
  title,
  description,
  primary = false,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`group rounded-3xl border p-7 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
        primary
          ? 'border-blue-700 bg-blue-700 text-white'
          : 'border-slate-200 bg-white text-slate-900'
      }`}
    >
      <div className={`inline-flex rounded-2xl p-3 ${primary ? 'bg-white/10' : 'bg-slate-100'}`}>
        {icon}
      </div>
      <h3 className={`mt-10 text-3xl font-semibold tracking-tight ${primary ? 'text-white' : 'text-slate-900'}`}>
        {title}
      </h3>
      <p className={`mt-2 text-base ${primary ? 'text-blue-100' : 'text-slate-500'}`}>
        {description}
      </p>
    </Link>
  );
}

function LockedActionCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-slate-50 p-7 opacity-95">
      <div className="flex items-start justify-between">
        <div className="inline-flex rounded-2xl bg-slate-200 p-3 text-slate-500">
          {icon}
        </div>
        <div className="rounded-xl bg-white p-2 text-slate-400">
          <Lock className="h-5 w-5" />
        </div>
      </div>

      <h3 className="mt-10 text-3xl font-semibold tracking-tight text-slate-500">
        {title}
      </h3>
      <p className="mt-2 text-base text-slate-400">{description}</p>
      <p className="mt-5 text-sm font-medium text-slate-500">
        Available after account approval
      </p>
    </div>
  );
}

function ReviewTimelineCard() {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm">
      <div className="mb-5 flex items-start gap-3">
        <div className="rounded-2xl bg-emerald-50 p-3">
          <ShieldCheck className="h-6 w-6 text-emerald-700" />
        </div>
        <div>
          <h3 className="text-2xl font-semibold tracking-tight text-slate-900">
            Review in progress
          </h3>
          <p className="text-sm text-slate-500">What happens next</p>
        </div>
      </div>

      <div className="space-y-4">
        <StepRow done label="Application submitted" />
        <StepRow active label="Compliance & business verification" />
        <StepRow label="Final approval & account activation" />
      </div>
    </div>
  );
}

function StepRow({
  label,
  done = false,
  active = false,
}: {
  label: string;
  done?: boolean;
  active?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-slate-50 px-4 py-3">
      <div
        className={`h-3 w-3 rounded-full ${
          done ? 'bg-emerald-500' : active ? 'bg-amber-500' : 'bg-slate-300'
        }`}
      />
      <span
        className={`text-sm font-medium ${
          done || active ? 'text-slate-800' : 'text-slate-500'
        }`}
      >
        {label}
      </span>
    </div>
  );
}

function SupportCard() {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm">
      <div className="mb-5 flex items-start gap-3">
        <div className="rounded-2xl bg-cyan-50 p-3">
          <LifeBuoy className="h-6 w-6 text-cyan-700" />
        </div>
        <div>
          <h3 className="text-2xl font-semibold tracking-tight text-slate-900">
            Need help?
          </h3>
          <p className="text-sm text-slate-500">Contact onboarding support</p>
        </div>
      </div>

      <p className="text-sm leading-6 text-slate-600">
        If your onboarding is taking longer than expected or any document needs correction,
        contact the support team for assistance.
      </p>

      <button className="mt-5 rounded-2xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
        Contact Support
      </button>
    </div>
  );
}