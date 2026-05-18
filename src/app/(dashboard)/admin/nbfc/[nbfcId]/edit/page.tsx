import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfc } from "@/lib/db/schema";
import NbfcMasterDetailsForm from "@/components/admin/nbfc/NbfcMasterDetailsForm";
import NbfcReadOnlyBanner from "@/components/admin/nbfc/NbfcReadOnlyBanner";
import NbfcFlaggedItemsAlert from "@/components/admin/nbfc/NbfcFlaggedItemsAlert";
import { isNbfcLocked } from "@/lib/nbfc/admin/editability";
import { loadOpenRoundSummary } from "@/lib/nbfc/admin/correction-loader";
import { PageShell, buildNbfcSteps } from "@/components/layout/PageShell";
import { getStepNavHref } from "@/lib/nbfc/admin/progress";

export const dynamic = "force-dynamic";

function toDateString(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return "";
}

function flattenAddress(addr: unknown): Record<string, string> {
  if (!addr || typeof addr !== "object") return {};
  const a = addr as Record<string, unknown>;
  const pick = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  return {
    addr_line1: pick("line1"),
    addr_line2: pick("line2"),
    addr_city: pick("city"),
    addr_district: pick("district"),
    addr_state: pick("state"),
    addr_pin: pick("pin"),
  };
}

export default async function AdminNbfcEditPage({
  params,
}: {
  params: Promise<{ nbfcId: string }>;
}) {
  const { nbfcId } = await params;
  const id = Number.parseInt(nbfcId, 10);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const [row] = await db.select().from(nbfc).where(eq(nbfc.id, id)).limit(1);
  if (!row) notFound();

  const roundSummary = await loadOpenRoundSummary(id);
  const masterFlagged =
    roundSummary?.items.filter((i) => i.section === "master_details") ?? [];
  const hasOpenCorrectionRound = roundSummary !== null;

  const initial: Record<string, string> = {
    legalName: row.legal_name ?? "",
    shortName: row.short_name ?? "",
    nbfcType: row.nbfc_type ?? "",
    rbiRegistrationNo: row.rbi_registration_no ?? "",
    cin: row.cin ?? "",
    gstNumber: row.gst_number ?? "",
    panNumber: row.pan_number ?? "",
    ...flattenAddress(row.registered_address),
    primaryContactName: row.primary_contact_name ?? "",
    primaryContactEmail: row.primary_contact_email ?? "",
    primaryContactPhone: row.primary_contact_phone ?? "",
    grievanceOfficerName: row.grievance_officer_name ?? "",
    grievanceHelpline: row.grievance_helpline ?? "",
    grievanceUrl: row.grievance_url ?? "",
    nodalOfficer: row.nodal_officer ?? "",
    partnershipDate: toDateString(row.partnership_date),
    activeGeographies: Array.isArray(row.active_geographies)
      ? (row.active_geographies as string[]).join(", ")
      : "",
    fldgTerms: row.fldg_terms ?? "",
  };

  return (
    <PageShell
      eyebrow="Edit NBFC"
      title="Master details"
      subtitle="Edits to a draft are saved in place. Once an NBFC is approved or active, only contact and grievance fields are mutable."
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "NBFC", href: "/admin/nbfc" },
        { label: nbfcId },
        { label: "Edit" },
      ]}
      steps={buildNbfcSteps({ active: "master" })}
      hrefForStep={(step) => getStepNavHref(step, id, row.status)}
    >
      <div className="space-y-6">
        {isNbfcLocked(row.status) && <NbfcReadOnlyBanner />}
        {roundSummary && masterFlagged.length > 0 && (
          <NbfcFlaggedItemsAlert
            section="master_details"
            items={masterFlagged}
            roundNumber={roundSummary.roundNumber}
          />
        )}
        <NbfcMasterDetailsForm
          mode="edit"
          nbfcId={nbfcId}
          initial={initial}
          hasOpenCorrectionRound={hasOpenCorrectionRound}
          locked={isNbfcLocked(row.status)}
        />
      </div>
    </PageShell>
  );
}
