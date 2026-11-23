import DealerCheckAction from "./DealerCheckAction";

export const dynamic = "force-dynamic";

// 23 Nov (point 4) — opened from the dealer-check email / WhatsApp link. No
// login: the signed token in the path is the credential (see the API route).
export default async function DealerCheckActionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-xl">
        <p className="mb-1 text-xs font-bold uppercase tracking-wider text-[#0047AB]">iTarang · Dealer check</p>
        <DealerCheckAction token={token} />
      </div>
    </main>
  );
}
