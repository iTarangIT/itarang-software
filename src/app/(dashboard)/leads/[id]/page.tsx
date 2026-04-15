import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth-utils";
import Link from "next/link";
import { ArrowLeft, Phone, MapPin, User } from "lucide-react";
import { redirect } from "next/navigation";
import { LeadDetailClient } from "@/components/leads/lead-detail-client";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: any) {
  const user = await requireAuth();
  if (!user) redirect("/login");

  const { id } = await params;

  const lead = await db.query.dealerLeads.findFirst({
    where: (l, { eq }) => eq(l.id, id),
  });

  if (!lead) {
    return (
      <div className="p-10 text-center bg-white rounded-xl border m-8 text-gray-500">
        Lead not found
      </div>
    );
  }

  const history = (lead.follow_up_history as any[]) ?? [];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto py-8 px-6">
        <Link
          href="/leads"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Leads
        </Link>

        <div className="bg-gray-900 rounded-2xl p-6 text-white mb-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-xl font-bold">
                {lead.shop_name || "Unnamed Shop"}
              </h1>
              <p className="text-xs text-gray-400 mt-0.5">{lead.id}</p>
            </div>
            <StatusBadge status={lead.current_status} />
          </div>

          <div className="flex flex-wrap gap-5 mt-4 text-sm text-gray-300">
            <span className="flex items-center gap-1.5">
              <User className="w-4 h-4 text-gray-500" />
              {lead.dealer_name || "—"}
            </span>
            <span className="flex items-center gap-1.5">
              <Phone className="w-4 h-4 text-gray-500" />
              {lead.phone || "—"}
            </span>
            <span className="flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-gray-500" />
              {lead.location || "—"}
            </span>
          </div>
        </div>

        <LeadDetailClient history={history} lead={lead} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const map: Record<string, { label: string; cls: string }> = {
    hot:          { label: "Hot",          cls: "bg-red-500/20 text-red-300 border-red-500/30" },
    warm:         { label: "Warm",         cls: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
    cold:         { label: "Cold",         cls: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
    qualified:    { label: "Qualified",    cls: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
    disqualified: { label: "Disqualified", cls: "bg-gray-500/20 text-gray-400 border-gray-500/30" },
    new:          { label: "New",          cls: "bg-gray-500/20 text-gray-300 border-gray-500/30" },
  };
  const s = map[status?.toLowerCase() ?? ""] ?? {
    label: status ?? "Unknown",
    cls: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  };
  return (
    <span className={`text-xs px-3 py-1 rounded-full border font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}