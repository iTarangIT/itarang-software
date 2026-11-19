/**
 * E-392 — Battery Pool diagram 1, part 3: the sales head's customer KYC
 * document list (app_settings 'customer_kyc_documents') and the per-lead skips
 * (kyc_document_skips). Pure rules: ./customer-doc-rules.ts.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { appSettings, kycDocumentSkips, kycDocuments } from "@/lib/db/schema";

import {
  askedDocs,
  customerDocLabelFor,
  normalizeCustomerDocConfig,
  validateSkip,
  type CustomerDocConfig,
} from "./customer-doc-rules";

export * from "./customer-doc-rules";

const SETTINGS_KEY = "customer_kyc_documents";

export async function getCustomerDocConfig(): Promise<CustomerDocConfig> {
  try {
    const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, SETTINGS_KEY)).limit(1);
    return normalizeCustomerDocConfig(row?.value);
  } catch (err) {
    console.error("[customer-doc-config] read failed:", err);
    return normalizeCustomerDocConfig(null);
  }
}

export async function setCustomerDocConfig(raw: unknown): Promise<CustomerDocConfig> {
  const next = normalizeCustomerDocConfig(raw);
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ key: SETTINGS_KEY, value: next, updated_at: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: next, updated_at: now } });
  return next;
}

export interface DocSkip {
  docType: string;
  label: string;
  reason: string;
  skippedBy: string | null;
  skippedByName: string | null;
  channel: string;
  skippedAt: string;
}

/** Open skips for a lead (customer documents). Empty on a DB without E-392. */
export async function listSkips(leadId: string, docFor = "customer"): Promise<DocSkip[]> {
  try {
    const rows = await db
      .select()
      .from(kycDocumentSkips)
      .where(and(eq(kycDocumentSkips.lead_id, leadId), eq(kycDocumentSkips.doc_for, docFor), isNull(kycDocumentSkips.cleared_at)));
    return rows.map((r) => ({
      docType: r.doc_type,
      label: customerDocLabelFor(r.doc_type),
      reason: r.reason,
      skippedBy: r.skipped_by,
      skippedByName: r.skipped_by_name,
      channel: r.channel,
      skippedAt: r.skipped_at.toISOString(),
    }));
  } catch {
    return [];
  }
}

/** Throws Error(message) for a mandatory doc / missing reason. Replaces an open skip of the same doc. */
export async function recordSkip(opts: {
  leadId: string;
  docType: string;
  reason: string | null | undefined;
  actor: { id: string | null; name: string | null };
  channel: "web" | "whatsapp";
  docFor?: string;
}): Promise<DocSkip> {
  const v = validateSkip(opts.docType, opts.reason);
  if (!v.ok) throw new Error(v.message);
  const docFor = opts.docFor ?? "customer";
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(kycDocumentSkips)
      .set({ cleared_at: now })
      .where(
        and(
          eq(kycDocumentSkips.lead_id, opts.leadId),
          eq(kycDocumentSkips.doc_for, docFor),
          eq(kycDocumentSkips.doc_type, opts.docType),
          isNull(kycDocumentSkips.cleared_at),
        ),
      );
    await tx.insert(kycDocumentSkips).values({
      lead_id: opts.leadId,
      doc_for: docFor,
      doc_type: opts.docType,
      reason: v.reason,
      skipped_by: opts.actor.id,
      skipped_by_name: opts.actor.name,
      channel: opts.channel,
      skipped_at: now,
    });
  });
  try {
    const { recordKycEvent } = await import("./kycEventLog");
    await recordKycEvent({
      leadId: opts.leadId,
      action: `Skipped ${customerDocLabelFor(opts.docType)}: ${v.reason}`,
      actor: { id: opts.actor.id, name: opts.actor.name, role: null, channel: opts.channel },
      detail: { doc_type: opts.docType, reason: v.reason },
      notify: false,
    });
  } catch {
    /* timeline is best-effort */
  }
  return {
    docType: opts.docType,
    label: customerDocLabelFor(opts.docType),
    reason: v.reason,
    skippedBy: opts.actor.id,
    skippedByName: opts.actor.name,
    channel: opts.channel,
    skippedAt: now.toISOString(),
  };
}

/** A document was uploaded (or the skip was undone): close its open skip. Never throws. */
export async function clearSkip(leadId: string, docType: string, docFor = "customer"): Promise<void> {
  try {
    await db
      .update(kycDocumentSkips)
      .set({ cleared_at: new Date() })
      .where(
        and(
          eq(kycDocumentSkips.lead_id, leadId),
          eq(kycDocumentSkips.doc_for, docFor),
          eq(kycDocumentSkips.doc_type, docType),
          isNull(kycDocumentSkips.cleared_at),
        ),
      );
  } catch {
    /* DB without E-392 */
  }
}

/** Asked / uploaded / skipped / outstanding for a lead (customer documents). */
export async function leadDocStatus(leadId: string) {
  const [config, skips, docs] = await Promise.all([
    getCustomerDocConfig(),
    listSkips(leadId),
    db
      .select({ doc_type: kycDocuments.doc_type, file_url: kycDocuments.file_url, doc_for: kycDocuments.doc_for })
      .from(kycDocuments)
      .where(eq(kycDocuments.lead_id, leadId)),
  ]);
  const asked = askedDocs(config);
  const uploaded = docs
    .filter((d) => (d.doc_for ?? "customer") !== "co_borrower" && d.doc_for !== "borrower" && !!d.file_url)
    .map((d) => d.doc_type);
  const skipped = skips.map((s) => s.docType);
  const { outstandingDocs } = await import("./customer-doc-rules");
  return { config, asked, uploaded, skips, outstanding: outstandingDocs({ asked, uploaded, skipped }) };
}
