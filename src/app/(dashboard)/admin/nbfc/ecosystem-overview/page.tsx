/**
 * E-065 — /admin/nbfc/ecosystem-overview page (BRD §6.3.2).
 *
 * Admin-only iTarang Ops view that mounts the EcosystemOverview client
 * component. Route protection is provided by `src/middleware.ts` which
 * gates `/admin/*` to admin-grade roles.
 */
import EcosystemOverview from "@/components/admin/nbfc/EcosystemOverview";

export const dynamic = "force-dynamic";

export default function EcosystemOverviewPage() {
  return (
    <main className="mx-auto max-w-7xl p-6">
      <h1 className="mb-6 text-2xl font-semibold text-gray-900">
        NBFC Ecosystem Overview
      </h1>
      <EcosystemOverview />
    </main>
  );
}
