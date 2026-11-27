/**
 * Server half of "File action alerts" (see party-routing-rules.ts for the
 * rules). Two jobs:
 *   1. load / save the Sales Head's ticks — app_settings key
 *      `notification_party_routing` (no migration; app_settings already exists);
 *   2. work out who the six parties of one lead file are, with the email and
 *      phone to reach each of them.
 *
 * Fails open: if the settings cannot be read, every type behaves as built-in.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  appSettings,
  dealerOnboardingApplications,
  dealerSalespersons,
  dealers,
  leadDealerReviews,
  leads,
  nbfcLeadAssignments,
  nbfcUsers,
  users,
} from "@/lib/db/schema";
import {
  normalizePartyRouting,
  type PartyKey,
  type PartyRoutingSettings,
  type TypeRule,
} from "./party-routing-rules";

const KEY = "notification_party_routing";
const TTL_MS = 60_000;

let cache: { value: PartyRoutingSettings; at: number } | null = null;

export async function getPartyRouting(): Promise<PartyRoutingSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const [row] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, KEY))
      .limit(1);
    const value = normalizePartyRouting(row?.value ?? null);
    cache = { value, at: Date.now() };
    return value;
  } catch (err) {
    console.error("[party-routing] could not read settings — built-in behaviour for every type:", err);
    const value = { rules: {} };
    cache = { value, at: Date.now() };
    return value;
  }
}

export async function setPartyRouting(next: PartyRoutingSettings): Promise<PartyRoutingSettings> {
  const clean = normalizePartyRouting(next);
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ key: KEY, value: clean, updated_at: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: clean, updated_at: now } });
  cache = { value: clean, at: Date.now() };
  return clean;
}

export async function partyRuleFor(type: string): Promise<TypeRule | null> {
  return (await getPartyRouting()).rules[type] ?? null;
}

/** One person (a CRM login) on the file. */
export interface PartyMember {
  userId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  role: string | null;
  dealerId: string | null;
  tenantId: string | null;
  parties: Set<PartyKey>;
}

/** A WhatsApp-only contact with no CRM login (dealer number, dealer's sales staff). */
export interface PartyPhone {
  phone: string;
  name: string | null;
  party: PartyKey;
}

export interface FileParties {
  members: Map<string, PartyMember>;
  phones: PartyPhone[];
  customer: string;
  reference: string;
  dealerId: string | null;
  actorName: string | null;
}

function tenDigits(p: string | null | undefined): string | null {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

export async function resolveFileParties(
  leadId: string,
  actorUserId: string | null,
): Promise<FileParties | null> {
  const [lead] = await db
    .select({
      dealer_id: leads.dealer_id,
      salesperson_id: leads.salesperson_id,
      full_name: leads.full_name,
      owner_name: leads.owner_name,
      reference_id: leads.reference_id,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return null;

  const members = new Map<string, PartyMember>();
  const userCols = {
    id: users.id,
    name: users.name,
    email: users.email,
    phone: users.phone,
    role: users.role,
    dealer_id: users.dealer_id,
  };
  type URow = { id: string; name: string | null; email: string | null; phone: string | null; role: string | null; dealer_id: string | null };
  const add = (u: URow, party: PartyKey, tenantId: string | null = null) => {
    const m =
      members.get(u.id) ??
      ({
        userId: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        role: u.role,
        dealerId: u.dealer_id,
        tenantId,
        parties: new Set<PartyKey>(),
      } satisfies PartyMember);
    if (tenantId && !m.tenantId) m.tenantId = tenantId;
    m.parties.add(party);
    members.set(u.id, m);
  };

  // Dealer logins.
  if (lead.dealer_id) {
    const rows = await db
      .select(userCols)
      .from(users)
      .where(and(eq(users.dealer_id, lead.dealer_id), eq(users.is_active, true)));
    rows.forEach((u) => add(u, "dealer"));
  }

  // Sales Heads.
  const heads = await db
    .select(userCols)
    .from(users)
    .where(and(sql`LOWER(${users.role}) = 'sales_head'`, eq(users.is_active, true)));
  heads.forEach((u) => add(u, "sales_head"));

  // NBFC seats of every NBFC this file is routed to; split approver vs child.
  const assigned = await db
    .select({ tenant_id: nbfcLeadAssignments.tenant_id })
    .from(nbfcLeadAssignments)
    .where(eq(nbfcLeadAssignments.lead_id, leadId));
  const tenantIds = [...new Set(assigned.map((a) => a.tenant_id).filter(Boolean))];
  if (tenantIds.length) {
    const seats = await db
      .select({ ...userCols, tenant_id: nbfcUsers.tenant_id, parent: nbfcUsers.parent_user_id })
      .from(nbfcUsers)
      .innerJoin(users, eq(users.id, nbfcUsers.user_id))
      .where(and(inArray(nbfcUsers.tenant_id, tenantIds), eq(users.is_active, true)));
    seats.forEach((s) => add(s, s.parent ? "nbfc_child" : "nbfc_partner", s.tenant_id));
  }

  const phones: PartyPhone[] = [];

  // iTarang salesperson who sent the file (dealer check initiator).
  try {
    const [review] = await db
      .select({ userId: leadDealerReviews.initiated_by_user_id, phone: leadDealerReviews.initiator_wa_phone })
      .from(leadDealerReviews)
      .where(eq(leadDealerReviews.lead_id, leadId))
      .orderBy(desc(leadDealerReviews.created_at))
      .limit(1);
    if (review?.userId) {
      const [u] = await db.select(userCols).from(users).where(eq(users.id, review.userId)).limit(1);
      if (u) add({ ...u, phone: review.phone || u.phone }, "salesperson");
    } else if (review?.phone) {
      phones.push({ phone: review.phone, name: null, party: "salesperson" });
    }
  } catch (err) {
    console.error("[party-routing] initiator lookup failed:", err);
  }

  // The dealer's own salesperson who created the lead on WhatsApp (E-277).
  if (lead.salesperson_id) {
    try {
      const [sp] = await db
        .select({ phone: dealerSalespersons.wa_phone, name: dealerSalespersons.display_name })
        .from(dealerSalespersons)
        .where(eq(dealerSalespersons.id, lead.salesperson_id))
        .limit(1);
      if (sp?.phone) phones.push({ phone: sp.phone, name: sp.name, party: "salesperson" });
    } catch (err) {
      console.error("[party-routing] dealer salesperson lookup failed:", err);
    }
  }

  // The dealer's WhatsApp number (onboarding chat number, else owner phone).
  if (lead.dealer_id) {
    const [app] = await db
      .select({ phone: dealerOnboardingApplications.wa_phone, name: dealerOnboardingApplications.owner_name })
      .from(dealerOnboardingApplications)
      .where(
        and(
          eq(dealerOnboardingApplications.dealer_code, lead.dealer_id),
          eq(dealerOnboardingApplications.onboarding_status, "approved"),
        ),
      )
      .orderBy(desc(dealerOnboardingApplications.created_at))
      .limit(1);
    let phone = app?.phone ?? null;
    let name = app?.name ?? null;
    if (!phone) {
      const [d] = await db
        .select({ phone: dealers.owner_phone, name: dealers.owner_name })
        .from(dealers)
        .where(eq(dealers.dealer_id, lead.dealer_id))
        .limit(1);
      phone = d?.phone ?? null;
      name = d?.name ?? name;
    }
    if (phone) phones.push({ phone, name, party: "dealer" });
  }

  let actorName: string | null = null;
  if (actorUserId) {
    const existing = members.get(actorUserId);
    if (existing) {
      existing.parties.add("actor");
      actorName = existing.name ?? existing.email;
    } else {
      const [u] = await db.select(userCols).from(users).where(eq(users.id, actorUserId)).limit(1);
      if (u) {
        add(u, "actor");
        actorName = u.name ?? u.email;
      }
    }
  }

  // A phone that already belongs to a login is reached through that login.
  const memberPhones = new Set([...members.values()].map((m) => tenDigits(m.phone)).filter(Boolean));
  const seen = new Set<string>();
  const uniquePhones = phones.filter((p) => {
    const t = tenDigits(p.phone);
    if (!t || memberPhones.has(t) || seen.has(`${p.party}|${t}`)) return false;
    seen.add(`${p.party}|${t}`);
    return true;
  });

  return {
    members,
    phones: uniquePhones,
    customer: lead.full_name || lead.owner_name || "Customer",
    reference: lead.reference_id || leadId,
    dealerId: lead.dealer_id ?? null,
    actorName,
  };
}
