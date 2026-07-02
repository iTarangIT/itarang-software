import Link from "next/link";
import { redirect } from "next/navigation";
import { SlidersHorizontal, Tag, MapPin, History, AlertTriangle } from "lucide-react";
import { PageShell } from "@/components/layout/PageShell";
import { requireAuth } from "@/lib/auth-utils";
import { getOverview } from "@/lib/calculator/admin-service";
import { NbfcListClient } from "@/components/admin/calculator/NbfcListClient";

export const dynamic = "force-dynamic";

const LINKS = [
  { href: "/admin/calculator/prices", label: "Asset & Component Prices", desc: "Battery, charger, SoC, IoT prices per model", icon: Tag },
  { href: "/admin/calculator/eligibility", label: "City → NBFC Eligibility", desc: "Which cities each NBFC serves", icon: MapPin },
  { href: "/admin/calculator/settings", label: "Calculator Settings", desc: "Margin, stretch window, disclaimer, footer", icon: SlidersHorizontal },
  { href: "/admin/calculator/audit", label: "Version History & Audit", desc: "Every config change, before → after", icon: History },
];

export default async function CalculatorAdminPage() {
  let user;
  try {
    user = await requireAuth();
  } catch {
    redirect("/login");
  }
  if (!["admin", "sales_head"].includes(user.role)) redirect("/login");

  const overview = await getOverview();

  return (
    <PageShell
      eyebrow="LOAN CALCULATOR"
      title="Calculator Console"
      subtitle="Manage NBFCs, schemes, prices and city eligibility. Every save is versioned and audited — past quotes stay reproducible."
      breadcrumb={[{ label: "Admin", href: "/admin" }, { label: "Loan Calculator" }]}
    >
      {!overview.hasSettings && (
        <div className="mb-6 flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4" />
          No calculator config found. Apply <code className="mx-1">drizzle/E-177_loan_calculator.sql</code> then run{" "}
          <code className="mx-1">npm run seed:calculator</code>.
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="group rounded-2xl border border-gray-200 bg-white p-4 shadow-sm transition hover:border-gray-300 hover:shadow"
          >
            <l.icon className="mb-2 h-5 w-5 text-gray-700" />
            <p className="text-sm font-bold text-gray-900">{l.label}</p>
            <p className="mt-0.5 text-xs text-gray-500">{l.desc}</p>
          </Link>
        ))}
      </div>

      <NbfcListClient nbfcs={overview.nbfcs} />
    </PageShell>
  );
}
