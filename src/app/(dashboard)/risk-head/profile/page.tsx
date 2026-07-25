"use client";

// Risk Head's own profile, inheriting risk-head/layout.tsx → RiskHeadShell.
// Required, not merely convenient: nbfc/layout.tsx redirects nbfc_risk_head
// away from every /nbfc* path, so /nbfc/profile would bounce them to the
// risk-head dashboard and they would never reach a profile at all.
import ProfileView from "@/components/profile/ProfileView";

export default function RiskHeadProfilePage() {
  return <ProfileView />;
}
