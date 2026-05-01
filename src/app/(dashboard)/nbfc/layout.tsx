import type { ReactNode } from "react";
import { getCurrentTenant } from "@/lib/nbfc/tenant";
import SidebarNav from "@/components/nbfc-portal/SidebarNav";

export default async function NbfcLayout({ children }: { children: ReactNode }) {
  const tenant = await getCurrentTenant();
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-6">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500">NBFC Partner</div>
            <div className="text-base font-semibold">{tenant.display_name}</div>
          </div>
          <div className="ml-auto flex items-center gap-4 text-sm text-slate-500">
            {tenant.aum_inr && (
              <span className="px-2 py-1 rounded bg-slate-100 dark:bg-slate-800">
                AUM &#x20B9;{Number(tenant.aum_inr).toLocaleString("en-IN")}
              </span>
            )}
            <span className="px-2 py-1 rounded bg-slate-100 dark:bg-slate-800">
              {tenant.active_loans.toLocaleString()} active loans
            </span>
          </div>
        </div>
      </header>
      <div className="md:flex max-w-7xl mx-auto">
        <SidebarNav />
        <main className="flex-1 px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
