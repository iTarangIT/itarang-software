import { redirect } from "next/navigation";

/**
 * Step 1 (Lead Details) lives in the shared lead form at
 * `/dealer-portal/leads/new`, which loads an existing lead for editing when
 * given `?id=`. The wizard steppers, however, link Step 1 to the bare lead URL
 * (`/dealer-portal/leads/[id]` — see e.g. product-selection/page.tsx stepHrefs).
 * Without a page here that bare URL 404s. Redirect it to the Step-1 editor so
 * "Step 1" in the stepper resumes the lead instead of dead-ending.
 */
export default async function LeadStep1Redirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/dealer-portal/leads/new?id=${encodeURIComponent(id)}`);
}
