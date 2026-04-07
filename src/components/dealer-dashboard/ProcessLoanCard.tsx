'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  FileCheck,
  ArrowRight,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Landmark,
  BarChart3,
  Smartphone,
  BellRing,
} from 'lucide-react';

type Stats = {
  total: number;
  fee_pending: number;
  under_validation: number;
  validation_passed: number;
  fee_paid: number;
};

export default function ProcessLoanCard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/dealer/loan-facilitation/stats', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data.success) setStats(data.data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="group relative flex flex-col rounded-2xl border border-gray-100 bg-white shadow-card transition-shadow hover:shadow-lg overflow-hidden">
      {/* Header */}
      <Link
        href="/dealer-portal/loans/facilitation"
        className="p-6 pb-4 flex items-start justify-between"
      >
        <div className="flex items-start gap-4">
          <div className="w-fit rounded-xl bg-indigo-50 p-3 text-indigo-600">
            <FileCheck className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-xl font-bold text-gray-900">Process Loan</h3>
            <p className="text-sm text-gray-500 mt-0.5">
              Loan facilitation queue &amp; fee tracking
            </p>
          </div>
        </div>
        <ArrowRight className="h-5 w-5 text-gray-300 mt-1 transition-transform group-hover:translate-x-1 group-hover:text-indigo-500" />
      </Link>

      {/* Live Stats */}
      <div className="px-6 pb-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading stats…
          </div>
        ) : stats && stats.total > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            <StatBadge
              icon={<Clock className="h-3.5 w-3.5" />}
              label="In Queue"
              value={stats.total}
              tone="blue"
            />
            <StatBadge
              icon={<AlertTriangle className="h-3.5 w-3.5" />}
              label="Fee Pending"
              value={stats.fee_pending}
              tone="red"
            />
            <StatBadge
              icon={<CheckCircle2 className="h-3.5 w-3.5" />}
              label="Validated"
              value={stats.validation_passed}
              tone="green"
            />
            <StatBadge
              icon={<CheckCircle2 className="h-3.5 w-3.5" />}
              label="Fee Paid"
              value={stats.fee_paid}
              tone="emerald"
            />
          </div>
        ) : (
          <div className="rounded-xl bg-gray-50 border border-gray-100 px-4 py-3 text-sm text-gray-500">
            No loan applications in queue yet. Create a lead with <span className="font-semibold">Finance/Loan</span> payment method to get started.
          </div>
        )}

        {/* Action button when items need attention */}
        {stats && stats.fee_pending > 0 && (
          <Link
            href="/dealer-portal/loans/facilitation"
            className="mt-3 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-4 py-2.5 transition-colors"
          >
            <AlertTriangle className="h-4 w-4" />
            {stats.fee_pending} file{stats.fee_pending !== 1 ? 's' : ''} need attention
          </Link>
        )}
      </div>

      {/* Divider */}
      <div className="border-t border-dashed border-gray-100 mx-6" />

      {/* Future Plan */}
      <div className="px-6 py-4">
        <div className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-2">
          Coming Soon
        </div>
        <div className="space-y-2">
          <FuturePlanItem
            icon={<Landmark className="h-3.5 w-3.5" />}
            text="NBFC/Bank integration for auto-disbursal"
          />
          <FuturePlanItem
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            text="Real-time EMI tracking & repayment dashboard"
          />
          <FuturePlanItem
            icon={<Smartphone className="h-3.5 w-3.5" />}
            text="Customer self-serve loan status portal"
          />
          <FuturePlanItem
            icon={<BellRing className="h-3.5 w-3.5" />}
            text="Automated overdue alerts & collection workflow"
          />
        </div>
      </div>
    </div>
  );
}

function StatBadge({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: 'blue' | 'red' | 'green' | 'emerald';
}) {
  const colors = {
    blue: 'bg-blue-50 text-blue-700',
    red: 'bg-red-50 text-red-700',
    green: 'bg-green-50 text-green-700',
    emerald: 'bg-emerald-50 text-emerald-700',
  };
  return (
    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 ${colors[tone]}`}>
      {icon}
      <div className="min-w-0">
        <div className="text-lg font-extrabold leading-tight">{value}</div>
        <div className="text-[10px] font-semibold uppercase tracking-wider opacity-70">{label}</div>
      </div>
    </div>
  );
}

function FuturePlanItem({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-start gap-2 text-xs text-gray-500">
      <div className="mt-0.5 text-gray-400">{icon}</div>
      <span>{text}</span>
    </div>
  );
}
