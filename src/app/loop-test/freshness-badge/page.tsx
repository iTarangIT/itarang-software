/**
 * /loop-test/freshness-badge  — worktree-local test fixture for E-027.
 *
 * Mounts <DataFreshnessBadge/> on a public, middleware-unprotected path so
 * the loop's Playwright UI test can render the component without a real
 * Supabase session. The path is intentionally OUTSIDE /nbfc/ because that
 * prefix is in `isProtectedRoute` (via roleDashboards.nbfc_partner) and
 * would force an unauthenticated request through a /login redirect.
 * This route is gated behind NODE_ENV !== 'production' and returns 404 in
 * production builds — it must never be reachable in prod.
 */
import { notFound } from "next/navigation";
import DataFreshnessBadge from "@/components/nbfc-portal/DataFreshnessBadge";

export const dynamic = "force-dynamic";

export default function FreshnessBadgeTestFixture() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-semibold">E-027 freshness badge fixture</h1>
      <DataFreshnessBadge />
    </div>
  );
}
