import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentTenant, getCurrentNbfcRole, getSessionUser } from "@/lib/nbfc/tenant";
import { getPortalAccess } from "@/lib/nbfc/approval-hierarchy";
import NbfcPortalShell from "@/components/nbfc-portal/NbfcPortalShell";

/**
 * NBFC Portal shell — BRD §6.1.2.
 *
 * Server component: resolves the current NBFC tenant, then hands the
 * interactive chrome (responsive sidebar + header + mobile drawer) to the
 * client `NbfcPortalShell`. The seven nav items render in BRD order; the
 * active item is computed from the pathname inside the sidebar.
 */
export default async function NbfcLayout({ children }: { children: ReactNode }) {
  const tenant = await getCurrentTenant();

  // The Risk Head is the second approver in the immobilisation gate; their
  // surface is the dedicated /risk-head dashboard. Send them there instead of
  // the partner (Risk Manager) portal. Other roles stay on /nbfc.
  const role = await getCurrentNbfcRole(tenant.id);
  if (role === "nbfc_risk_head") {
    redirect("/risk-head");
  }

  // E-388 — menus this login may open + the designation in the header.
  const session = await getSessionUser();
  const access = session
    ? await getPortalAccess(tenant.id, session.id)
    : { allowedNav: null, title: "NBFC Partner" };

  return (
    <NbfcPortalShell
      allowedNav={access.allowedNav}
      userTitle={access.title}
      tenantName={tenant.display_name}
      activeLoans={tenant.active_loans}
      aumInr={tenant.aum_inr ? Number(tenant.aum_inr) : null}
    >
      {children}
    </NbfcPortalShell>
  );
}
