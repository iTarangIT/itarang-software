import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";
import { EditLeadForm } from "@/components/leads/edit-lead-form";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function EditLeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Same gate as the list and PATCH /api/dealer-leads/[id]. This was
  // requireAuth() — any signed-in user of any role, including dealers and
  // vendors, could open the edit form for any prospect.
  await requireRole([...LEADS_PAGE_ROLES]);

  const { id } = await params;

  const [lead] = await db
    .select()
    .from(dealerLeads)
    .where(eq(dealerLeads.id, id))
    .limit(1);

  if (!lead) {
    return (
      <div className="max-w-xl mx-auto mt-20 text-center text-gray-500">
        Lead not found
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">

      <Link href="/leads">
        <Button variant="ghost" className="mb-6">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Leads
        </Button>
      </Link>

      <div className="bg-white border rounded-2xl shadow-sm p-8">
        <h1 className="text-2xl font-semibold mb-6">Edit Lead</h1>
        <EditLeadForm initialData={lead} leadId={id} />
      </div>

    </div>
  );
}