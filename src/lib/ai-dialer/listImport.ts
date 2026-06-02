// Excel/CSV → dealer_leads import for List-based dialer campaigns.
//
// Deterministic (no LLM): map columns via a small alias map, normalize phones
// with the shared E.164 helper, dedupe within the file, REUSE any existing
// dealer_leads row by phone (phone is UNIQUE — we never create a duplicate),
// and bulk-insert the rest as AI-dialable leads. New leads are written with
// lead_status = NULL / ai_recall_status = NULL so the exclusion filter
// (src/lib/ai-dialer/exclusionFilter.ts) lets advanceCampaign dial them.
//
// Returns the campaign queue (dealer_leads.id) in original file order plus an
// import summary the create route surfaces to the user.

import crypto from "crypto";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { normalizePhone } from "@/lib/admin/csvUpload";
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
  opts?: { listName?: string },
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
    return { queueIds: [], total, imported: 0, reused: 0, invalid };
  }

  const phones = mapped.map((m) => m.phone);

  // 2. Which phones already exist? Those leads are reused, not re-inserted.
  const existingRows = (await db
    .select({ id: dealerLeads.id, phone: dealerLeads.phone })
    .from(dealerLeads)
    .where(inArray(dealerLeads.phone, phones))) as {
    id: string;
    phone: string | null;
  }[];
  const existingPhones = new Set(
    existingRows.map((e) => e.phone).filter((p): p is string => !!p),
  );

  // 3. Insert new leads as AI-dialable. Chunked to stay within bind limits.
  const toInsert = mapped.filter((m) => !existingPhones.has(m.phone));
  let imported = 0;
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
    imported += insertedRows.length;
  }

  // 4. Re-resolve every phone → id. Covers reused leads, freshly inserted
  //    leads, and any that lost an insert race to onConflictDoNothing.
  const resolvedRows = (await db
    .select({ id: dealerLeads.id, phone: dealerLeads.phone })
    .from(dealerLeads)
    .where(inArray(dealerLeads.phone, phones))) as {
    id: string;
    phone: string | null;
  }[];
  const idByPhone = new Map<string, string>();
  for (const r of resolvedRows) {
    if (r.phone) idByPhone.set(r.phone, r.id);
  }

  // 5. Build queueIds in original (deduped) file order.
  const queueIds: string[] = [];
  for (const m of mapped) {
    const id = idByPhone.get(m.phone);
    if (id) queueIds.push(id);
  }

  const reused = mapped.length - imported;
  return { queueIds, total, imported, reused, invalid };
}
