import { AnalyticsView } from "@/components/linkedin/AnalyticsView";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";

export const dynamic = "force-dynamic";

export default async function Page() {
  await requireRole([...LINKEDIN_ROLES]);
  return <AnalyticsView />;
}
