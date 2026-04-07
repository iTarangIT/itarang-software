"use client";

import { useEffect, useState } from "react";
import {
  User,
  Mail,
  Phone,
  Shield,
  CalendarDays,
  Building2,
  BadgeCheck,
  FileText,
} from "lucide-react";

type DealerDashboardData = {
  dealerId: string;
  dealerDisplayName: string;
  companyName: string;
  companyType: string;
  gstNumber: string;
  financeEnabled: string;
  submittedAt: string;
};

export default function ProfilePage() {
  const [dealerData, setDealerData] = useState<DealerDashboardData | null>(null);

  useEffect(() => {
    const savedData = localStorage.getItem("dealerDashboardData");

    if (savedData) {
      try {
        setDealerData(JSON.parse(savedData));
      } catch (error) {
        console.error("Failed to parse dealer dashboard data", error);
      }
    }
  }, []);

  return (
    <div className="space-y-8 pb-10">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold text-[#0F172A]">My Profile</h1>
        <p className="mt-2 text-slate-500">
          View and manage your account settings
        </p>
      </div>

      {/* Profile Hero Card */}
      <div className="overflow-hidden rounded-3xl border border-[#E3E8EF] bg-white shadow-sm">
        <div className="bg-gradient-to-r from-[#0F4FBF] to-[#2954D1] px-8 py-10 text-white">
          <div className="flex flex-col gap-5 md:flex-row md:items-center">
            <div className="flex h-24 w-24 items-center justify-center rounded-3xl border border-white/20 bg-white/15 text-4xl font-bold shadow-sm backdrop-blur">
              {dealerData?.dealerDisplayName?.[0]?.toUpperCase() || "D"}
            </div>

            <div>
              <h2 className="text-4xl font-bold">
                {dealerData?.dealerDisplayName || "Dealer Profile"}
              </h2>
              <p className="mt-2 text-lg text-blue-100">Dealer Account</p>

              <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-emerald-400/15 px-4 py-1.5 text-sm font-semibold text-emerald-100">
                <BadgeCheck className="h-4 w-4" />
                Active
              </div>
            </div>
          </div>
        </div>

        {/* Main Profile Details */}
        <div className="grid grid-cols-1 gap-6 px-8 py-8 md:grid-cols-2">
          <div className="flex items-start gap-4 rounded-2xl bg-slate-50 p-4">
            <div className="rounded-xl bg-white p-3 text-slate-500 shadow-sm">
              <User className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Full Name</p>
              <p className="text-2xl font-semibold text-[#0F172A]">
                {dealerData?.dealerDisplayName || "Not available"}
              </p>
            </div>
          </div>

          <div className="flex items-start gap-4 rounded-2xl bg-slate-50 p-4">
            <div className="rounded-xl bg-white p-3 text-slate-500 shadow-sm">
              <Mail className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Email</p>
              <p className="text-2xl font-semibold text-[#0F172A]">
                dealer@itarang.com
              </p>
            </div>
          </div>

          <div className="flex items-start gap-4 rounded-2xl bg-slate-50 p-4">
            <div className="rounded-xl bg-white p-3 text-slate-500 shadow-sm">
              <Phone className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Phone</p>
              <p className="text-2xl font-semibold text-[#0F172A]">
                Not Set
              </p>
            </div>
          </div>

          <div className="flex items-start gap-4 rounded-2xl bg-slate-50 p-4">
            <div className="rounded-xl bg-white p-3 text-slate-500 shadow-sm">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Role</p>
              <p className="text-2xl font-semibold text-[#0F172A]">Dealer</p>
            </div>
          </div>

          <div className="flex items-start gap-4 rounded-2xl bg-slate-50 p-4">
            <div className="rounded-xl bg-white p-3 text-slate-500 shadow-sm">
              <BadgeCheck className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Dealer ID</p>
              <p className="text-2xl font-semibold text-[#0F172A]">
                {dealerData?.dealerId || "Not generated"}
              </p>
            </div>
          </div>

          <div className="flex items-start gap-4 rounded-2xl bg-slate-50 p-4">
            <div className="rounded-xl bg-white p-3 text-slate-500 shadow-sm">
              <CalendarDays className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Member Since</p>
              <p className="text-2xl font-semibold text-[#0F172A]">
                {dealerData?.submittedAt
                  ? new Date(dealerData.submittedAt).toLocaleDateString()
                  : "Not available"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Business Details */}
      <div className="rounded-3xl border border-[#E3E8EF] bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-2xl bg-violet-50 p-3 text-violet-600">
            <Building2 className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-2xl font-bold text-[#0F172A]">
              Company Details
            </h3>
            <p className="text-slate-500">
              Dealer business information from onboarding
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Company Name</p>
            <p className="mt-2 text-xl font-semibold text-[#0F172A]">
              {dealerData?.companyName || "Not available"}
            </p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Company Type</p>
            <p className="mt-2 text-xl font-semibold text-[#0F172A]">
              {dealerData?.companyType || "Not available"}
            </p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-sm text-slate-500">GST Number</p>
            <p className="mt-2 text-xl font-semibold text-[#0F172A]">
              {dealerData?.gstNumber || "Not available"}
            </p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Finance Enabled</p>
            <p className="mt-2 text-xl font-semibold text-[#0F172A]">
              {dealerData?.financeEnabled === "yes" ? "Yes" : "No"}
            </p>
          </div>
        </div>
      </div>

      {/* Profile Notes */}
      <div className="rounded-3xl border border-[#E3E8EF] bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-2xl bg-blue-50 p-3 text-[#1F5C8F]">
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-2xl font-bold text-[#0F172A]">
              Account Notes
            </h3>
            <p className="text-slate-500">
              Profile data linked from onboarding completion
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-[#E3E8EF] bg-[#F8FAFC] p-5 text-sm text-slate-600">
          Your dealer profile is now linked with the onboarding-generated dealer ID.
          This helps the CRM identify the dealer uniquely across dashboard, profile,
          onboarding review, and future approval workflows.
        </div>
      </div>
    </div>
  );
}