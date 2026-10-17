// Send a stored PDF over WhatsApp by uploading its BYTES (17 Oct, user: "without
// login no one should see anyone's document").
//
// Our files sit behind /api/files and /api/nbfc-uploads, which now open only
// for a signed-in user — a signed link with no login is no longer honoured.
// Meta fetches a document link with no login, so sending a link would hand it
// a login page. The bytes are read straight from storage (downloadPdfBuffer)
// and uploaded to Meta instead; Meta then hosts them under a media id.
//
// A link that is not one of our stored files (a provider's own URL, e.g.
// Digio) is still sent as a link when its bytes can't be read.

import { downloadPdfBuffer } from "@/lib/email/downloadPdfBuffer";
import { filesProxyTarget, nbfcUploadsTarget } from "@/lib/storage/fileAccess";

import type { SendResult, WhatsAppAdapter } from "./types";

export async function sendPdf(
  adapter: Pick<WhatsAppAdapter, "sendDocument" | "sendDocumentBytes">,
  to: string,
  url: string,
  filename: string,
  caption?: string,
): Promise<SendResult> {
  const bytes = await downloadPdfBuffer(url);
  if (bytes) return adapter.sendDocumentBytes(to, bytes, "application/pdf", filename, caption);
  if (filesProxyTarget(url) || nbfcUploadsTarget(url) || !/^https?:\/\//i.test(url)) {
    return { ok: false, providerMessageId: null, error: "document_unreadable" };
  }
  return adapter.sendDocument(to, url, filename, caption);
}
