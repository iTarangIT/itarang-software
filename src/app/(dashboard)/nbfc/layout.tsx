import Link from "next/link";
import type { ReactNode } from "react";
import { getCurrentTenant } from "@/lib/nbfc/tenant";

const NAV = [
  { href: "/nbfc/overview", label: "Overview" },
  { href: "/nbfc/risk", label: "Risk" },
  { href: "/nbfc/batteries", label: "Batteries" },
  { href: "/nbfc/recovery", label: "Recovery" },
  { href: "/nbfc/audit", label: "Audit" },
  { href: "/nbfc/settings", label: "Settings" },
];

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
        <nav className="max-w-7xl mx-auto px-6 flex gap-2 -mb-px">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border-b-2 border-transparent hover:border-slate-300"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}
