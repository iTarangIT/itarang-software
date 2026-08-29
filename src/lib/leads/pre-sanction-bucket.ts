/**
 * Step-4 pre-sanction document bucket — the ONE writer.
 *
 * `product_selections.pre_sanction_doc_urls` (E-208) is a ≤10-item jsonb list
 * `[{url,name,type,size}]` the dealer attaches on Step 4. It has three writers
 * that must agree on the shape, the cap and WHICH row they target:
 *   • the web card (PATCH /api/lead/[id]/pre-sanction-doc) — replaces the list,
 *   • the Step-4 / draft submits — carry the list on the row they insert,
 *   • the WhatsApp extra-documents step (./whatsapp/extra-docs-flow) — appends
 *     one file per inbound message, possibly BEFORE any selection row exists.
 *
 * The third writer is why this module exists. Before it, the only server-side
 * cap lived in the PATCH route and the only "no row yet" answer was
 * `persisted:false` — fine for a browser that holds the list in React state,
 * useless for a chat where each file is a separate request and the session
 * context is not a durable store. So the chat path creates the same
 * `admin_decision='draft'` row the web Save Draft creates, and
 * `submitStep4ProductSelection` (which deletes draft rows and inserts the
 * submitted one) re-reads the bucket from that draft before it does.
 */

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, productSelections } from "@/lib/db/schema";
import { generateId } from "@/lib/api-utils";

import {
  type BucketItem,
  PRE_SANCTION_MAX,
  coerceBucketItems,
  mergeBucketItems,
} from "./pre-sanction-bucket-rules";

export {
  type BucketItem,
  PRE_SANCTION_MAX,
  coerceBucketItems,
  mergeBucketItems,
} from "./pre-sanction-bucket-rules";

/** The bucket as it stands on the most-recent selection row (the submitted one, once frozen). */
export async function getPreSanctionBucket(
  leadId: string,
): Promise<{ selectionId: string | null; items: BucketItem[]; batterySerial: string | null }> {
  const [row] = await db
    .select({
      id: productSelections.id,
      docs: productSelections.pre_sanction_doc_urls,
      battery_serial: productSelections.battery_serial,
    })
    .from(productSelections)
    .where(eq(productSelections.lead_id, leadId))
    .orderBy(desc(productSelections.created_at))
    .limit(1);
  if (!row) return { selectionId: null, items: [], batterySerial: null };
  return {
    selectionId: row.id,
    items: coerceBucketItems(row.docs),
    batterySerial: row.battery_serial ?? null,
  };
}

/** Web PATCH semantics: the caller's list IS the bucket. Returns false when no row exists. */
export async function replacePreSanctionDocs(
  leadId: string,
  items: BucketItem[],
): Promise<boolean> {
  const { selectionId } = await getPreSanctionBucket(leadId);
  if (!selectionId) return false;
  await db
    .update(productSelections)
    .set({ pre_sanction_doc_urls: items.slice(0, PRE_SANCTION_MAX), updated_at: new Date() })
    .where(eq(productSelections.id, selectionId));
  return true;
}

/**
 * Append to the bucket. When the lead has no selection row and
 * `createDraftIfMissing` is set, a minimal draft row is created — the same
 * shape the web Save Draft writes (category/model_number/payment_mode from the
 * lead) — so the files survive until Step 4 is submitted.
 */
export async function appendPreSanctionDocs(
  leadId: string,
  incoming: BucketItem[],
  opts: { createDraftIfMissing?: boolean; submittedBy?: string | null } = {},
): Promise<{ items: BucketItem[]; persisted: boolean; dropped: number }> {
  const current = await getPreSanctionBucket(leadId);
  const merged = mergeBucketItems(current.items, coerceBucketItems(incoming));
  const now = new Date();

  if (current.selectionId) {
    await db
      .update(productSelections)
      .set({ pre_sanction_doc_urls: merged.items, updated_at: now })
      .where(eq(productSelections.id, current.selectionId));
    return { ...merged, persisted: true };
  }

  if (!opts.createDraftIfMissing) return { ...merged, persisted: false };

  const [lead] = await db
    .select({
      payment_method: leads.payment_method,
      product_category_id: leads.product_category_id,
      product_type_id: leads.product_type_id,
      uploader_id: leads.uploader_id,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return { ...merged, persisted: false };

  const paymentMode =
    String(lead.payment_method || "").toLowerCase() === "cash" ? "cash" : "finance";

  // One draft per lead — re-check under the draft filter so a racing second
  // file does not create a second draft row.
  const [existingDraft] = await db
    .select({ id: productSelections.id })
    .from(productSelections)
    .where(
      and(eq(productSelections.lead_id, leadId), eq(productSelections.admin_decision, "draft")),
    )
    .limit(1);
  if (existingDraft) {
    await db
      .update(productSelections)
      .set({ pre_sanction_doc_urls: merged.items, updated_at: now })
      .where(eq(productSelections.id, existingDraft.id));
    return { ...merged, persisted: true };
  }

  await db.insert(productSelections).values({
    id: await generateId("PS"),
    lead_id: leadId,
    paraphernalia: {},
    paraphernalia_lines: [],
    category: lead.product_category_id ?? null,
    model_number: lead.product_type_id ?? null,
    pre_sanction_doc_urls: merged.items,
    payment_mode: paymentMode,
    admin_decision: "draft",
    submitted_by: opts.submittedBy || lead.uploader_id,
    submitted_at: null,
    created_at: now,
    updated_at: now,
  });
  return { ...merged, persisted: true };
}
