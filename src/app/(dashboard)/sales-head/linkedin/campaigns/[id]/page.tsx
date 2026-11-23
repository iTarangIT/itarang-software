import { CampaignDetailView } from "@/components/linkedin/CampaignDetailView";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireRole([...LINKEDIN_ROLES]);
  const { id } = await params;
  return <CampaignDetailView id={id} />;
}
