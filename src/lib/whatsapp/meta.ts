// Meta WhatsApp Cloud API adapter (design §10, §7.2).
//
// Implements WhatsAppAdapter against graph.facebook.com. Credentials:
//   META_WA_PHONE_NUMBER_ID   — the sending business number's id ("From" in API Setup)
//   META_WA_ACCESS_TOKEN      — PERMANENT System-User token (not the 24h setup token)
//   META_WA_APP_SECRET        — App Secret; verifies x-hub-signature-256 on inbound
//   META_WA_VERIFY_TOKEN      — GET-handshake token (you choose it; paste into Meta webhook config)
//   META_WA_GRAPH_VERSION     — optional, defaults to v21.0
//
// Escape hatch for local dev only: WHATSAPP_WEBHOOK_INSECURE=true skips signature
// verification. NEVER set this in sandbox/production.

import crypto from "crypto";

import type {
  DownloadedMedia,
  InboundEvent,
  ListRow,
  ReplyButton,
  SendResult,
  WhatsAppAdapter,
} from "./types";

const GRAPH_VERSION = process.env.META_WA_GRAPH_VERSION || "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function token(): string {
  return process.env.META_WA_ACCESS_TOKEN || "";
}

function phoneNumberId(): string {
  return process.env.META_WA_PHONE_NUMBER_ID || "";
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${token()}`,
    "Content-Type": "application/json",
  };
}

/** Strip everything but digits — Meta wants E.164 without the leading '+'. */
function normalizePhone(raw: string): string {
  return (raw || "").replace(/\D/g, "");
}

export class MetaWhatsAppAdapter implements WhatsAppAdapter {
  readonly provider = "meta";

  verifyInbound(headers: Headers, rawBody: string): boolean {
    if (process.env.WHATSAPP_WEBHOOK_INSECURE === "true") {
      console.warn(
        "[WhatsApp/meta] WHATSAPP_WEBHOOK_INSECURE=true — skipping signature verification (dev only)",
      );
      return true;
    }
    const appSecret = process.env.META_WA_APP_SECRET;
    if (!appSecret) {
      console.error(
        "[WhatsApp/meta] META_WA_APP_SECRET not set — rejecting inbound webhook",
      );
      return false;
    }
    const header = headers.get("x-hub-signature-256");
    if (!header || !header.startsWith("sha256=")) return false;
    const received = header.slice("sha256=".length);
    const expected = crypto
      .createHmac("sha256", appSecret)
      .update(rawBody, "utf8")
      .digest("hex");
    // Lengths must match before timingSafeEqual or it throws.
    if (received.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(
        Buffer.from(received, "hex"),
        Buffer.from(expected, "hex"),
      );
    } catch {
      return false;
    }
  }

  verifyChallenge(url: URL): string | null {
    const mode = url.searchParams.get("hub.mode");
    const verifyToken = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (
      mode === "subscribe" &&
      verifyToken &&
      verifyToken === process.env.META_WA_VERIFY_TOKEN
    ) {
      return challenge;
    }
    return null;
  }

  parseInbound(rawBody: string): InboundEvent[] {
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return [];
    }
    if (payload?.object !== "whatsapp_business_account") return [];

    const events: InboundEvent[] = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const contactName: string | undefined =
          value.contacts?.[0]?.profile?.name;

        // Delivery receipts (sent/delivered/read/failed).
        for (const status of value.statuses ?? []) {
          events.push({
            providerMessageId: status.id,
            waPhone: normalizePhone(status.recipient_id ?? ""),
            type: "status",
            deliveryStatus: status.status,
            raw: status,
          });
        }

        // Dealer messages.
        for (const msg of value.messages ?? []) {
          events.push(this.normalizeMessage(msg, contactName));
        }
      }
    }
    return events;
  }

  private normalizeMessage(msg: any, contactName?: string): InboundEvent {
    const base = {
      providerMessageId: msg.id,
      waPhone: normalizePhone(msg.from ?? ""),
      contactName,
      raw: msg,
    };

    switch (msg.type) {
      case "text":
        return { ...base, type: "text", text: msg.text?.body ?? "" };
      case "image":
        return {
          ...base,
          type: "image",
          text: msg.image?.caption,
          mediaProviderId: msg.image?.id,
          mimeType: msg.image?.mime_type,
        };
      case "document":
        return {
          ...base,
          type: "document",
          text: msg.document?.caption,
          mediaProviderId: msg.document?.id,
          mimeType: msg.document?.mime_type,
          fileName: msg.document?.filename,
        };
      case "audio":
        return {
          ...base,
          type: "audio",
          mediaProviderId: msg.audio?.id,
          mimeType: msg.audio?.mime_type,
        };
      case "interactive": {
        // Button/list reply — surface the chosen id as `text` so the
        // orchestrator handles taps and typed replies the same way.
        const reply =
          msg.interactive?.button_reply ?? msg.interactive?.list_reply;
        return {
          ...base,
          type: "interactive",
          text: reply?.id ?? reply?.title ?? "",
        };
      }
      case "button":
        // A tap on a TEMPLATE quick-reply button. Meta delivers this as its own
        // top-level type with `button.payload`, NOT wrapped in an `interactive`
        // envelope — so without this case every template CTA fell through to
        // `unsupported` and was discarded. Normalising to "interactive" means
        // the payload lands in `text` and every existing id-matching handler
        // works on it unchanged.
        return {
          ...base,
          type: "interactive",
          text: msg.button?.payload ?? msg.button?.text ?? "",
        };
      default:
        return { ...base, type: "unsupported", text: msg.type };
    }
  }

  async downloadMedia(mediaProviderId: string): Promise<DownloadedMedia> {
    // Step 1: resolve the media id → a short-lived download URL + mime.
    const metaRes = await fetch(`${GRAPH_BASE}/${mediaProviderId}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (!metaRes.ok) {
      throw new Error(
        `[WhatsApp/meta] media metadata fetch failed: HTTP ${metaRes.status}`,
      );
    }
    const meta = await metaRes.json();
    const url: string = meta.url;
    const mimeType: string = meta.mime_type ?? "application/octet-stream";

    // Step 2: download the bytes (still requires the Bearer token).
    const fileRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (!fileRes.ok) {
      throw new Error(
        `[WhatsApp/meta] media download failed: HTTP ${fileRes.status}`,
      );
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    return { buffer, mimeType };
  }

  private async send(body: Record<string, unknown>): Promise<SendResult> {
    if (!token() || !phoneNumberId()) {
      return {
        ok: false,
        providerMessageId: null,
        error: "meta_credentials_missing",
      };
    }
    try {
      const res = await fetch(`${GRAPH_BASE}/${phoneNumberId()}/messages`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
      });
      const data = await res.json().catch(() => ({}));
      const providerMessageId: string | null =
        data?.messages?.[0]?.id ?? null;
      if (!res.ok) {
        const error =
          data?.error?.message ?? `HTTP ${res.status}`;
        console.error("[WhatsApp/meta] send failed:", error);
        return { ok: false, providerMessageId, error, raw: data };
      }
      return { ok: true, providerMessageId, raw: data };
    } catch (err) {
      const error = err instanceof Error ? err.message : "network_error";
      console.error("[WhatsApp/meta] send error:", error);
      return { ok: false, providerMessageId: null, error };
    }
  }

  sendText(to: string, body: string): Promise<SendResult> {
    return this.send({
      to: normalizePhone(to),
      type: "text",
      text: { preview_url: false, body },
    });
  }

  sendTemplate(
    to: string,
    name: string,
    languageCode: string,
    bodyParams: string[],
  ): Promise<SendResult> {
    const components =
      bodyParams.length > 0
        ? [
            {
              type: "body",
              parameters: bodyParams.map((text) => ({ type: "text", text })),
            },
          ]
        : [];
    return this.send({
      to: normalizePhone(to),
      type: "template",
      template: {
        name,
        language: { code: languageCode },
        ...(components.length ? { components } : {}),
      },
    });
  }

  /**
   * [E-234] Template with an image header. See the interface doc-block for why
   * this cannot be folded into `sendTemplate`.
   *
   * The upload is best-effort: if Meta rejects the media we send the template
   * WITHOUT the header component rather than failing the whole message. That
   * is only correct when the template's header is optional at Meta's end — if
   * it is not, Meta rejects the send and the caller sees `ok: false`, which is
   * the same outcome as not trying. Never worse, sometimes better.
   */
  async sendTemplateWithImageHeader(
    to: string,
    name: string,
    languageCode: string,
    bodyParams: string[],
    image?: { bytes: Buffer; mimeType: string; filename: string } | null,
  ): Promise<SendResult> {
    let mediaId: string | null = null;
    if (image?.bytes?.length) {
      const up = await this.uploadMedia(image.bytes, image.mimeType, image.filename);
      mediaId = up.id;
      if (!up.id) {
        console.warn(
          `[WhatsApp/meta] template "${name}": image header dropped (${up.error ?? "upload failed"})`,
        );
      }
    }

    const components: Record<string, unknown>[] = [];
    if (mediaId) {
      components.push({
        type: "header",
        parameters: [{ type: "image", image: { id: mediaId } }],
      });
    }
    if (bodyParams.length > 0) {
      components.push({
        type: "body",
        parameters: bodyParams.map((text) => ({ type: "text", text })),
      });
    }

    return this.send({
      to: normalizePhone(to),
      type: "template",
      template: {
        name,
        language: { code: languageCode },
        ...(components.length ? { components } : {}),
      },
    });
  }

  sendDocument(
    to: string,
    link: string,
    filename: string,
    caption?: string,
  ): Promise<SendResult> {
    return this.send({
      to: normalizePhone(to),
      type: "document",
      document: {
        link,
        filename,
        ...(caption ? { caption } : {}),
      },
    });
  }

  /** Upload raw bytes to the resumable-less media endpoint; returns the media id. */
  private async uploadMedia(
    bytes: Buffer,
    mimeType: string,
    filename: string,
  ): Promise<{ id: string | null; error?: string }> {
    if (!token() || !phoneNumberId()) {
      return { id: null, error: "meta_credentials_missing" };
    }
    try {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", mimeType);
      // Buffer is a Uint8Array — wrap in a Blob so fetch sends multipart/form-data.
      form.append("file", new Blob([bytes], { type: mimeType }), filename);
      const res = await fetch(`${GRAPH_BASE}/${phoneNumberId()}/media`, {
        method: "POST",
        // Do NOT set Content-Type — fetch adds the multipart boundary itself.
        headers: { Authorization: `Bearer ${token()}` },
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = data?.error?.message ?? `HTTP ${res.status}`;
        console.error("[WhatsApp/meta] media upload failed:", error);
        return { id: null, error };
      }
      return { id: data?.id ?? null };
    } catch (err) {
      const error = err instanceof Error ? err.message : "network_error";
      console.error("[WhatsApp/meta] media upload error:", error);
      return { id: null, error };
    }
  }

  async sendDocumentBytes(
    to: string,
    bytes: Buffer,
    mimeType: string,
    filename: string,
    caption?: string,
  ): Promise<SendResult> {
    const up = await this.uploadMedia(bytes, mimeType, filename);
    if (!up.id) {
      return {
        ok: false,
        providerMessageId: null,
        error: up.error ?? "media_upload_failed",
      };
    }
    return this.send({
      to: normalizePhone(to),
      type: "document",
      document: {
        id: up.id,
        filename,
        ...(caption ? { caption } : {}),
      },
    });
  }

  sendInteractive(
    to: string,
    body: string,
    buttons: ReplyButton[],
  ): Promise<SendResult> {
    return this.send({
      to: normalizePhone(to),
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          // WhatsApp allows ≤3 reply buttons; titles ≤20 chars.
          buttons: buttons.slice(0, 3).map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    });
  }

  sendList(
    to: string,
    body: string,
    button: string,
    rows: ListRow[],
  ): Promise<SendResult> {
    return this.send({
      to: normalizePhone(to),
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: {
          // List opener label ≤20 chars; ≤10 rows total; titles ≤24, desc ≤72.
          button: button.slice(0, 20),
          sections: [
            {
              rows: rows.slice(0, 10).map((r) => ({
                id: r.id,
                title: r.title.slice(0, 24),
                ...(r.description
                  ? { description: r.description.slice(0, 72) }
                  : {}),
              })),
            },
          ],
        },
      },
    });
  }
}
