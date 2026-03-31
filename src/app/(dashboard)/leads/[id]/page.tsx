import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ArrowLeft, Phone, MapPin, User } from "lucide-react";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireAuth();

  if (!user) {
    redirect("/login");
  }

  const { id } = await params;

  const lead = await db.query.dealerLeads.findFirst({
    where: (l, { eq }) => eq(l.id, id),
  });

  if (!lead) {
    return (
      <div className="p-10 text-center bg-white rounded-xl border m-8">
        Lead not found
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto py-10 px-6">

      <Link href="/leads">
        <Button variant="ghost" className="mb-6">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Leads
        </Button>
      </Link>

      <div className="bg-gradient-to-r from-slate-900 to-slate-800 text-white rounded-2xl p-6 mb-8 shadow">

        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-bold">
              {lead.shop_name || "Unnamed Shop"}
            </h1>
            <p className="text-sm text-gray-300 mt-1">
              ID: {lead.id}
            </p>
          </div>

          <span className="px-4 py-1.5 rounded-full text-xs font-semibold bg-white/10">
            {lead.current_status || "new"}
          </span>
        </div>

        <div className="flex gap-6 mt-6 text-sm text-gray-300">
          <div className="flex items-center gap-2">
            <User className="w-4 h-4" />
            {lead.dealer_name || "N/A"}
          </div>
          <div className="flex items-center gap-2">
            <Phone className="w-4 h-4" />
            {lead.phone || "-"}
          </div>
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4" />
            {lead.location || "-"}
          </div>
        </div>

      </div>

      <div className="grid md:grid-cols-3 gap-6 mb-8">

        <div className="bg-white border rounded-xl p-5">
          <p className="text-xs text-gray-500 mb-1">Intent Score</p>
          <p className="text-2xl font-semibold text-gray-900">
            {lead.final_intent_score ?? "-"}
          </p>
        </div>

        <div className="bg-white border rounded-xl p-5">
          <p className="text-xs text-gray-500 mb-1">Total Attempts</p>
          <p className="text-2xl font-semibold text-gray-900">
            {lead.total_attempts ?? 0}
          </p>
        </div>

        <div className="bg-white border rounded-xl p-5">
          <p className="text-xs text-gray-500 mb-1">Next Call</p>
          <p className="text-sm font-medium text-gray-900">
            {lead.next_call_at
              ? new Date(lead.next_call_at).toLocaleString()
              : "Not Scheduled"}
          </p>
        </div>

      </div>

      <div className="grid md:grid-cols-2 gap-6 mb-8">

        <div className="bg-white border rounded-xl p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">
            Contact Info
          </h3>

          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Name</span>
              <span className="text-gray-900 font-medium">
                {lead.dealer_name || "N/A"}
              </span>
            </div>

            <div className="flex justify-between">
              <span className="text-gray-500">Phone</span>
              <span className="text-gray-900 font-medium">
                {lead.phone || "-"}
              </span>
            </div>

            <div className="flex justify-between">
              <span className="text-gray-500">Language</span>
              <span className="text-gray-900 font-medium">
                {lead.language || "N/A"}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-white border rounded-xl p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">
            Lead Details
          </h3>

          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Location</span>
              <span className="text-gray-900 font-medium">
                {lead.location || "N/A"}
              </span>
            </div>

            <div className="flex justify-between">
              <span className="text-gray-500">Status</span>
              <span className="text-gray-900 font-medium">
                {lead.current_status || "new"}
              </span>
            </div>
          </div>
        </div>

      </div>

      <div className="bg-white border rounded-xl p-6 mb-8">
        <h3 className="text-sm font-semibold text-gray-900 mb-5">
          AI Insights
        </h3>

        <div className="grid md:grid-cols-2 gap-4 text-sm">

          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-xs text-gray-500 mb-1">Intent Summary</p>
            <p className="text-gray-900 font-medium">
              {lead.memory?.intent_summary || "No data"}
            </p>
          </div>

          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-xs text-gray-500 mb-1">Follow-up Reason</p>
            <p className="text-gray-900 font-medium">
              {lead.memory?.followup_reason || "No data"}
            </p>
          </div>

          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-xs text-gray-500 mb-1">Requirement</p>
            <p className="text-gray-900 font-medium">
              {lead.memory?.requirement || "Not specified"}
            </p>
          </div>

          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-xs text-gray-500 mb-1">Product Interest</p>
            <p className="text-gray-900 font-medium">
              {lead.memory?.product_interest || "Not specified"}
            </p>
          </div>

        </div>
      </div>

      <div className="bg-white border rounded-xl p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-6">
          Follow-up History
        </h3>

        <div className="space-y-4">

          {(lead.follow_up_history || []).map((item: any, index: number) => (
            <div
              key={index}
              className="border rounded-lg p-4 bg-gray-50"
            >

              <div className="flex justify-between mb-3">
                <span className="text-xs text-gray-500">
                  Attempt #{item.attempt}
                </span>

                <span className="text-xs px-2 py-1 rounded-full bg-green-100 text-green-700">
                  {item.outcome}
                </span>
              </div>

              <div className="grid md:grid-cols-2 gap-3 text-sm">

                <div>
                  <p className="text-gray-500 text-xs">Intent Score</p>
                  <p className="font-medium text-gray-900">
                    {item.analysis?.intent_score ?? "-"}
                  </p>
                </div>

                <div>
                  <p className="text-gray-500 text-xs">Engagement</p>
                  <p className="font-medium text-gray-900">
                    {item.analysis?.engagement_depth ?? "-"}
                  </p>
                </div>

                <div>
                  <p className="text-gray-500 text-xs">Urgency</p>
                  <p className="font-medium text-gray-900">
                    {item.analysis?.urgency_signals ?? "-"}
                  </p>
                </div>

                <div>
                  <p className="text-gray-500 text-xs">Objection</p>
                  <p className="font-medium text-gray-900">
                    {item.analysis?.objection_quality ?? "-"}
                  </p>
                </div>

              </div>

              {item.next_call_at && (
                <div className="mt-3 text-xs text-blue-600 font-medium">
                  Next Call: {new Date(item.next_call_at).toLocaleString()}
                </div>
              )}

            </div>
          ))}

          {(!lead.follow_up_history || lead.follow_up_history.length === 0) && (
            <div className="text-center text-gray-500 text-sm">
              No follow-ups yet
            </div>
          )}

        </div>
      </div>

    </div>
  );
}