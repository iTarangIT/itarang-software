"use client";

// Shared profile route for dealers, vendors and internal staff. NBFC partners
// and risk heads have their own routes (/nbfc/profile, /risk-head/profile) so
// they keep their portal chrome — all three render the same ProfileView.
import ProfileView from "@/components/profile/ProfileView";

export default function ProfilePage() {
  return <ProfileView />;
}
