/**
 * /nbfc/settings — Tenant configuration (BRD §6.1.8)
 *
 * Three sections:
 *   1. Tenant info (read-only)
 *   2. Users — list + invite/remove (POST/DELETE /api/nbfc/users)
 *   3. Notification preferences (jsonb stored on nbfc_users.notification_prefs)
 *   4. Risk-rule thresholds (read-only — admin edits at /admin/nbfc/risk-rules)
 */
import Link from "next/link";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getCurrentTenant, getSessionUser } from "@/lib/nbfc/tenant";
import { nbfcUsers, nbfcRiskRules, users as usersTable } from "@/lib/db/schema";
import UsersSection from "./_components/UsersSection";
import NotificationPrefsSection from "./_components/NotificationPrefsSection";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const tenant = await getCurrentTenant();
  const session = await getSessionUser();

  const memberships = await db
    .select({
      user_id: nbfcUsers.user_id,
      role: nbfcUsers.role,
      created_at: nbfcUsers.created_at,
      notification_prefs: nbfcUsers.notification_prefs,
      email: usersTable.email,
      name: usersTable.name,
    })
    .from(nbfcUsers)
    .leftJoin(usersTable, eq(usersTable.id, nbfcUsers.user_id))
    .where(eq(nbfcUsers.tenant_id, tenant.id));

  const myMembership = memberships.find((m) => m.user_id === session?.id);

  const thresholdRules = await db.select().from(nbfcRiskRules);

  return (
    <div className="space-y-6">
      <header>
        <p className="section-label-muted">Settings</p>
        <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
          {tenant.display_name}
        </h1>
      </header>

      {/* Tenant info */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500 mb-3">
          Tenant
        </h2>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3 text-sm">
          <Field k="Slug" v={tenant.slug} />
          <Field k="Display name" v={tenant.display_name} />
          <Field k="Contact email" v={tenant.contact_email ?? "—"} />
          <Field
            k="AUM"
            v={tenant.aum_inr ? `₹${Number(tenant.aum_inr).toLocaleString("en-IN")}` : "—"}
          />
          <Field k="Active loans" v={tenant.active_loans.toLocaleString("en-IN")} />
        </dl>
      </section>

      {/* Users */}
      <UsersSection
        tenantId={tenant.id}
        currentUserId={session?.id ?? null}
        members={memberships.map((m) => ({
          user_id: m.user_id,
          role: m.role,
          email: m.email,
          name: m.name,
          created_at: m.created_at?.toISOString() ?? null,
        }))}
      />

      {/* Notification preferences (only show if the current viewer has a membership) */}
      {myMembership ? (
        <NotificationPrefsSection
          initialPrefs={
            (myMembership.notification_prefs ?? {}) as Record<string, unknown>
          }
        />
      ) : null}

      {/* Risk-rule thresholds (read-only) */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-widest text-slate-500">
              Risk-rule thresholds
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Read-only here. Edits go through the iTarang admin and a dual-approval gate.
            </p>
          </div>
          <Link
            href="/admin/nbfc/risk-rules"
            className="text-xs underline text-[color:var(--color-brand-navy)]"
          >
            Edit (admin) →
          </Link>
        </div>
        {thresholdRules.length === 0 ? (
          <p className="text-sm text-slate-500 italic">No threshold rules configured yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-xs uppercase tracking-widest text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-bold">Rule</th>
                <th className="px-3 py-2 text-right font-bold">Value</th>
                <th className="px-3 py-2 text-left font-bold">Updated</th>
              </tr>
            </thead>
            <tbody>
              {thresholdRules.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-3 py-1.5 font-mono text-xs">{r.rule_key}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-bold">
                    {Number(r.current_value).toLocaleString("en-IN")}
                    {r.unit ? ` ${r.unit}` : ""}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-slate-500 tabular-nums">
                    {r.updated_at?.toLocaleString() ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Field({ k, v }: { k: string; v: string | number }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{k}</dt>
      <dd className="mt-0.5 font-medium">{v}</dd>
    </div>
  );
}
