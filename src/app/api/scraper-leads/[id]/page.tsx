// app/scraper-leads/[id]/page.tsx
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth-utils";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowLeft,
  Phone,
  MapPin,
  User,
  Globe,
  Mail,
  Building,
} from "lucide-react";
import { ScraperLeadClient } from "@/components/leads/scraper-lead-client";

export const dynamic = "force-dynamic";

export default async function ScraperLeadDetailPage({ params }: any) {
  const user = await requireAuth();
  if (!user) redirect("/login");

  const { id } = await params;

  // 1. Fetch scraper lead
  const scraperLead = await db.query.scraperLeads.findFirst({
    where: (l, { eq }) => eq(l.id, id),
  });

  if (!scraperLead) {
    return (
      <div className="p-10 text-center bg-white rounded-xl border m-8 text-gray-500">
        Lead not found
      </div>
    );
  }

  // 2. Check if it was promoted to dealer lead (by phone match)
  const dealerLead = scraperLead.phone
    ? await db.query.dealerLeads.findFirst({
        where: (l, { eq }) => eq(l.phone, scraperLead.phone!),
      })
    : null;

  const history = (dealerLead?.follow_up_history as any[]) ?? [];

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

        {/* Hero */}
        <div className="bg-gray-900 rounded-2xl p-6 text-white mb-6">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30 font-medium">
                  Scraped Lead
                </span>
                {dealerLead && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-medium">
                    Promoted
                  </span>
                )}
              </div>
              <h1 className="text-xl font-bold">
                {scraperLead.name || "Unnamed Lead"}
              </h1>
              <p className="text-xs text-gray-400 mt-0.5">{scraperLead.id}</p>
            </div>
            <StatusBadge status={scraperLead.status} />
          </div>

          <div className="flex flex-wrap gap-5 mt-4 text-sm text-gray-300">
            {scraperLead.phone && (
              <span className="flex items-center gap-1.5">
                <Phone className="w-4 h-4 text-gray-500" />
                {scraperLead.phone}
              </span>
            )}
            {scraperLead.city && (
              <span className="flex items-center gap-1.5">
                <MapPin className="w-4 h-4 text-gray-500" />
                {scraperLead.city}
              </span>
            )}
            {scraperLead.address && (
              <span className="flex items-center gap-1.5">
                <Building className="w-4 h-4 text-gray-500" />
                {scraperLead.address}
              </span>
            )}
            {scraperLead.email && (
              <span className="flex items-center gap-1.5">
                <Mail className="w-4 h-4 text-gray-500" />
                {scraperLead.email}
              </span>
            )}
            {scraperLead.website && (
              <span className="flex items-center gap-1.5">
                <Globe className="w-4 h-4 text-gray-500" />
                {scraperLead.website}
              </span>
            )}
            {scraperLead.source && (
              <span className="flex items-center gap-1.5">
                <User className="w-4 h-4 text-gray-500" />
                Source: {scraperLead.source}
              </span>
            )}
          </div>
        </div>

        {/* Client section */}
        <ScraperLeadClient
          scraperLead={scraperLead}
          dealerLead={dealerLead}
          history={history}
        />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const map: Record<string, { label: string; cls: string }> = {
    new: {
      label: "New",
      cls: "bg-gray-500/20 text-gray-300 border-gray-500/30",
    },
    promoted: {
      label: "Promoted",
      cls: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    },
    called: {
      label: "Called",
      cls: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    },
    skipped: {
      label: "Skipped",
      cls: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
    },
  };
  const s = map[status?.toLowerCase() ?? ""] ?? {
    label: status ?? "New",
    cls: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  };
  return (
    <span
      className={`text-xs px-3 py-1 rounded-full border font-medium ${s.cls}`}
    >
      {s.label}
    </span>
  );
}
