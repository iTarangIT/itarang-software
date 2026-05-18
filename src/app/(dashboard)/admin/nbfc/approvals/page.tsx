/**
 * /admin/nbfc/approvals — CEO-only queue of NBFCs in `pending_admin_review`.
 *
 * Server-rendered. Auth: requires the viewer to be CEO Sanchit (role='ceo'
 * or email='sanchit@itarang.com'). Other roles see a 403 banner — the
 * actual approve action is also CEO-gated server-side.
 */
import { eq, and, count, desc } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import {
  nbfc,
  nbfcComplianceDocuments,
  nbfcLspAgreements,
} from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { REQUIRED_NBFC_DOC_TYPES } from "@/lib/nbfc/admin/required-docs";
import { PageShell } from "@/components/layout/PageShell";
import NbfcApprovalsQueue, {
  type PendingNbfc,
} from "@/components/admin/nbfc/NbfcApprovalsQueue";

export const dynamic = "force-dynamic";

const CEO_EMAIL = "sanchit@itarang.com";
const REQUIRED_COUNT = REQUIRED_NBFC_DOC_TYPES.length;

export default async function NbfcApprovalsPage() {
  let user;
  try {
    user = await requireAuth();
  } catch {
    redirect("/login");
  }

  const role = (user.role ?? "").toLowerCase();
  const email = (user.email ?? "").toLowerCase();
  const isCeo = role === "ceo" || email === CEO_EMAIL;

  if (!isCeo) {
    return (
      <PageShell
        eyebrow="CEO Only"
        title="NBFC Approvals"
        subtitle="Only CEO Sanchit can review NBFC onboarding submissions."
        breadcrumb={[{ label: "Admin", href: "/admin" }, { label: "NBFC Approvals" }]}
      >
        <div
          className="card-iTarang p-8"
          style={{
            background: "var(--color-info-bg)",
            borderColor: "rgba(19, 143, 198, 0.3)",
          }}
        >
          <p className="font-semibold text-[color:var(--color-brand-navy)]">
            Restricted view
          </p>
          <p className="text-sm text-[color:var(--color-brand-navy)]/80 mt-1">
            This queue is reserved for CEO-level approvers. Your role is{" "}
            <span className="font-mono">{role || "unknown"}</span>.
          </p>
        </div>
      </PageShell>
    );
  }

  // Pending NBFCs — newest submission at the top of the CEO queue so the
  // most-recently-submitted application is the first thing Sanchit sees.
  const pending = await db
    .select({
      id: nbfc.id,
      nbfcId: nbfc.nbfc_id,
      legalName: nbfc.legal_name,
      rbiRegistrationNo: nbfc.rbi_registration_no,
      updatedAt: nbfc.updated_at,
    })
    .from(nbfc)
    .where(eq(nbfc.status, "pending_admin_review"))
    .orderBy(desc(nbfc.updated_at));

  // For each pending NBFC, fetch verified-doc count + LSP agreement status.
  // Loop one-by-one; volume is tiny (CEO never has more than a handful).
  const rows: PendingNbfc[] = await Promise.all(
    pending.map(async (p) => {
      const [docCount] = await db
        .select({ n: count() })
        .from(nbfcComplianceDocuments)
        .where(
          and(
            eq(nbfcComplianceDocuments.nbfc_id, p.id),
            eq(nbfcComplianceDocuments.status, "verified"),
          ),
        );

      const [lsp] = await db
        .select({ agreement_status: nbfcLspAgreements.agreement_status })
        .from(nbfcLspAgreements)
        .where(eq(nbfcLspAgreements.nbfc_id, p.id))
        .orderBy(nbfcLspAgreements.id)
        .limit(1);

      return {
        id: p.id,
        nbfcId: p.nbfcId,
        legalName: p.legalName,
        rbiRegistrationNo: p.rbiRegistrationNo,
        submittedAt: p.updatedAt?.toISOString?.() ?? null,
        verifiedDocsCount: Number(docCount?.n ?? 0),
        requiredDocsCount: REQUIRED_COUNT,
        lspAgreementStatus: lsp?.agreement_status ?? null,
      };
    }),
  );

  return (
    <PageShell
      eyebrow="CEO Queue"
      title="Pending NBFC approvals"
      subtitle={`${rows.length} NBFC${
        rows.length === 1 ? "" : "s"
      } awaiting your sign-off.`}
      breadcrumb={[{ label: "Admin", href: "/admin" }, { label: "NBFC Approvals" }]}
    >
      <NbfcApprovalsQueue rows={rows} />
    </PageShell>
  );
}
