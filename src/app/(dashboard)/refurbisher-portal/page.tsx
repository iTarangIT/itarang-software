/**
 * E-292 — /refurbisher-portal — the refurbishment partner's home (v3).
 *
 * Route protection comes from `roleDashboards.refurbisher` in src/middleware.ts;
 * the API re-checks the role and scopes every lot to users.refurbisher_id.
 */
import "@/app/auction-theme.css";
import RefurbisherConsole from "./_components/RefurbisherConsole";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "My lots · iTarang Refurbisher",
};

export default function RefurbisherPortalPage() {
  return (
    <main className="mx-auto max-w-[100rem] p-6">
      <RefurbisherConsole />
    </main>
  );
}
