"use client";

import type { ReactNode } from "react";
import AutosaveStatus from "./AutosaveStatus";
import ProgressStepper from "./ProgressStepper";
import SummaryPanel from "./SummaryPanel";

type OnboardingLayoutProps = {
  children: ReactNode;
};

export default function OnboardingLayout({
  children,
}: OnboardingLayoutProps) {
  return (
    <div className="min-h-screen bg-[#F5F7FA]">
      {/* Top Header */}
      <div className="border-b border-[#E3E8EF] bg-white px-5 md:px-10 py-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-[#173F63]">
              Dealer Onboarding
            </h1>
            <p className="text-slate-500 mt-1">
              Complete your business verification and optional finance enablement setup
            </p>
          </div>

          <AutosaveStatus />
        </div>
      </div>

      {/* Progress */}
      <div className="px-5 md:px-10 py-6">
        <ProgressStepper />
      </div>

      {/* Main Content */}
      <div className="px-5 md:px-10 pb-10 grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2">{children}</div>
        <div className="xl:col-span-1">
          <SummaryPanel />
        </div>
      </div>
    </div>
  );
}