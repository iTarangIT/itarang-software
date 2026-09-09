/** E-292 — /refurbisher-portal/lots/[id] — one lot, opened (deep link from a notification). */
import "@/app/auction-theme.css";
import RefurbisherConsole from "../../_components/RefurbisherConsole";

export const dynamic = "force-dynamic";
export const metadata = { title: "Lot · iTarang Refurbisher" };

export default async function RefurbisherLotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-[100rem] p-6">
      <RefurbisherConsole initialLotId={id} />
    </main>
  );
}
