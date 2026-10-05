import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { LEADS_PAGE_ROLES, canEditLead } from "@/lib/leads/access";
import { leadFieldChanges } from "@/lib/leads/leadFieldChanges";
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
  const user = await requireRole([...LEADS_PAGE_ROLES]);

  const { id } = await params;

  const [lead] = await db
    .select()
    .from(dealerLeads)
    .where(eq(dealerLeads.id, id))
    .limit(1);

  // ID 132: only the lead's owner, its assigned ASM, or a manager. Same page
  // as a missing lead, so an id cannot be probed.
  const mayEdit =
    !!lead &&
    canEditLead({
      role: user.role,
      userId: user.id,
      currentOwnerId: lead.current_owner_id,
      asmId: lead.asm_id,
    });

  if (!lead || !mayEdit) {
    return (
      <div className="max-w-xl mx-auto mt-20 text-center text-gray-500">
        Lead not found
      </div>
    );
  }

  // E-296 "Type of Business" — not on the Drizzle object (see schema.ts), so
  // read separately through to_jsonb: NULL, not an error, on a database
  // without the migration.
  let businessType: string | null = null;
  try {
    const rows = (await db.execute<{ business_type: string | null }>(sql`
      SELECT to_jsonb(dl) ->> 'business_type' AS business_type
        FROM dealer_leads dl
       WHERE dl.id = ${id}
       LIMIT 1
    `)) as unknown as { business_type: string | null }[];
    businessType = rows[0]?.business_type ?? null;
  } catch {
    // leave null → "Not set"
  }

  const changes = await leadFieldChanges(id);

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
        <EditLeadForm
          initialData={{ ...lead, business_type: businessType }}
          leadId={id}
        />
      </div>

      {/* ID 132: every change to these details is recorded — who, when, old and new. */}
      <div className="bg-white border rounded-2xl shadow-sm p-8 mt-6">
        <h2 className="text-lg font-semibold mb-4">Changes to this lead</h2>
        {changes.length === 0 ? (
          <p className="text-sm text-gray-500">No changes recorded.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-1.5 pr-3 font-medium">When</th>
                <th className="py-1.5 pr-3 font-medium">Who</th>
                <th className="py-1.5 pr-3 font-medium">Field</th>
                <th className="py-1.5 pr-3 font-medium">Old</th>
                <th className="py-1.5 font-medium">New</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.id} className="border-t align-top">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-gray-500">{c.changed_at}</td>
                  <td className="py-1.5 pr-3">{c.changed_by_name ?? "System"}</td>
                  <td className="py-1.5 pr-3">{c.field}</td>
                  <td className="py-1.5 pr-3 text-gray-500 break-all">{c.old_value ?? "—"}</td>
                  <td className="py-1.5 break-all">{c.new_value ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}