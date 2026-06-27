// WhatsApp provider abstraction (design §10).
//
// The orchestrator depends ONLY on `WhatsAppAdapter` — never on a concrete
// provider. Meta Cloud API is the first implementation (`meta.ts`); Interakt /
// Gupshup can swap in later by adding an adapter and a `WHATSAPP_PROVIDER` case
// in `index.ts`, with zero changes to the conversation logic.

/** Canonical inbound event, normalized across providers. */
export interface InboundEvent {
  /** Provider's message id — the idempotency / dedupe key. */
  providerMessageId: string;
  /** Dealer phone in E.164 *without* the leading '+' (e.g. "919876543210"). */
  waPhone: string;
  /** WhatsApp profile name, when the provider sends it. */
  contactName?: string;
  /** 'status' = a delivery receipt (sent/delivered/read), not a dealer message. */
  type:
    | "text"
    | "image"
    | "document"
    | "audio"
    | "interactive"
    | "status"
    | "unsupported";
  /** Text body / caption / interactive-reply id, when present. */
  text?: string;
  /** Provider media handle — resolve to bytes via `downloadMedia()`. */
  mediaProviderId?: string;
  /** Media MIME type, when the provider includes it. */
  mimeType?: string;
  /** Original filename for documents, when present. */
  fileName?: string;
  /** Delivery status value when `type === 'status'`. */
  deliveryStatus?: string;
  /** Conversation/contact thread id, when the provider exposes one. */
  conversationId?: string;
  /** The raw provider object for this event, for logging/debugging. */
  raw: unknown;
}

export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
  /** Original filename if the provider supplies one. */
  fileName?: string;
}

export interface SendResult {
  /** Provider message id for the outbound message, when returned. */
  providerMessageId: string | null;
  ok: boolean;
  error?: string;
  raw?: unknown;
}

/** A reply button for an interactive message (e.g. CONFIRM / CHANGE). */
export interface ReplyButton {
  /** Stable id echoed back as `InboundEvent.text` when the dealer taps it. */
  id: string;
  /** Button label shown to the dealer (≤20 chars per WhatsApp). */
  title: string;
}

/** A row in an interactive List message (e.g. the dealer console menu). */
export interface ListRow {
  /** Stable id echoed back as `InboundEvent.text` when the dealer taps it. */
  id: string;
  /** Row title shown to the dealer (≤24 chars per WhatsApp). */
  title: string;
  /** Optional secondary line under the title (≤72 chars). */
  description?: string;
}

export interface WhatsAppAdapter {
  /** Provider key, e.g. 'meta'. */
  readonly provider: string;

  /**
   * Verify an inbound webhook is authentic (HMAC / shared secret).
   * `rawBody` MUST be the exact bytes received — parse only AFTER this passes.
   */
  verifyInbound(headers: Headers, rawBody: string): boolean;

  /** GET webhook subscription handshake. Returns the challenge to echo, or null to reject. */
  verifyChallenge(url: URL): string | null;

  /** Normalize a raw webhook body into zero or more canonical events. */
  parseInbound(rawBody: string): InboundEvent[];

  /** Resolve a provider media handle to bytes. */
  downloadMedia(mediaProviderId: string): Promise<DownloadedMedia>;

  /** Free-form text — valid only inside the 24h customer-service window. */
  sendText(to: string, body: string): Promise<SendResult>;

  /** Pre-approved template — required to message a dealer outside the 24h window. */
  sendTemplate(
    to: string,
    name: string,
    languageCode: string,
    bodyParams: string[],
  ): Promise<SendResult>;

  /**
   * Send a document (PDF etc.) by public URL — the provider fetches `link`
   * itself. Valid only inside the 24h customer-service window (like sendText).
   */
  sendDocument(
    to: string,
    link: string,
    filename: string,
    caption?: string,
  ): Promise<SendResult>;

  /**
   * Send a document by uploading its BYTES to the provider first, then sending
   * by the returned media id. Use this when the file has no publicly-reachable
   * URL (local dev, or auth-gated storage like the S3 files proxy) — the
   * provider hosts the bytes, so it never needs to fetch our server.
   */
  sendDocumentBytes(
    to: string,
    bytes: Buffer,
    mimeType: string,
    filename: string,
    caption?: string,
  ): Promise<SendResult>;

  /** Interactive reply buttons (e.g. CONFIRM / CHANGE). */
  sendInteractive(
    to: string,
    body: string,
    buttons: ReplyButton[],
  ): Promise<SendResult>;

  /**
   * Interactive single-section List — used when more than 3 choices are needed
   * (reply buttons cap at 3). `button` is the label on the list-opener (≤20
   * chars); each tapped row echoes its `id` back as `InboundEvent.text`.
   */
  sendList(
    to: string,
    body: string,
    button: string,
    rows: ListRow[],
  ): Promise<SendResult>;
}
