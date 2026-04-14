'use client';

import DealerDashboardPage from '@/components/dashboard/DealerDashboardPage';
import { useAuth } from '@/components/auth/AuthProvider';

export default function DashboardPage() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="p-8 text-sm text-slate-500">Loading dashboard...</div>;
  }

  if (!user) {
    return <div className="p-8 text-sm text-slate-500">No user found.</div>;
  }

  return <DealerDashboardPage dealer={user as unknown as { full_name: string; dealer_id?: string; company_type?: string; gst_number?: string; finance_enabled?: boolean; submitted_at?: string; onboarding_status?: 'draft' | 'submitted' | 'under_review' | 'rejected' | 'succeed' }} />;
}