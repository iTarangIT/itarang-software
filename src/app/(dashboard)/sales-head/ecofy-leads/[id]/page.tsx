import { redirect } from "next/navigation";

// E-307 — moved into the Ecofy workspace. Kept so old links and bookmarks land.
export default async function OldEcofyLeadPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    redirect(`/sales-head/ecofy/leads/${id}`);
}
