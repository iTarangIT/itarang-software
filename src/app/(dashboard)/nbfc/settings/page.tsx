import { getCurrentTenant } from "@/lib/nbfc/tenant";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const tenant = await getCurrentTenant();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="text-sm text-slate-500">
        Tenant configuration and threshold tuning. Phase D will let you edit
        risk-thresholds (CDS bands, EMI DPD trigger, usage-drop %, geo-shift
        radius) directly from this page.
      </p>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-3 text-sm">
        <Row k="Slug" v={tenant.slug} />
        <Row k="Display name" v={tenant.display_name} />
        <Row k="Contact email" v={tenant.contact_email ?? "—"} />
        <Row k="AUM" v={tenant.aum_inr ? `₹${Number(tenant.aum_inr).toLocaleString("en-IN")}` : "—"} />
        <Row k="Active loans" v={tenant.active_loans.toLocaleString("en-IN")} />
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-2 last:border-0 last:pb-0">
      <span className="text-slate-500">{k}</span>
      <span className="font-medium">{v}</span>
    </div>
  );
}
