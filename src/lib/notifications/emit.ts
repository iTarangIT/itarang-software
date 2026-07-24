/**
 * The CRM-wide notification emitter.
 *
 * ONE call per business event, fanned out to every party that needs to know,
 * with per-recipient copy, deep link and inline actions. It generalises the
 * buyback dispatcher's `writeBell` (src/lib/buyback/dispatch.ts) — the only part
 * of the app that ever got this right — from three hard-coded recipient parties
 * to an audience list any flow can use.
 *
 * THE RULE THAT MAKES THE BELL WORK: EVERY ROW SETS user_id.
 * `/api/notifications` is scoped by user_id. Rows written with only dealer_id
 * (which is how every dealer notification used to be written) are invisible
 * there — that is precisely why the dealer bell was permanently empty. So this
 * module resolves an audience down to actual logins and writes one row per
 * person, which also gives per-person read state. `dealer_id` is still stamped
 * on dealer rows for back-compat with anything reading it.
 *
 * BEST-EFFORT BY CONTRACT. A notification must never be the reason a business
 * action fails. Every audience is resolved and written inside its own try/catch,
 * and `emit()` itself never throws. Callers may still wrap it; they don't have
 * to.
 */
import { and, eq, isNotNull, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  accounts,
  leads,
  nbfcLeadAssignments,
  nbfcTenants,
  nbfcUsers,
  notifications,
  users,
} from "@/lib/db/schema";
import { sendEmail } from "@/lib/email/mailer";
import { emailWorthy } from "@/lib/notifications/catalog";
import { getEmailTransport } from "@/lib/notifications/resolve-channel";
import {
  ADMIN_PARTY,
  SYSTEM_PARTY,
  type Party,
  provenanceLine,
} from "@/lib/notifications/provenance";

export type { Party };

/** Admin-side roles that receive "goes to iTarang" notifications by default. */
export const ADMIN_AUDIENCE_ROLES = ["admin", "ceo", "business_head", "sales_head"];

export type Audience =
  | { kind: "roles"; roles: string[] }
  | { kind: "user"; userId: string }
  /** Every active login whose users.dealer_id matches (accounts.id / dealer code). */
  | { kind: "dealer"; dealerId: string }
  /** Same, but the dealer is resolved from leads.dealer_id. */
  | { kind: "lead_dealer"; leadId: string }
  /** Every seat of one NBFC tenant. */
  | { kind: "nbfc"; tenantId: string }
  /** Every NBFC routed to this lead (nbfc_lead_assignments), optionally minus one. */
  | { kind: "lead_nbfc"; leadId: string; exceptTenantId?: string | null }
  | { kind: "vendor"; email?: string | null; vendorEntityId?: string | null };

/**
 * A one-click action rendered as a button on the notification row.
 *
 * Only for decisions that need NO input — the endpoint is POSTed as-is. Anything
 * requiring a reason, a document label or an upload sets `opensHref` and routes
 * to the page instead; a half-filled form in a dropdown helps nobody.
 *
 * Endpoints are the app's ordinary session-authenticated routes, so this adds no
 * new server surface and no new authorisation path.
 */
export interface NotifAction {
  label: string;
  endpoint: string;
  method?: "POST" | "PATCH" | "PUT";
  body?: Record<string, unknown>;
  /** Shown in a confirm() before firing. */
  confirm?: string;
  variant?: "primary" | "danger" | "neutral";
  /** Navigate to the row's href instead of calling an endpoint. */
  opensHref?: boolean;
  /** Toast/label shown after a successful call. */
  successLabel?: string;
}

export interface Recipient {
  audience: Audience;
  /** Who this copy is addressed to — the "to" half of the provenance line. */
  as: Party;
  /** The exact page this recipient should land on. Strongly recommended. */
  href?: string | null;
  actions?: NotifAction[];
  /** Per-recipient copy overrides; falls back to the event-level title/message. */
  title?: string;
  message?: string;
  /** Force email on/off for this recipient only. */
  email?: boolean;
  /** Extra data merged into this recipient's row only. */
  data?: Record<string, unknown>;
}

export interface EmitInput {
  /** `<domain>.<event>` — see src/lib/notifications/catalog.ts. Max 50 chars. */
  type: string;
  title: string;
  message: string;
  leadId?: string | null;
  /** Where in the journey this happened: "Field Investigation", "Step 4"… */
  stage?: string | null;
  /** Who raised it. Use `actingParty()` in a request context. */
  from?: Party;
  to: Recipient[];
  /** Shared payload merged into every row's `data`. */
  data?: Record<string, unknown>;
  /** Overrides the catalog's per-type default for every recipient. */
  email?: boolean;
  emailSubject?: string;
}

interface ResolvedTarget {
  userId: string;
  email: string | null;
  dealerId?: string | null;
  /** Tenant whose SMTP should send this recipient's email, when NBFC-scoped. */
  tenantId?: string | null;
}

function genId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 9).toUpperCase();
  return `NOTIF-${ts}-${rand}`;
}

/** `notifications.type` is varchar(50); a longer string would 22001 the INSERT. */
function safeType(type: string): string {
  return type.length <= 50 ? type : type.slice(0, 50);
}

async function usersWhere(where: SQL | undefined) {
  return db
    .select({ id: users.id, email: users.email, dealer_id: users.dealer_id })
    .from(users)
    .where(where);
}

/** Turn one audience into the concrete logins that should receive a row. */
async function resolve(audience: Audience): Promise<ResolvedTarget[]> {
  switch (audience.kind) {
    case "roles": {
      const roles = audience.roles.map((r) => r.toLowerCase()).filter(Boolean);
      if (roles.length === 0) return [];
      // LOWER(role), not role: seeded rows are inconsistently cased and a
      // case-sensitive match silently returns nobody — the same trap that broke
      // the users-by-email lookups.
      const rows = await usersWhere(
        and(sql`LOWER(${users.role}) IN ${roles}`, eq(users.is_active, true)),
      );
      return rows.map((r) => ({ userId: r.id, email: r.email ?? null }));
    }

    case "user": {
      if (!audience.userId) return [];
      const rows = await usersWhere(eq(users.id, audience.userId));
      return rows.map((r) => ({ userId: r.id, email: r.email ?? null, dealerId: r.dealer_id }));
    }

    case "dealer": {
      if (!audience.dealerId) return [];
      const rows = await usersWhere(
        and(eq(users.dealer_id, audience.dealerId), eq(users.is_active, true)),
      );
      return rows.map((r) => ({
        userId: r.id,
        email: r.email ?? null,
        dealerId: audience.dealerId,
      }));
    }

    case "lead_dealer": {
      if (!audience.leadId) return [];
      const [lead] = await db
        .select({ dealer_id: leads.dealer_id })
        .from(leads)
        .where(eq(leads.id, audience.leadId))
        .limit(1);
      if (!lead?.dealer_id) return [];
      return resolve({ kind: "dealer", dealerId: lead.dealer_id });
    }

    case "nbfc": {
      if (!audience.tenantId) return [];
      const rows = await db
        .select({ id: users.id, email: users.email })
        .from(nbfcUsers)
        .innerJoin(users, eq(users.id, nbfcUsers.user_id))
        .where(and(eq(nbfcUsers.tenant_id, audience.tenantId), eq(users.is_active, true)));
      return rows.map((r) => ({ userId: r.id, email: r.email ?? null, tenantId: audience.tenantId }));
    }

    case "lead_nbfc": {
      if (!audience.leadId) return [];
      const assigned = await db
        .select({ tenant_id: nbfcLeadAssignments.tenant_id })
        .from(nbfcLeadAssignments)
        .where(eq(nbfcLeadAssignments.lead_id, audience.leadId));
      const tenantIds = [...new Set(assigned.map((a) => a.tenant_id))].filter(
        (t) => t && t !== audience.exceptTenantId,
      );
      const out: ResolvedTarget[] = [];
      for (const tenantId of tenantIds) {
        out.push(...(await resolve({ kind: "nbfc", tenantId })));
      }
      return out;
    }

    case "vendor": {
      if (audience.vendorEntityId) {
        const rows = await usersWhere(
          and(eq(users.vendor_entity_id, audience.vendorEntityId), eq(users.is_active, true)),
        );
        if (rows.length > 0) return rows.map((r) => ({ userId: r.id, email: r.email ?? null }));
      }
      if (audience.email) {
        // Scoped to the vendor role so a shared address can never notify a dealer.
        const rows = await db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(
            and(
              eq(users.role, "scrap_vendor"),
              eq(users.is_active, true),
              isNotNull(users.email),
            ),
          );
        const wanted = audience.email.toLowerCase();
        return rows
          .filter((r) => (r.email ?? "").toLowerCase() === wanted)
          .map((r) => ({ userId: r.id, email: r.email ?? null }));
      }
      return [];
    }

    default:
      return [];
  }
}

/** De-dupe rows for the same person across overlapping audiences. */
function dedupe(targets: ResolvedTarget[]): ResolvedTarget[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    if (!t.userId || seen.has(t.userId)) return false;
    seen.add(t.userId);
    return true;
  });
}

/**
 * Write one notification per (recipient audience × login), plus the matching
 * emails. Never throws.
 */
export async function emit(input: EmitInput): Promise<void> {
  const from = input.from ?? SYSTEM_PARTY;
  const type = safeType(input.type);
  const wantEmailByDefault = input.email ?? emailWorthy(type);

  // Everyone already written to in THIS emit, so a person who is both (say) an
  // admin role and the lead's dealer gets the first, most specific copy only.
  const alreadyNotified = new Set<string>();

  for (const recipient of input.to) {
    try {
      const targets = dedupe(await resolve(recipient.audience)).filter(
        (t) => !alreadyNotified.has(t.userId),
      );
      if (targets.length === 0) continue;
      targets.forEach((t) => alreadyNotified.add(t.userId));

      const title = recipient.title ?? input.title;
      const message = recipient.message ?? input.message;
      const data = {
        ...(input.data ?? {}),
        ...(recipient.data ?? {}),
        from,
        to: recipient.as,
        stage: input.stage ?? null,
        href: recipient.href ?? null,
        actions: recipient.actions ?? null,
        leadId: input.leadId ?? null,
      };

      await db.insert(notifications).values(
        targets.map((t) => ({
          id: genId(),
          user_id: t.userId,
          // Kept in step with user_id so anything still reading dealer_id sees
          // the row too; the feed's scope prefers user_id.
          dealer_id: t.dealerId ?? null,
          lead_id: input.leadId ?? null,
          type,
          title,
          message,
          data,
          read: false,
        })),
      );

      const sendMail = recipient.email ?? wantEmailByDefault;
      if (sendMail) {
        await emailTargets(targets, {
          subject: input.emailSubject ?? `[iTarang] ${title}`,
          title,
          message,
          provenance: provenanceLine(from, recipient.as, input.stage),
          href: recipient.href ?? null,
        });
      }
    } catch (error) {
      // Swallowed on purpose — see the module doc-block. One failed audience
      // must not stop the others, and none of them may fail the caller.
      console.error(`[notify] emit(${input.type}) failed for an audience:`, error);
    }
  }
}

const APP_URL = () =>
  process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://app.itarang.com";

async function emailTargets(
  targets: ResolvedTarget[],
  mail: { subject: string; title: string; message: string; provenance: string | null; href: string | null },
): Promise<void> {
  const to = targets.map((t) => t.email).filter((e): e is string => !!e);
  if (to.length === 0) return;

  const link = mail.href ? `${APP_URL().replace(/\/+$/, "")}${mail.href}` : null;
  const html = [
    `<p><strong>${escapeHtml(mail.title)}</strong></p>`,
    `<p>${escapeHtml(mail.message)}</p>`,
    mail.provenance ? `<p style="color:#64748b;font-size:12px">${escapeHtml(mail.provenance)}</p>` : "",
    link ? `<p><a href="${link}">Open in iTarang →</a></p>` : "",
  ].join("");
  const text = [mail.title, "", mail.message, mail.provenance ?? "", link ?? ""]
    .filter(Boolean)
    .join("\n");

  // An NBFC recipient's mail goes through that tenant's own gateway when it has
  // configured one (§15.5); everyone else uses the platform-global transport.
  const tenantId = targets.find((t) => t.tenantId)?.tenantId ?? null;
  try {
    if (tenantId) {
      const { transporter, from } = await getEmailTransport(tenantId);
      await transporter.sendMail({ from, to, subject: mail.subject, text, html });
      return;
    }
    await sendEmail({ to, subject: mail.subject, text, html });
  } catch (error) {
    console.error("[notify] email send failed:", error);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ *
 * Convenience audience builders — keep call sites at one line each.
 * ------------------------------------------------------------------ */

export const toAdmins = (
  opts: { href?: string | null; actions?: NotifAction[]; title?: string; message?: string; email?: boolean } = {},
): Recipient => ({
  audience: { kind: "roles", roles: ADMIN_AUDIENCE_ROLES },
  as: ADMIN_PARTY,
  ...opts,
});

export const toLeadDealer = (
  leadId: string,
  opts: { href?: string | null; actions?: NotifAction[]; title?: string; message?: string; email?: boolean } = {},
): Recipient => ({
  audience: { kind: "lead_dealer", leadId },
  as: { party: "dealer", label: "Dealer" },
  href: opts.href ?? `/dealer-portal/leads/${leadId}`,
  ...opts,
});

export const toNbfc = (
  tenantId: string,
  label: string,
  opts: { href?: string | null; actions?: NotifAction[]; title?: string; message?: string; email?: boolean } = {},
): Recipient => ({
  audience: { kind: "nbfc", tenantId },
  as: { party: "nbfc", label },
  ...opts,
});

export const toLeadNbfcs = (
  leadId: string,
  opts: {
    href?: string | null;
    actions?: NotifAction[];
    title?: string;
    message?: string;
    email?: boolean;
    exceptTenantId?: string | null;
  } = {},
): Recipient => ({
  audience: { kind: "lead_nbfc", leadId, exceptTenantId: opts.exceptTenantId ?? null },
  as: { party: "nbfc", label: "NBFC partner" },
  href: opts.href ?? `/nbfc/acquire/${leadId}`,
  ...opts,
});

/** Display name of the NBFC tenant, for the "to" label. Best-effort. */
export async function tenantDisplayName(tenantId: string): Promise<string> {
  try {
    const [row] = await db
      .select({ name: nbfcTenants.display_name })
      .from(nbfcTenants)
      .where(eq(nbfcTenants.id, tenantId))
      .limit(1);
    return row?.name || "NBFC partner";
  } catch {
    return "NBFC partner";
  }
}

/** Business name for a dealer account id, for the "to" label. Best-effort. */
export async function dealerDisplayName(dealerId: string | null | undefined): Promise<string> {
  if (!dealerId) return "Dealer";
  try {
    const [row] = await db
      .select({ name: accounts.business_entity_name })
      .from(accounts)
      .where(eq(accounts.id, dealerId))
      .limit(1);
    return row?.name || dealerId;
  } catch {
    return dealerId;
  }
}
