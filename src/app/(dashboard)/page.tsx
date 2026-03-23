'use client';

import DealerDashboardPage from '@/components/dashboard/DealerDashboardPage';
import { useAuth } from '@/components/auth/AuthProvider';

export default function DashboardPage() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="p-8 text-sm text-slate-500">Loading dashboard...</div>;
  }

  return <DealerDashboardPage dealer={user} />;
}