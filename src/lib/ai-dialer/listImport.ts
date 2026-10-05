// Excel/CSV → dealer_leads import for List-based dialer campaigns.
//
// Deterministic (no LLM): map columns via a small alias map, normalize phones
// with the shared E.164 helper, dedupe within the file, REUSE any existing
// dealer_leads row by phone — the SHARED duplicate check (last 10 digits,
// dedupe.ts), so a dealer stored as a bare 10-digit number is found too —
// and bulk-insert the rest as AI-dialable leads. New leads are written with
// lead_status = NULL / ai_recall_status = NULL so the exclusion filter
// (src/lib/ai-dialer/exclusionFilter.ts) lets advanceCampaign dial them.
//
// ID 81 (source on every lead):
//   - a new lead gets Entered via AI-dialer list, Found via (what the uploader
//     picked, else the calling-list default), the list's acquisition campaign
//     and a "Lead created" line;
//   - a dealer we already hold gets a Re-inquiry on the existing lead, and the
//     file only FILLS BLANKS on it. It used to overwrite the name and city of
//     an existing lead with whatever the sheet said, so a shop name a rep had
//     corrected was lost to a stale calling list.
//
// Returns the campaign queue (dealer_leads.id) in original file order plus an
// import summary the create route surfaces to the user.

import crypto from "crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { loadExistingByPhone, normalizePhone } from "@/lib/leads/dedupe";
import {
  LIST_DEFAULT_ORIGIN,
  recordLeadsCreatedBulk,
  recordReinquiries,
  stampLeadSourceBulk,
  type LeadOrigin,
} from "@/lib/leads/leadSource";
import { campaignForDialerList } from "@/lib/leads/acquisitionCampaigns";
import {
  normalizeCity,
  normalizeState,
  inferStateFromCity,
} from "@/lib/scraper-enrichment";

export const MAX_LIST_ROWS = 5000;

type CanonField = "phone" | "name" | "city" | "state" | "language" | "shop_name";

// Header alias → canonical field. Headers are lower-cased and any run of
// non-alphanumerics collapsed to "_" before lookup, so "Phone Number",
// "phone-number" and "PHONE_NUMBER" all map to the same key.
const HEADER_ALIASES: Record<string, CanonField> = {
  phone: "phone",
  phone_number: "phone",
  phoneno: "phone",
  phone_no: "phone",
  mobile: "phone",
  mobile_number: "phone",
  mobile_no: "phone",
  contact: "phone",
  contact_number: "phone",
  contact_no: "phone",
  number: "phone",
  whatsapp: "phone",
  name: "name",
  dealer_name: "name",
  dealer: "name",
  full_name: "name",
  contact_person: "name",
  person: "name",
  city: "city",
  town: "city",
  district: "city",
  state: "state",
  language: "language",
  lang: "language",
  shop_name: "shop_name",
  shop: "shop_name",
  business_name: "shop_name",
  firm_name: "shop_name",
  company: "shop_name",
};

export interface ListImportResult {
  /** dealer_leads.id in original (deduped) file order — the campaign queue. */
  queueIds: string[];
  /** Data rows seen (after the MAX_LIST_ROWS cap). */
  total: number;
  /** New dealer_leads rows created. */
  imported: number;
  /** Existing dealer_leads matched by phone and reused. */
  reused: number;
  /** Reused leads that had a blank name/location filled from the file. */
  updated: number;
  /** Rows dropped — no valid phone, or an in-file duplicate phone. */
  invalid: number;
}

interface MappedRow {
  phone: string;
  name: string | null;
  city: string | null;
  state: string | null;
  language: string | null;
  shop_name: string | null;
}

function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Map one raw sheet row to canonical fields + a normalized phone (or null).
function mapRow(row: Record<string, unknown>): {
  phone: string | null;
  fields: Partial<Record<CanonField, string>>;
} {
  const fields: Partial<Record<CanonField, string>> = {};
  let phoneRaw: string | null = null;
  for (const [rawKey, rawVal] of Object.entries(row)) {
    const canon = HEADER_ALIASES[normalizeHeader(rawKey)];
    if (!canon) continue;
    const val = rawVal == null ? "" : String(rawVal).trim();
    if (!val) continue;
    if (canon === "phone") {
      if (!phoneRaw) phoneRaw = val;
    } else if (fields[canon] == null) {
      fields[canon] = val;
    }
  }
  return { phone: phoneRaw ? normalizePhone(phoneRaw) : null, fields };
}

export async function importListRows(
  rows: Record<string, unknown>[],
  opts?: {
    listName?: string;
    /** ID 81 — Found via for the new leads. Defaults to the calling-list origin. */
    origin?: LeadOrigin | null;
    /** Who uploaded the list (null for a system context). */
    actorId?: string | null;
  },
): Promise<ListImportResult> {
  const capped = rows.slice(0, MAX_LIST_ROWS);
  const total = capped.length;

  // 1. Map + normalize; dedupe within the file (keep the first occurrence).
  const seen = new Set<string>();
  const mapped: MappedRow[] = [];
  let invalid = 0;
  for (const r of capped) {
    const { phone, fields } = mapRow(r);
    if (!phone) {
      invalid++;
      continue;
    }
    if (seen.has(phone)) {
      invalid++; // collapse in-file duplicate to its first row
      continue;
    }
    seen.add(phone);
    mapped.push({
      phone,
      name: fields.name ?? null,
      city: fields.city ?? null,
      state: fields.state ?? null,
      language: fields.language ?? null,
      shop_name: fields.shop_name ?? null,
    });
  }

  if (mapped.length === 0) {
    return { queueIds: [], total, imported: 0, reused: 0, updated: 0, invalid };
  }

  const phones = mapped.map((m) => m.phone);

  // 2. Which phones already exist? Those leads are reused, not re-inserted.
  //    The shared check matches on the last 10 digits: dealer_leads.phone is
  //    stored both bare and +91-prefixed, and the exact compare this replaced
  //    missed every lead in the other format and inserted a second copy.
  const existingByPhone = await loadExistingByPhone(phones);

  // 3. Insert new leads as AI-dialable. Chunked to stay within bind limits.
  const toInsert = mapped.filter((m) => !existingByPhone.has(m.phone));
  const insertedIds: string[] = [];
  const CHUNK = 500;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const slice = toInsert.slice(i, i + CHUNK);
    const values = slice.map((m) => {
      const city = normalizeCity(m.city ?? undefined) ?? m.city ?? null;
      const state =
        normalizeState(m.state ?? undefined) ??
        inferStateFromCity(city) ??
        null;
      return {
        id: `DL-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
        dealer_name: m.name,
        phone: m.phone,
        shop_name: m.shop_name,
        location: city,
        state,
        city,
        language: m.language || "hindi",
        current_status: "new",
        source: "manual_upload_lead",
        // lead_status / ai_recall_status intentionally left NULL → dialable.
        total_attempts: 0,
        is_active: true,
        memory: { list_import: true, list_name: opts?.listName ?? null },
      };
    });
    const insertedRows = await db
      .insert(dealerLeads)
      .values(values)
      .onConflictDoNothing({ target: dealerLeads.phone })
      .returning({ id: dealerLeads.id });
    insertedIds.push(...insertedRows.map((r) => r.id));
  }
  const imported = insertedIds.length;

  // 3a. ID 81 — source and "Lead created" on the new leads. Entered via is
  //     already set by the insert trigger (memory.list_import); best-effort.
  const actorId = opts?.actorId ?? null;
  const origin = opts?.origin ?? LIST_DEFAULT_ORIGIN;
  const campaignId =
    insertedIds.length > 0 && opts?.listName
      ? await campaignForDialerList({ listName: opts.listName, origin, createdBy: actorId })
      : null;
  await stampLeadSourceBulk(insertedIds, { door: "ai_dialer", origin, campaignId });
  await recordLeadsCreatedBulk(insertedIds, { door: "ai_dialer", actorId });

  // 3b. Reused leads: fill what is BLANK on the lead from the file, never
  //     replace what is there. A re-uploaded phone that exists as a bare row
  //     still gets its name (so the campaign UI does not fall back to
  //     "Lead N"), but a name or city someone has since corrected stays.
  //     The state is filled only alongside the sheet's city — a lead that
  //     already sits in another city must not get the sheet city's state.
  const reusedRows = mapped.filter((m) => existingByPhone.has(m.phone));
  let updated = 0;
  if (reusedRows.length > 0) {
    const fills = reusedRows.map((m) => {
      const city = normalizeCity(m.city ?? undefined) ?? m.city ?? null;
      const state =
        normalizeState(m.state ?? undefined) ??
        inferStateFromCity(city) ??
        null;
      return {
        id: existingByPhone.get(m.phone)!.id,
        name: m.name,
        shop_name: m.shop_name,
        city,
        state,
      };
    });
    const filled = await db.execute<{ id: string }>(sql`
      UPDATE dealer_leads dl SET
          dealer_name = COALESCE(NULLIF(btrim(dl.dealer_name), ''), x.name),
          shop_name   = COALESCE(NULLIF(btrim(dl.shop_name), ''), x.shop_name),
          city        = COALESCE(NULLIF(btrim(dl.city), ''), x.city),
          location    = COALESCE(NULLIF(btrim(dl.location), ''), x.city),
          state       = CASE WHEN NULLIF(btrim(dl.city), '') IS NULL
                                   OR lower(btrim(dl.city)) = lower(x.city)
                                 THEN COALESCE(NULLIF(btrim(dl.state), ''), x.state)
                                 ELSE dl.state END
        FROM jsonb_to_recordset(${JSON.stringify(fills)}::jsonb)
             AS x(id text, name text, shop_name text, city text, state text)
       WHERE dl.id = x.id
         AND (   (NULLIF(btrim(dl.dealer_name), '') IS NULL AND x.name IS NOT NULL)
              OR (NULLIF(btrim(dl.shop_name), '') IS NULL AND x.shop_name IS NOT NULL)
              OR (NULLIF(btrim(dl.city), '') IS NULL AND x.city IS NOT NULL)
              OR (NULLIF(btrim(dl.state), '') IS NULL AND x.state IS NOT NULL
                  AND (NULLIF(btrim(dl.city), '') IS NULL OR lower(btrim(dl.city)) = lower(x.city))))
      RETURNING dl.id
    `);
    updated = filled.length;

    // ID 81 — a known dealer on a new list is a Re-inquiry on the lead we hold.
    await recordReinquiries(
      fills.map((f) => ({ id: f.id, note: opts?.listName ?? null })),
      { door: "ai_dialer", actorId },
    );
  }

  // 4. Re-resolve every phone → id. Covers reused leads, freshly inserted
  //    leads, and any that lost an insert race to onConflictDoNothing.
  const resolved = await loadExistingByPhone(phones);
  const idByPhone = new Map<string, string>();
  for (const [phone, lead] of resolved) idByPhone.set(phone, lead.id);

  // 5. Build queueIds in original (deduped) file order.
  const queueIds: string[] = [];
  for (const m of mapped) {
    const id = idByPhone.get(m.phone);
    if (id) queueIds.push(id);
  }

  return { queueIds, total, imported, reused: mapped.length - imported, updated, invalid };
}
