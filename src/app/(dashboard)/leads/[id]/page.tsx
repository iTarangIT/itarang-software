import { db } from "@/lib/db";
import { aiCallLogs } from "@/lib/db/schema";
import { or, eq, sql, desc } from "drizzle-orm";
import { requireAuth } from "@/lib/auth-utils";
import Link from "next/link";
import { ArrowLeft, Phone, MapPin, User } from "lucide-react";
import { redirect } from "next/navigation";
import { LeadDetailClient } from "@/components/leads/lead-detail-client";
import { normalizeCalls } from "@/lib/leads/normalizeCalls";

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

  // Canonical call store is ai_call_logs (the campaign drawer, cost analytics and
  // backfill cron all read it). Match this lead's calls by id OR by phone
  // last-10-digits — webhook finalizers attribute by phone, not id, so a call can
  // land on a log row whose lead_id differs; dealer_leads.phone is unique so the
  // last-10 match is safe. follow_up_history is folded in for legacy coverage.
  const phoneLast10 = (lead.phone ?? "").replace(/\D/g, "").slice(-10);
  const logs = await db
    .select()
    .from(aiCallLogs)
    .where(
      or(
        eq(aiCallLogs.lead_id, id),
        phoneLast10.length === 10
          ? sql`right(regexp_replace(${aiCallLogs.phone_number}, '[^0-9]', '', 'g'), 10) = ${phoneLast10}`
          : sql`false`,
      ),
    )
    .orderBy(desc(sql`COALESCE(${aiCallLogs.started_at}, ${aiCallLogs.created_at})`));

  const history = (lead.follow_up_history as any[]) ?? [];
  const calls = normalizeCalls(logs, history);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto py-8 px-6">
        <Link
          href="/leads"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Leads
        </Link>

        {/* Header — light CRM card */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mb-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-gray-900 truncate">
                {lead.shop_name || lead.dealer_name || "Unnamed Shop"}
              </h1>
              <p className="text-xs text-gray-400 mt-0.5 font-mono">{lead.id}</p>
            </div>
            <StatusBadge status={lead.current_status} />
          </div>

          <div className="flex flex-wrap gap-x-5 gap-y-2 mt-4 text-sm text-gray-600">
            <span className="inline-flex items-center gap-1.5">
              <User className="w-4 h-4 text-gray-400" />
              {lead.dealer_name || "—"}
            </span>
            <a
              href={lead.phone ? `tel:${lead.phone}` : undefined}
              className="inline-flex items-center gap-1.5 hover:text-gray-900"
            >
              <Phone className="w-4 h-4 text-gray-400" />
              {lead.phone || "—"}
            </a>
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-gray-400" />
              {lead.location || lead.city || "—"}
            </span>
          </div>
        </div>

        <LeadDetailClient calls={calls} lead={lead} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const map: Record<string, { label: string; cls: string }> = {
    hot: { label: "Hot", cls: "bg-red-50 text-red-700 border-red-200" },
    warm: { label: "Warm", cls: "bg-amber-50 text-amber-700 border-amber-200" },
    cold: { label: "Cold", cls: "bg-blue-50 text-blue-700 border-blue-200" },
    qualified: { label: "Qualified", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    disqualified: { label: "Disqualified", cls: "bg-gray-100 text-gray-500 border-gray-200" },
    new: { label: "New", cls: "bg-gray-100 text-gray-600 border-gray-200" },
  };
  const s = map[status?.toLowerCase() ?? ""] ?? {
    label: status ?? "Unknown",
    cls: "bg-gray-100 text-gray-500 border-gray-200",
  };
  return (
    <span className={`shrink-0 text-xs px-3 py-1 rounded-full border font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}
