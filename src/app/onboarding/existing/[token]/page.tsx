import type { Metadata } from "next";
import { cookies } from "next/headers";

import ExistingApplicationView from "@/components/onboarding/existing/ExistingApplicationView";
import ExistingLinkGate from "@/components/onboarding/existing/ExistingLinkGate";
import { loadExistingApplication, viewAccessFor } from "@/lib/onboarding/existingViewData";

// 27 Nov — "An application already exists for these details": after the
// mobile code, the dealer may review the application on file here. View only
// (no download), this browser only, 15 minutes per link; a new link replaces
// the old one (lib/onboarding/existingView.ts).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Your application · iTarang",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ExistingApplicationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const token = decodeURIComponent(raw);
  const access = viewAccessFor(token, await cookies());

  if (!access.ok) {
    return (
      <ExistingLinkGate
        token={token}
        reason={access.reason}
        applicationId={access.view?.applicationId ?? null}
      />
    );
  }

  const data = await loadExistingApplication(access.view.applicationId);
  if (!data) return <ExistingLinkGate token={token} reason="invalid" applicationId={null} />;

  return <ExistingApplicationView token={token} expiresAt={access.view.exp} data={data} />;
}
