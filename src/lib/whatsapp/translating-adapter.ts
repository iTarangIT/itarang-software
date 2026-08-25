/**
 * The language choke point.
 *
 * Wraps the real provider adapter and translates every free-form outbound
 * message (text, interactive buttons, lists, document captions) into the
 * language chosen at /admin/settings/whatsapp/language. Nothing above this
 * layer — reply()/replyList(), notifications, dispatch OTP sends, parked-prompt
 * replays — knows the setting exists, which is the point: ~330 inline English
 * call sites stay exactly as they are.
 *
 * What is NOT translated, on purpose:
 * - `sendTemplate*` — Meta templates are pre-approved per language; the copy is
 *   Meta's, not ours. Hindi templates need their own approval cycle (see
 *   templates.ts `lang`).
 * - Button / row `id`s — the flows switch on these; only `title` /
 *   `description` are localised.
 * - Anything when the setting is `english` — a pure pass-through with no
 *   Gemini call and no cache lookup.
 *
 * Note for the admin console: `whatsapp_messages.text_body` is written by
 * reply()/replyList() BEFORE this layer, so the log keeps the English source
 * the code produced, not the translated text the customer saw.
 */

import type { WhatsAppLanguage } from "./language";
import type { BatchTranslator, TranslationItem } from "./translate-core";
import type {
  DownloadedMedia,
  InboundEvent,
  ListRow,
  ReplyButton,
  SendResult,
  WhatsAppAdapter,
} from "./types";

export type LanguageResolver = () => Promise<WhatsAppLanguage>;

export class TranslatingWhatsAppAdapter implements WhatsAppAdapter {
  /** Reports the wrapped provider — callers checking `adapter.provider` see "meta". */
  readonly provider: WhatsAppAdapter["provider"];

  constructor(
    private readonly inner: WhatsAppAdapter,
    // Both injected (not defaulted) so this file stays free of DB imports and
    // unit-testable; index.ts wires the real ones.
    private readonly resolveLanguage: LanguageResolver,
    private readonly translate: BatchTranslator,
  ) {
    this.provider = inner.provider;
  }

  // --- pass-throughs -------------------------------------------------------

  verifyInbound(headers: Headers, rawBody: string): boolean {
    return this.inner.verifyInbound(headers, rawBody);
  }
  verifyChallenge(url: URL): string | null {
    return this.inner.verifyChallenge(url);
  }
  parseInbound(rawBody: string): InboundEvent[] {
    return this.inner.parseInbound(rawBody);
  }
  downloadMedia(mediaProviderId: string): Promise<DownloadedMedia> {
    return this.inner.downloadMedia(mediaProviderId);
  }
  sendTemplate(
    to: string,
    name: string,
    languageCode: string,
    bodyParams: string[],
  ): Promise<SendResult> {
    return this.inner.sendTemplate(to, name, languageCode, bodyParams);
  }
  sendTemplateWithImageHeader(
    to: string,
    name: string,
    languageCode: string,
    bodyParams: string[],
    image?: { bytes: Buffer; mimeType: string; filename: string } | null,
  ): Promise<SendResult> {
    return this.inner.sendTemplateWithImageHeader(
      to,
      name,
      languageCode,
      bodyParams,
      image,
    );
  }

  // --- translated sends ----------------------------------------------------

  async sendText(to: string, body: string): Promise<SendResult> {
    const [t] = await this.localise([{ text: body, kind: "body" }]);
    return this.inner.sendText(to, t);
  }

  async sendDocument(
    to: string,
    link: string,
    filename: string,
    caption?: string,
  ): Promise<SendResult> {
    const c = await this.caption(caption);
    return this.inner.sendDocument(to, link, filename, c);
  }

  async sendDocumentBytes(
    to: string,
    bytes: Buffer,
    mimeType: string,
    filename: string,
    caption?: string,
  ): Promise<SendResult> {
    const c = await this.caption(caption);
    return this.inner.sendDocumentBytes(to, bytes, mimeType, filename, c);
  }

  async sendInteractive(
    to: string,
    body: string,
    buttons: ReplyButton[],
  ): Promise<SendResult> {
    const out = await this.localise([
      { text: body, kind: "body" },
      ...buttons.map((b) => ({ text: b.title, kind: "button" as const })),
    ]);
    const [tBody, ...titles] = out;
    const tButtons = buttons.map((b, i) => ({ ...b, title: titles[i] }));
    return this.inner.sendInteractive(to, tBody, tButtons);
  }

  async sendList(
    to: string,
    body: string,
    button: string,
    rows: ListRow[],
  ): Promise<SendResult> {
    const items: TranslationItem[] = [
      { text: body, kind: "body" },
      { text: button, kind: "list_button" },
    ];
    for (const r of rows) {
      items.push({ text: r.title, kind: "row_title" });
      items.push({ text: r.description ?? "", kind: "row_desc" });
    }
    const out = await this.localise(items);
    const [tBody, tButton] = out;
    const tRows = rows.map((r, i) => {
      const title = out[2 + i * 2];
      const desc = out[3 + i * 2];
      return {
        ...r,
        title,
        ...(r.description !== undefined ? { description: desc } : {}),
      };
    });
    return this.inner.sendList(to, tBody, tButton, tRows);
  }

  // --- helpers -------------------------------------------------------------

  private async caption(caption?: string): Promise<string | undefined> {
    if (caption === undefined) return undefined;
    const [c] = await this.localise([{ text: caption, kind: "caption" }]);
    return c;
  }

  /**
   * Translate one message's strings together. Any failure anywhere returns
   * the English inputs — a send must never be blocked by localisation.
   */
  private async localise(items: TranslationItem[]): Promise<string[]> {
    try {
      const lang = await this.resolveLanguage();
      if (lang === "english") return items.map((i) => i.text);
      return await this.translate(items, lang);
    } catch (err) {
      console.error("[WhatsApp/translating-adapter] falling back to English:", err);
      return items.map((i) => i.text);
    }
  }
}
