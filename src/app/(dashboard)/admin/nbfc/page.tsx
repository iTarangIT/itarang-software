/**
 * /admin/nbfc — NBFC directory.
 *
 * Server-rendered page: queries the `nbfc` table directly via Drizzle and
 * passes rows to the presentational `NbfcDirectory` component. Honors
 * `?owner=me` to scope to the current viewer's submissions.
 */
import { desc } from "drizzle-orm";
import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { nbfc } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { PageShell, buildNbfcSteps } from "@/components/layout/PageShell";
import NbfcDirectory, {
  type NbfcRow,
} from "@/components/admin/nbfc/NbfcDirectory";

export const dynamic = "force-dynamic";

interface SearchParams {
  owner?: string;
}

export default async function AdminNbfcDirectoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  let user;
  try {
    user = await requireAuth();
  } catch {
    redirect("/login");
  }

  const params = await searchParams;
  const ownedFilter = params.owner === "me";

  // Read every NBFC row; client filters by ownership, status text, and search
  // term. Volume is small (typically < 50 NBFCs); no need for server-side
  // pagination yet.
  const rows = await db
    .select({
      id: nbfc.id,
      nbfcId: nbfc.nbfc_id,
      legalName: nbfc.legal_name,
      shortName: nbfc.short_name,
      status: nbfc.status,
      rbiRegistrationNo: nbfc.rbi_registration_no,
      partnershipDate: nbfc.partnership_date,
      corExpiryDate: nbfc.cor_expiry_date,
      createdBy: nbfc.created_by,
      createdAt: nbfc.created_at,
    })
    .from(nbfc)
    .orderBy(desc(nbfc.created_at));

  // `nbfc.created_by` is a numeric integer (legacy schema), but `users.id`
  // is a UUID. We can't map cleanly here; flag isMine=false unless the
  // numeric_id helper logic below matches. The directory still works as a
  // global view; "My Submitted Drafts" stays best-effort until E-003's
  // created_by column is widened to uuid.
  const directoryRows: NbfcRow[] = rows.map((r) => ({
    id: r.id,
    nbfcId: r.nbfcId,
    legalName: r.legalName,
    shortName: r.shortName,
    status: r.status,
    rbiRegistrationNo: r.rbiRegistrationNo,
    partnershipDate: r.partnershipDate ?? null,
    corExpiryDate: r.corExpiryDate ?? null,
    createdAt: r.createdAt?.toISOString?.() ?? null,
    isMine: false,
  }));

  const viewerRole = (user.role ?? "user").toLowerCase();
  const eyebrow = ownedFilter ? "My Submitted Drafts" : "NBFC Directory";
  const subtitle = ownedFilter
    ? "NBFCs you have created or submitted for CEO approval."
    : "Every NBFC partner in the iTarang ecosystem.";

  const steps = buildNbfcSteps({ active: "master" });

  return (
    <PageShell
      eyebrow={eyebrow}
      title="NBFC partners"
      subtitle={subtitle}
      breadcrumb={[{ label: "Admin", href: "/admin" }, { label: "NBFC" }]}
      steps={ownedFilter ? steps : undefined}
      actions={
        ownedFilter ? (
          <Link href="/admin/nbfc" className="btn-ghost">
            Show all NBFCs
          </Link>
        ) : null
      }
    >
      <NbfcDirectory
        rows={directoryRows}
        ownedFilter={ownedFilter}
        viewerRole={viewerRole}
      />
    </PageShell>
  );
}
