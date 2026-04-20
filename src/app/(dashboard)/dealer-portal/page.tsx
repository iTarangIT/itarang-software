"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import DealerDashboard from "@/components/dealer-dashboard/DealerDashboard";
import { useAuth } from "@/components/auth/AuthProvider";

export default function DealerPortalPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) router.push("/login");
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <p className="text-slate-500">Loading dealer portal...</p>
      </div>
    );
  }

  if (!user) return null;

  return <DealerDashboard />;
}
