// ID 166 decision 5 (kept 18 Oct, confirmed 23 Oct): a returning dealer that
// confirms its mobile by code — or opens the correction link iTarang sent it —
// gets fresh links to ITS OWN earlier uploads, for that one application, each
// valid 15 minutes. Server only (reads the db).

import { and, eq, ne } from "drizzle-orm";

import { db } from "@/lib/db";
import { dealerOnboardingDocuments } from "@/lib/db/schema";
import { filesProxyTarget, onboardingFileLink } from "@/lib/storage/fileAccess";

/** bucket/key identity of a stored URL, ignoring any query string. */
function fileIdentity(url: string | null | undefined): string | null {
  if (!url) return null;
  const t = filesProxyTarget(url);
  return t ? `${t.bucket}/${t.key}` : null;
}

async function applicationDocumentUrls(applicationId: string): Promise<string[]> {
  const rows = await db
    .select({ fileUrl: dealerOnboardingDocuments.file_url })
    .from(dealerOnboardingDocuments)
    .where(
      and(
        eq(dealerOnboardingDocuments.application_id, applicationId),
        ne(dealerOnboardingDocuments.doc_status, "superseded"),
      ),
    );
  return rows.map((r) => r.fileUrl).filter((u): u is string => !!u);
}

/**
 * Fresh 15-minute links to every current document of the application, keyed
 * by the stored URL (the form matches them on its `uploadedUrl`).
 */
export async function onboardingDocumentLinks(applicationId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const url of await applicationDocumentUrls(applicationId)) {
    const link = onboardingFileLink(url, applicationId);
    if (link) out[url] = link;
  }
  return out;
}

/**
 * A fresh link to `url` if it is one of the application's documents (any
 * state, superseded included — a correction shows the file being replaced);
 * else null. The URL may arrive already signed; only bucket/key count.
 */
export async function onboardingFileLinkFor(applicationId: string, url: string): Promise<string | null> {
  const want = fileIdentity(url);
  if (!want) return null;
  const rows = await db
    .select({ fileUrl: dealerOnboardingDocuments.file_url })
    .from(dealerOnboardingDocuments)
    .where(eq(dealerOnboardingDocuments.application_id, applicationId));
  const match = rows.find((r) => fileIdentity(r.fileUrl) === want);
  return match?.fileUrl ? onboardingFileLink(match.fileUrl, applicationId) : null;
}
