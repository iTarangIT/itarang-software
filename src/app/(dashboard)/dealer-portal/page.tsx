"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import DealerDashboard from "@/components/dealer-dashboard/DealerDashboard";
import { useAuth } from "@/components/auth/AuthProvider";

type DealerPortalStatus =
  | "draft"
  | "in_progress"
  | "submitted"
  | "pending_sales_head"
  | "under_review"
  | "agreement_in_progress"
  | "agreement_completed"
  | "action_needed"
  | "correction_requested"
  | "rejected"
  | "approved";

export default function DealerPortalPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [statusLoading, setStatusLoading] = useState(true);
  const [onboardingStatus, setOnboardingStatus] =
    useState<DealerPortalStatus>("draft");

  useEffect(() => {
    if (!user) return;

    const fetchStatus = async () => {
      try {
        const res = await fetch("/api/dealer/onboarding/status", {
          method: "GET",
          cache: "no-store",
        });

        const data = await res.json();

        setOnboardingStatus((data?.status || "draft") as DealerPortalStatus);
      } catch (err) {
        console.error("Failed to fetch onboarding status", err);
        setOnboardingStatus("draft");
      } finally {
        setStatusLoading(false);
      }
    };

    fetchStatus();
  }, [user]);

  useEffect(() => {
    if (loading || statusLoading) return;

    if (!user) {
      router.push("/login");
      return;
    }

    if (onboardingStatus === "draft" || onboardingStatus === "in_progress") {
      router.push("/dealer-onboarding");
      return;
    }

    if (
      onboardingStatus === "submitted" ||
      onboardingStatus === "pending_sales_head" ||
      onboardingStatus === "under_review" ||
      onboardingStatus === "agreement_in_progress" ||
      onboardingStatus === "agreement_completed"
    ) {
      router.push("/dealer-portal/onboarding-status");
      return;
    }

    if (
      onboardingStatus === "action_needed" ||
      onboardingStatus === "correction_requested"
    ) {
      router.push("/dealer-onboarding");
      return;
    }

    if (onboardingStatus === "rejected") {
      router.push("/dealer-portal/onboarding-status");
      return;
    }

    if (onboardingStatus === "approved") {
      return;
    }

    router.push("/dealer-onboarding");
  }, [loading, statusLoading, onboardingStatus, router, user]);

  if (loading || statusLoading) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <p className="text-slate-500">Loading dealer portal...</p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  if (onboardingStatus !== "approved") {
    return null;
  }

  return <DealerDashboard />;
}