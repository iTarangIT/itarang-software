import type { ReactNode } from "react";
import { getCurrentTenant } from "@/lib/nbfc/tenant";
import NbfcPortalSidebar from "@/components/nbfc-portal/NbfcPortalSidebar";

/**
 * NBFC Portal shell — BRD §6.1.2.
 *
 * Solid navy sidebar that mirrors the admin chrome so an iTarang user moving
 * between the admin and NBFC surfaces never feels they've switched products.
 * The seven nav items render in the BRD order; the active item is computed
 * from the current pathname (client component).
 */
export default async function NbfcLayout({ children }: { children: ReactNode }) {
  const tenant = await getCurrentTenant();
  return (
    <div className="flex bg-[color:var(--color-bg)] min-h-screen">
      <NbfcPortalSidebar
        tenantName={tenant.display_name}
        activeLoans={tenant.active_loans}
        aumInr={tenant.aum_inr ? Number(tenant.aum_inr) : null}
      />
      <div className="flex-1 md:ml-64 flex flex-col min-h-screen">
        <main className="flex-1 p-6 md:p-8 overflow-y-auto">
          <div className="max-w-7xl mx-auto">{children}</div>
        </main>
      </div>
    </div>
  );
}
