/**
 * A WhatsAppAdapter that sends nothing and remembers everything.
 *
 * WHY THIS EXISTS. The journey is a state machine whose transitions are driven
 * by inbound messages and whose output is outbound messages. Verifying it end to
 * end means driving `runTurn` for real — real session rows, real service calls,
 * real database writes — while the only thing that must NOT be real is the leg
 * that talks to Meta. Without this, testing the flow requires a tunnel, an
 * approved template set and a phone on Meta's test list, which is why the four
 * phases shipped with no automated coverage at all.
 *
 * It is also useful by hand: `WA_DRY_RUN=1 npm run dev` lets you click through
 * the whole journey from the CRM with the bot's replies going to the console
 * instead of a phone.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not simulate Meta's validation.
 * Button/row caps, the 24-hour window and template approval are enforced
 * elsewhere (`meta.ts` truncates, `outbound.ts` parks, `templates.ts` gates), and
 * a dry run that silently accepted an 11-row list would hide exactly the bug the
 * real adapter would surface. It records what it was asked to send, verbatim, and
 * lets the assertions decide.
 */

import crypto from "crypto";

import type {
  DownloadedMedia,
  InboundEvent,
  ListRow,
  ReplyButton,
  SendResult,
  WhatsAppAdapter,
} from "./types";

export interface DryRunSend {
  kind: "text" | "template" | "template_image" | "document" | "interactive" | "list";
  to: string;
  body: string;
  buttons?: ReplyButton[];
  rows?: ListRow[];
  /** Template name, for the template kinds. */
  template?: string;
  params?: string[];
  at: Date;
}

/** Everything this process has "sent", oldest first. */
const SENT: DryRunSend[] = [];

export function dryRunSends(): readonly DryRunSend[] {
  return SENT;
}
export function dryRunLast(): DryRunSend | undefined {
  return SENT[SENT.length - 1];
}
export function dryRunClear(): void {
  SENT.length = 0;
}

/**
 * Per-process id prefix.
 *
 * `whatsapp_messages.provider_message_id` is UNIQUE — it is the webhook's
 * idempotency key. A bare counter restarts at 1 on every run, so the SECOND run
 * of a verification script died on a duplicate-key error partway through the
 * journey. The outbound log is real even when the send is not, so these ids have
 * to be as unique as Meta's are.
 */
const RUN_ID = crypto.randomUUID().slice(0, 8);

/** A 1×1 transparent PNG — the smallest thing that is still a real image. */
const FIXTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let counter = 0;
function record(send: Omit<DryRunSend, "at">): SendResult {
  SENT.push({ ...send, at: new Date() });
  counter += 1;
  if (process.env.WA_DRY_RUN_LOG === "1") {
    const suffix = send.rows
      ? `\n   rows: ${send.rows.map((r) => `${r.id}=${r.title}`).join(" | ")}`
      : send.buttons
        ? `\n   buttons: ${send.buttons.map((b) => `${b.id}=${b.title}`).join(" | ")}`
        : "";
    console.log(`\n[WA→${send.to}] (${send.kind})\n${send.body}${suffix}`);
  }
  return { providerMessageId: `dryrun-${RUN_ID}-${counter}`, ok: true };
}

export class DryRunWhatsAppAdapter implements WhatsAppAdapter {
  readonly provider = "dry-run";

  // Inbound is synthesised by the caller, not parsed from a webhook body.
  verifyInbound(): boolean {
    return true;
  }
  verifyChallenge(url: URL): string | null {
    return url.searchParams.get("hub.challenge");
  }
  parseInbound(rawBody: string): InboundEvent[] {
    try {
      const parsed = JSON.parse(rawBody);
      return Array.isArray(parsed) ? (parsed as InboundEvent[]) : [];
    } catch {
      return [];
    }
  }
  async downloadMedia(): Promise<DownloadedMedia> {
    // Document ingest is out of scope for a dry run: it needs real bytes and a
    // real Gemini call. Failing loudly beats returning an empty buffer that
    // silently classifies as an unreadable document.
    //
    // WA_DRY_RUN_MEDIA_FIXTURE=1 is the one exception: the Step-4 extra-
    // documents bucket stores bytes verbatim with no extraction, so a tiny PNG
    // exercises its whole save → append → notify path for real.
    if (process.env.WA_DRY_RUN_MEDIA_FIXTURE === "1") {
      return { buffer: FIXTURE_PNG, mimeType: "image/png", fileName: "fixture.png" };
    }
    throw new Error("[WA dry-run] downloadMedia is not available without a provider");
  }

  async sendText(to: string, body: string): Promise<SendResult> {
    return record({ kind: "text", to, body });
  }
  async sendTemplate(
    to: string,
    name: string,
    _languageCode: string,
    bodyParams: string[],
  ): Promise<SendResult> {
    return record({
      kind: "template",
      to,
      body: `[template ${name}] ${bodyParams.join(" | ")}`,
      template: name,
      params: bodyParams,
    });
  }
  async sendTemplateWithImageHeader(
    to: string,
    name: string,
    _languageCode: string,
    bodyParams: string[],
  ): Promise<SendResult> {
    return record({
      kind: "template_image",
      to,
      body: `[template ${name} +image] ${bodyParams.join(" | ")}`,
      template: name,
      params: bodyParams,
    });
  }
  async sendDocument(
    to: string,
    link: string,
    filename: string,
    caption?: string,
  ): Promise<SendResult> {
    return record({ kind: "document", to, body: `${filename} (${link}) ${caption ?? ""}` });
  }
  async sendDocumentBytes(
    to: string,
    bytes: Buffer,
    _mimeType: string,
    filename: string,
    caption?: string,
  ): Promise<SendResult> {
    return record({
      kind: "document",
      to,
      body: `${filename} (${bytes.length} bytes) ${caption ?? ""}`,
    });
  }
  async sendInteractive(
    to: string,
    body: string,
    buttons: ReplyButton[],
  ): Promise<SendResult> {
    return record({ kind: "interactive", to, body, buttons });
  }
  async sendList(
    to: string,
    body: string,
    _button: string,
    rows: ListRow[],
  ): Promise<SendResult> {
    return record({ kind: "list", to, body, rows });
  }
}
