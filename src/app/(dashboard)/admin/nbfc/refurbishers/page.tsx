/**
 * E-292 — /admin/nbfc/refurbishers
 *
 * The refurbisher partner directory: who does the physical work in the v3
 * refurbish flow, and their portal logins. Route protection comes from
 * `sharedRouteAccess` in src/middleware.ts (covers /admin/nbfc); the
 * endpoints re-check the role.
 */
import "@/app/auction-theme.css";
import RefurbisherDirectory from "@/components/admin/nbfc/RefurbisherDirectory";

export const dynamic = "force-dynamic";
export const metadata = { title: "Refurbishers · iTarang" };

export default function AdminRefurbishersPage() {
  return (
    <main className="mx-auto max-w-[100rem] p-6">
      <RefurbisherDirectory />
    </main>
  );
}
