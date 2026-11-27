/**
 * /nbfc/settings — Tenant configuration (BRD §6.1.8)
 *
 * Grouped into tabs (SettingsTabs, `?tab=`):
 *   organisation  — profile card + risk-rule thresholds (read-only)
 *   team          — users / invite / approval hierarchy, step owners, roles
 *   services      — Service Opt-In (FI, VKYC, E-NACH, e-sign, track rules)
 *   wallet        — prepaid wallet
 *   agents        — recovery agent directory
 *   notifications — my preferences + tenant channels
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getCurrentTenant, getSessionUser } from "@/lib/nbfc/tenant";
import {
  nbfcUsers,
  nbfcTenants,
  nbfcRiskRules,
  nbfcServiceConfig,
  nbfcStepOwners,
  users as usersTable,
} from "@/lib/db/schema";
import { publicOrigin } from "@/lib/public-origin";
import {
  NBFC_OWNER_STEPS,
  normalizeNbfcRole,
  type NbfcOwnerStep,
} from "@/lib/nbfc/origination-roles";
import {
  FileCheck2,
  Hash,
  Landmark,
  Lock,
  Mail,
  ShieldAlert,
  Users,
} from "lucide-react";
import UsersSection from "./_components/UsersSection";
import RolesSection from "./_components/RolesSection";
import NotificationChannelsSection from "./_components/NotificationChannelsSection";
import NotificationPrefsSection from "./_components/NotificationPrefsSection";
import ServiceOptInSection, {
  type ServiceConfig,
} from "./_components/ServiceOptInSection";
import StepOwnersSection from "./_components/StepOwnersSection";
import WalletSection from "./_components/WalletSection";
import RecoveryAgentDirectory from "./_components/RecoveryAgentDirectory";
import SettingsTabs, { type SettingsTab } from "./_components/SettingsTabs";

export const dynamic = "force-dynamic";

const SERVICE_CONFIG_DEFAULTS: ServiceConfig = {
  fi_enabled: false,
  vkyc_enabled: false,
  vkyc_mode: null,
  vkyc_endpoint_url: null,
  enach_enabled: false,
  enach_handoff_method: null,
  enach_endpoint_url: null,
  doc_agreement_method: null,
  esign_endpoint_url: null,
  esign_provider: null,
  store_sanction_letter: false,
  store_loan_agreement: false,
  track_completion_gate: true,
  track_failure_halts: false,
  vkyc_webhook_secret: null,
  enach_webhook_secret: null,
  esign_webhook_secret: null,
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = (await searchParams) ?? {};
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
      phone: usersTable.phone,
      // E-387 — parent/child CIBIL approval hierarchy.
      parent_user_id: nbfcUsers.parent_user_id,
      delegated_steps: nbfcUsers.delegated_steps,
      // E-388 — menus + designation.
      allowed_nav: nbfcUsers.allowed_nav,
      title: nbfcUsers.title,
    })
    .from(nbfcUsers)
    .leftJoin(usersTable, eq(usersTable.id, nbfcUsers.user_id))
    .where(eq(nbfcUsers.tenant_id, tenant.id));

  const myMembership = memberships.find((m) => m.user_id === session?.id);
  // Normalise the legacy 'admin' seed → 'nbfc_admin' so the account owner can
  // edit (mirrors resolveActor; the server PUT routes apply the same mapping).
  const canEdit = normalizeNbfcRole(myMembership?.role) === "nbfc_admin";
  const [hierarchyRow] = await db
    .select({ enabledAt: nbfcTenants.cibil_review_enabled_at })
    .from(nbfcTenants)
    .where(eq(nbfcTenants.id, tenant.id))
    .limit(1);

  // Addendum V0.2 §7.4 / §7.2 — Service Opt-In config + step owners.
  const [serviceCfgRow] = await db
    .select()
    .from(nbfcServiceConfig)
    .where(eq(nbfcServiceConfig.tenant_id, tenant.id))
    .limit(1);

  const serviceConfig: ServiceConfig = serviceCfgRow
    ? {
        fi_enabled: serviceCfgRow.fi_enabled,
        vkyc_enabled: serviceCfgRow.vkyc_enabled,
        vkyc_mode: serviceCfgRow.vkyc_mode as ServiceConfig["vkyc_mode"],
        vkyc_endpoint_url: serviceCfgRow.vkyc_endpoint_url,
        enach_enabled: serviceCfgRow.enach_enabled,
        enach_handoff_method:
          serviceCfgRow.enach_handoff_method as ServiceConfig["enach_handoff_method"],
        enach_endpoint_url: serviceCfgRow.enach_endpoint_url,
        doc_agreement_method:
          serviceCfgRow.doc_agreement_method as ServiceConfig["doc_agreement_method"],
        esign_endpoint_url: serviceCfgRow.esign_endpoint_url,
        esign_provider: serviceCfgRow.esign_provider,
        store_sanction_letter: serviceCfgRow.store_sanction_letter,
        store_loan_agreement: serviceCfgRow.store_loan_agreement,
        track_completion_gate: serviceCfgRow.track_completion_gate,
        track_failure_halts: serviceCfgRow.track_failure_halts,
        fi_config: (serviceCfgRow.fi_config as ServiceConfig["fi_config"]) ?? null,
        vkyc_webhook_secret: serviceCfgRow.vkyc_webhook_secret,
        enach_webhook_secret: serviceCfgRow.enach_webhook_secret,
        esign_webhook_secret: serviceCfgRow.esign_webhook_secret,
      }
    : SERVICE_CONFIG_DEFAULTS;

  const stepOwnerRows = await db
    .select()
    .from(nbfcStepOwners)
    .where(eq(nbfcStepOwners.tenant_id, tenant.id));

  const ownerSteps = new Set<string>(NBFC_OWNER_STEPS);
  const stepOwners = stepOwnerRows
    .filter((o) => ownerSteps.has(o.step))
    .map((o) => ({
      step: o.step as NbfcOwnerStep,
      city: o.city,
      user_id: o.user_id,
    }));

  let callbackBase = "";
  try {
    callbackBase = publicOrigin();
  } catch {
    callbackBase = "";
  }

  const thresholdRules = await db.select().from(nbfcRiskRules);

  const tabs: SettingsTab[] = [
    {
      id: "organisation",
      label: "Organisation",
      hint: "Your NBFC profile and risk limits",
      content: (
        <>
          <OrganisationCard tenant={tenant} teamSize={memberships.length} />
          <RiskThresholds
            rules={thresholdRules.map((r) => ({
              id: String(r.id),
              rule_key: r.rule_key,
              current_value: Number(r.current_value),
              unit: r.unit ?? null,
              updated_at: r.updated_at ?? null,
            }))}
          />
        </>
      ),
    },
    {
      id: "team",
      label: "Team & access",
      hint: "People, roles and who approves what",
      content: (
        <>
          <UsersSection
            tenantId={tenant.id}
            currentUserId={session?.id ?? null}
            canManage={canEdit}
            cibilReviewEnabledAt={hierarchyRow?.enabledAt?.toISOString() ?? null}
            members={memberships.map((m) => ({
              user_id: m.user_id,
              role: m.role,
              email: m.email,
              name: m.name,
              phone: m.phone ?? null,
              parent_user_id: m.parent_user_id ?? null,
              delegated_steps: Array.isArray(m.delegated_steps) ? m.delegated_steps : [],
              allowed_nav: Array.isArray(m.allowed_nav) ? m.allowed_nav : null,
              title: m.title ?? null,
              created_at: m.created_at?.toISOString() ?? null,
            }))}
          />
          {/* Step owners (§7.2) */}
          <StepOwnersSection
            members={memberships.map((m) => ({
              user_id: m.user_id,
              email: m.email,
              name: m.name,
            }))}
            initialOwners={stepOwners}
            canEdit={canEdit}
          />
          {/* Roles — custom RBAC (§15.8): system roles + clone-to-customise */}
          <RolesSection />
        </>
      ),
    },
    {
      id: "services",
      label: "Loan services",
      hint: "Field check, Video KYC, E-NACH, e-sign",
      // Service Opt-In + document/track config (§7.4)
      content: (
        <ServiceOptInSection
          initialConfig={serviceConfig}
          canEdit={canEdit}
          callbackBase={callbackBase}
        />
      ),
    },
    {
      id: "wallet",
      label: "Wallet & billing",
      hint: "Balance, top-ups and transactions",
      // Prepaid balance, auto-NACH config, transaction history (§8.1)
      content: <WalletSection canEdit={canEdit} />,
    },
    {
      id: "agents",
      label: "Recovery agents",
      hint: "People sent to collect batteries",
      // E-262 — the Recovery queue cannot dispatch anyone until this list has a
      // name in it, so it gets its own tab rather than sitting inside Services.
      content: <RecoveryAgentDirectory canEdit={canEdit} />,
    },
    {
      id: "notifications",
      label: "Notifications",
      hint: "Alerts you get and how they are sent",
      content: (
        <>
          {/* My preferences — only when the viewer has a membership. */}
          {myMembership ? (
            <NotificationPrefsSection
              initialPrefs={(myMembership.notification_prefs ?? {}) as Record<string, unknown>}
            />
          ) : null}
          {/* Notification Channels — per-NBFC Email/SMS/WhatsApp gateways (§15.5) */}
          <NotificationChannelsSection />
        </>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="section-label-muted">Settings</p>
          <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
            {tenant.display_name}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Manage your organisation, team, services and alerts in one place.
          </p>
        </div>
        {!canEdit ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">
            <Lock className="h-3.5 w-3.5" />
            View only — ask your NBFC admin to make changes
          </span>
        ) : null}
      </header>

      <SettingsTabs tabs={tabs} initialTab={params.tab} />
    </div>
  );
}

type Tenant = Awaited<ReturnType<typeof getCurrentTenant>>;

function OrganisationCard({ tenant, teamSize }: { tenant: Tenant; teamSize: number }) {
  const initials =
    tenant.display_name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "N";
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-4 bg-gradient-to-r from-[color:var(--color-brand-navy)] to-sky-600 px-6 py-5 text-white">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-white/15 text-xl font-bold ring-1 ring-white/30">
          {initials}
        </div>
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold">{tenant.display_name}</h3>
          <p className="flex items-center gap-1.5 text-sm text-white/80">
            <Mail className="h-3.5 w-3.5" />
            {tenant.contact_email ?? "No contact email on file"}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-4 sm:divide-x divide-slate-100 dark:divide-slate-800">
        <Stat
          icon={<Landmark className="h-4 w-4" />}
          k="Assets under management"
          v={tenant.aum_inr ? `₹${Number(tenant.aum_inr).toLocaleString("en-IN")}` : "—"}
        />
        <Stat
          icon={<FileCheck2 className="h-4 w-4" />}
          k="Active loans"
          v={Number(tenant.active_loans ?? 0).toLocaleString("en-IN")}
        />
        <Stat icon={<Users className="h-4 w-4" />} k="Team members" v={String(teamSize)} />
        <Stat
          icon={<Hash className="h-4 w-4" />}
          k="Account ID"
          v={<span className="font-mono text-sm">{tenant.slug}</span>}
        />
      </dl>
    </section>
  );
}

function Stat({ icon, k, v }: { icon: ReactNode; k: string; v: ReactNode }) {
  return (
    <div className="px-6 py-4">
      <dt className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
        <span className="text-slate-400">{icon}</span>
        {k}
      </dt>
      <dd className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">{v}</dd>
    </div>
  );
}

/** rule_key like "cds_min_score" → "Cds min score". */
function humanizeRule(key: string): string {
  const s = key.replace(/[_.-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function RiskThresholds({
  rules,
}: {
  rules: {
    id: string;
    rule_key: string;
    current_value: number;
    unit: string | null;
    updated_at: Date | null;
  }[];
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-50 text-rose-600">
            <ShieldAlert className="h-[18px] w-[18px]" />
          </span>
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-slate-100">Risk limits</h3>
            <p className="text-sm text-slate-500">
              Thresholds that raise risk alerts. Read-only here — iTarang admin changes them
              with a two-person approval.
            </p>
          </div>
        </div>
        <Link
          href="/admin/nbfc/risk-rules"
          className="text-sm font-medium text-[color:var(--color-brand-navy)] hover:underline"
        >
          Edit (admin) →
        </Link>
      </div>
      {rules.length === 0 ? (
        <p className="rounded-lg bg-slate-50 px-4 py-6 text-center text-sm text-slate-500 dark:bg-slate-800/50">
          No risk limits configured yet.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rules.map((r) => (
            <div
              key={r.id}
              className="rounded-lg border border-slate-200 px-4 py-3 dark:border-slate-800"
              title={r.rule_key}
            >
              <div className="text-xs text-slate-500">{humanizeRule(r.rule_key)}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {r.current_value.toLocaleString("en-IN")}
                {r.unit ? (
                  <span className="ml-1 text-sm font-normal text-slate-500">{r.unit}</span>
                ) : null}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-400">
                Updated {r.updated_at ? r.updated_at.toLocaleDateString("en-IN") : "—"}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
