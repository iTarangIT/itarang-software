import { redirect } from "next/navigation";

// E-307 — moved into the Ecofy workspace. Kept so old links and bookmarks land.
export default async function OldEcofyLeadsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
    const { view } = await searchParams;
    redirect(view === "all" ? "/sales-head/ecofy/leads?view=all" : "/sales-head/ecofy/leads");
}
