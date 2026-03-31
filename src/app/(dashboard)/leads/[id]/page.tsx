import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import Link from "next/link";
import { ArrowLeft, Phone, MapPin, User } from "lucide-react";
import { redirect } from "next/navigation";
import { FollowUpUI } from "@/components/leads/follow-up-ui";

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
        {/* BACK */}
        <Link
          href="/leads"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Leads
        </Link>

        {/* HERO */}
        <div className="bg-gray-900 rounded-2xl p-6 text-white mb-6">
          <h1 className="text-xl font-bold">
            {lead.shop_name || "Unnamed Shop"}
          </h1>
          <p className="text-xs text-gray-400">{lead.id}</p>

          <div className="flex gap-5 mt-4 text-sm text-gray-300">
            <span className="flex items-center gap-1">
              <User className="w-4 h-4" /> {lead.dealer_name}
            </span>
            <span className="flex items-center gap-1">
              <Phone className="w-4 h-4" /> {lead.phone}
            </span>
            <span className="flex items-center gap-1">
              <MapPin className="w-4 h-4" /> {lead.location}
            </span>
          </div>
        </div>

        {/* FOLLOW-UP HISTORY */}
        <FollowUpUI history={history} />
      </div>
    </div>
  );
}
