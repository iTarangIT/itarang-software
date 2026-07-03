import { db } from "@/lib/db";
import { leadRegistry } from "@/lib/db/schema";

// E-179 central lead registry. Every place that FIRST captures a prospect —
// customer lead (web or WhatsApp), dealer onboarding application (web wizard
// or WhatsApp bot), NBFC onboarding, OEM — calls recordLeadCapture right after
// its own insert. The registry is reporting-only: a failed write must never
// break lead creation, so this logs and swallows all errors. The partial
// unique index on (source_table, source_id) makes repeat calls for the same
// originating row a no-op (onConflictDoNothing).

export type LeadRegistryEntry = {
  leadType: "dealer" | "customer" | "oem" | "nbfc";
  /** Person/company name as captured. Falls back to "Unknown" if empty. */
  name: string | null | undefined;
  phone?: string | null;
  sourceChannel: "web" | "whatsapp" | "admin" | "scraper";
  /** Originating table + row id, e.g. ('leads', lead.id). Powers idempotency. */
  sourceTable: string;
  sourceId: string | number;
};

export async function recordLeadCapture(entry: LeadRegistryEntry): Promise<void> {
  try {
    await db
      .insert(leadRegistry)
      .values({
        leadType: entry.leadType,
        name: entry.name?.trim() || "Unknown",
        phone: entry.phone?.trim() || null,
        sourceChannel: entry.sourceChannel,
        sourceTable: entry.sourceTable,
        sourceId: String(entry.sourceId),
      })
      .onConflictDoNothing();
  } catch (error) {
    console.error("[Lead Registry] capture failed (non-fatal):", error);
  }
}
