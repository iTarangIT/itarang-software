import { redirect } from "next/navigation";
import { PageShell } from "@/components/layout/PageShell";
import { requireAuth } from "@/lib/auth-utils";
import { getAuditFeed } from "@/lib/calculator/admin-service";

export const dynamic = "force-dynamic";

const badge: Record<string, string> = {
  create: "bg-emerald-50 text-emerald-700",
  update: "bg-amber-50 text-amber-700",
  delete: "bg-red-50 text-red-700",
};

export default async function Page() {
  let user;
  try {
    user = await requireAuth();
  } catch {
    redirect("/login");
  }
  if (!["admin", "sales_head"].includes(user.role)) redirect("/login");

  const { logs, versions } = await getAuditFeed(150);
  const versionNote = new Map(versions.map((v) => [v.id, v.note]));

  return (
    <PageShell
      eyebrow="LOAN CALCULATOR"
      title="Version History & Audit"
      subtitle="Every config change, newest first — who changed what, before → after, and the config version it created."
      breadcrumb={[{ label: "Admin", href: "/admin" }, { label: "Loan Calculator", href: "/admin/calculator" }, { label: "Audit" }]}
    >
      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
        {logs.length === 0 && <p className="px-5 py-6 text-sm text-gray-400">No config changes yet.</p>}
        <ul className="divide-y divide-gray-50">
          {logs.map((l) => (
            <li key={l.id} className="px-5 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badge[l.action] ?? "bg-gray-100 text-gray-600"}`}>{l.action}</span>
                <span className="font-semibold text-gray-900">{l.entity}</span>
                <span className="text-gray-400">#{l.entityId}</span>
                <span className="text-gray-400">·</span>
                <span className="text-gray-500">{new Date(l.at as unknown as string).toLocaleString("en-IN")}</span>
                {l.configVersionId != null && (
                  <span className="ml-auto text-xs text-gray-400">
                    v{l.configVersionId}
                    {versionNote.get(l.configVersionId) ? ` · ${versionNote.get(l.configVersionId)}` : ""}
                  </span>
                )}
              </div>
              {(l.before || l.after) && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-800">before → after</summary>
                  <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                    <pre className="overflow-x-auto rounded-lg bg-gray-50 p-2 text-[11px] text-gray-600">{JSON.stringify(l.before ?? {}, null, 2)}</pre>
                    <pre className="overflow-x-auto rounded-lg bg-gray-50 p-2 text-[11px] text-gray-600">{JSON.stringify(l.after ?? {}, null, 2)}</pre>
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      </div>
    </PageShell>
  );
}
