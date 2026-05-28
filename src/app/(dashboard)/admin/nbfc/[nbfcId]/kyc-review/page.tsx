import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfc } from "@/lib/db/schema";
import NbfcKycReviewPanel from "@/components/admin/nbfc/NbfcKycReviewPanel";
import NbfcReadOnlyBanner from "@/components/admin/nbfc/NbfcReadOnlyBanner";
import { PageShell, buildNbfcSteps } from "@/components/layout/PageShell";
import { getStepNavHref } from "@/lib/nbfc/admin/progress";
import { isNbfcLocked } from "@/lib/nbfc/admin/editability";
import { requireAuth } from "@/lib/auth-utils";

export const dynamic = "force-dynamic";

const CEO_EMAIL = "sanchit@itarang.com";

export default async function NbfcKycReviewPage({
  params,
}: {
  params: Promise<{ nbfcId: string }>;
}) {
  const { nbfcId } = await params;
  const id = Number.parseInt(nbfcId, 10);

  if (!Number.isInteger(id) || id <= 0) {
    return (
      <PageShell title="NBFC KYC Review" subtitle={`Invalid NBFC id: ${nbfcId}`}>
        <div
          className="card-iTarang p-6 text-sm"
          style={{ color: "var(--color-danger)" }}
        >
          The NBFC id in the URL is not a valid integer.
        </div>
      </PageShell>
    );
  }

  // CEO does not run KYC dial-outs — they review and approve. Route them to
  // the review page where the final-approval panel lives.
  const user = await requireAuth();
  const role = (user.role ?? "").toLowerCase();
  const email = (user.email ?? "").toLowerCase();
  if (role === "ceo" || email === CEO_EMAIL) {
    redirect(`/admin/nbfc/${id}/review`);
  }

  // Resolve current NBFC status so we can lock the panel for approved/active
  // NBFCs (no further KYC dial-outs are meaningful once the deal is final).
  const [statusRow] = await db
    .select({ status: nbfc.status })
    .from(nbfc)
    .where(eq(nbfc.id, id))
    .limit(1);
  const locked = isNbfcLocked(statusRow?.status);

  return (
    <PageShell
      eyebrow="KYC Review"
      title={`NBFC KYC #${nbfcId}`}
      subtitle="Run CIN, PAN, GSTIN against the entity and PAN, Aadhaar, RC against the director before opening the final approval gate."
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "NBFC", href: "/admin/nbfc" },
        { label: nbfcId },
        { label: "KYC Review" },
      ]}
      steps={buildNbfcSteps({
        active: "approval",
        done: ["master", "documents", "lsp"],
      })}
      hrefForStep={(step) => getStepNavHref(step, id, statusRow?.status)}
    >
      <div className="space-y-6">
        {locked && <NbfcReadOnlyBanner />}
        <NbfcKycReviewPanel nbfcId={id} locked={locked} />
      </div>
    </PageShell>
  );
}
