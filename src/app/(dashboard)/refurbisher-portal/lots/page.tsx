/** E-292 — /refurbisher-portal/lots — same console; the list view the notifications link to. */
import "@/app/auction-theme.css";
import RefurbisherConsole from "../_components/RefurbisherConsole";

export const dynamic = "force-dynamic";
export const metadata = { title: "Lots · iTarang Refurbisher" };

export default function RefurbisherLotsPage() {
  return (
    <main className="mx-auto max-w-[100rem] p-6">
      <RefurbisherConsole />
    </main>
  );
}
