"use client";

// NBFC partner's own profile. Exists as a separate route from /profile so the
// page inherits nbfc/layout.tsx → NbfcPortalShell; the shared /profile falls
// under LayoutWrapper's admin Sidebar+Header, which dropped NBFC users out of
// their portal with no way back to the NBFC nav.
import ProfileView from "@/components/profile/ProfileView";

export default function NbfcProfilePage() {
  return <ProfileView />;
}
