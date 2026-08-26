/**
 * E-270 — /admin/nbfc/refurbishment
 *
 * iTarang's side of the refurbishment loop: batches NBFCs have sent, the
 * timeline/estimate proposal, both trucks, and the per-battery work panel.
 *
 * Route protection comes from `sharedRouteAccess` in src/middleware.ts, which
 * already covers `/admin/nbfc`. The endpoints re-check the role themselves.
 */
import "@/app/auction-theme.css";
import RefurbishmentDesk from "@/components/admin/nbfc/RefurbishmentDesk";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Refurbishment Desk · iTarang",
};

export default function AdminRefurbishmentPage() {
  return (
    <main className="mx-auto max-w-[100rem] p-6">
      <RefurbishmentDesk />
    </main>
  );
}
