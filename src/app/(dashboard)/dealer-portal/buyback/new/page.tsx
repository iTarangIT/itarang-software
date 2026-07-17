import BuybackIntake from "@/components/buyback/intake/BuybackIntake";

export const metadata = {
  title: "New Buyback Request · iTarang",
};

/**
 * `?request_id=<uuid>` reopens that draft instead of starting a new one.
 *
 * Read here, in the server component, and handed down as a prop — rather than
 * useSearchParams() inside the intake, which would drag the whole client
 * component behind a Suspense boundary for the sake of one string.
 */
export default async function NewBuybackRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ request_id?: string | string[] }>;
}) {
  const { request_id } = await searchParams;
  const resumeId = Array.isArray(request_id) ? request_id[0] : request_id;

  return <BuybackIntake resumeId={resumeId ?? null} />;
}
