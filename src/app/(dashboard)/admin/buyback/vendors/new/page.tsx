/**
 * /admin/buyback/vendors/new — scrap vendor onboarding (E-223).
 *
 * Where "+ Add vendor" now goes. It used to open a modal; a modal was the wrong
 * container the moment the form grew documents and an address, because a file
 * picker inside an overlay that closes on a stray click loses work that took
 * real effort to gather.
 *
 * Thin server component, like admin/nbfc/new — PageShell renders on the server
 * and only the form hydrates. No step ribbon: `steps` is optional on PageShell
 * and this is one page, not a journey.
 */

import VendorOnboardingForm from "@/components/admin/buyback/VendorOnboardingForm";
import { PageShell } from "@/components/layout/PageShell";

export const dynamic = "force-dynamic";

export default function AdminBuybackVendorNewPage() {
  return (
    <PageShell
      eyebrow="Vendor Onboarding"
      title="Onboard a scrap vendor"
      subtitle="Capture the firm, its registered address, and its GST, PAN and Udyam certificates. On submit we create their portal login and email the password — the vendor becomes routable once that email lands."
      breadcrumb={[
        { label: "Buyback", href: "/admin/buyback/dashboard" },
        { label: "Vendors", href: "/admin/buyback/vendors" },
        { label: "New" },
      ]}
    >
      <VendorOnboardingForm />
    </PageShell>
  );
}
