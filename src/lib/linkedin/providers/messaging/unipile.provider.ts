/**
 * Unipile REST (v1) — the LinkedIn messaging provider (plan D5).
 * Base https://{DSN}/api/v1, header X-API-KEY. Endpoints used:
 *
 *   GET  /users/{public_identifier}?account_id=   → provider_id, network_distance, invitation
 *   POST /users/invite {provider_id, account_id, message≤300}
 *   POST /chats (multipart) account_id, attendees_ids, text, attachments   → new chat (relations only)
 *   POST /chats/{chat_id}/messages (multipart) text, attachments
 *   GET  /chats?account_id=&after=                 → chats
 *   GET  /chats/{chat_id}/messages                 → messages
 *   GET  /users/relations?account_id=              → connections, newest first
 *   GET  /accounts/{id}                            → sources[].status
 *   POST /hosted/accounts/link                     → hosted login URL
 *
 * No LinkedIn session ever touches our DB: the account connects through
 * Unipile's hosted login and we keep only Unipile's account_id.
 */
import { getSecret } from "../../credentials";
import { ProviderNotConfiguredError } from "../search/types";
import type {
  AccountHealth,
  AttachmentRef,
  ConnectionState,
  Conversation,
  InviteResult,
  Message,
  MessageResult,
  MessagingProvider,
  ResolvedProfile,
} from "./types";

type Json = Record<string, unknown>;

export class UnipileError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly type: string | null,
  ) {
    super(message);
  }
}

/** Provider error → account health signal. Pure; exported for tests. */
export function healthFromError(httpStatus: number, type: string | null, detail = ""): AccountHealth | undefined {
  const t = `${type ?? ""} ${detail}`.toLowerCase();
  if (/disconnected|checkpoint|captcha|challenge|credentials|invalid_session|reconnect/.test(t)) return "challenge";
  if (httpStatus === 429 || /restrict|limit_exceeded|too_many|banned|suspended/.test(t)) return "restricted";
  if (httpStatus === 401) return "challenge";
  return undefined;
}

/** network_distance / invitation → our connection state. Pure; exported for tests. */
export function connectionFromProfile(p: Json): ConnectionState {
  const dist = String(p.network_distance ?? "").toUpperCase();
  if (dist === "FIRST_DEGREE" || dist === "DISTANCE_1" || p.is_relationship === true) return "connected";
  const inv = (p.invitation ?? null) as Json | null;
  if (inv && String(inv.status ?? inv.type ?? "").toUpperCase().match(/PENDING|SENT/)) return "pending";
  if (p.pending_invitation === true) return "pending";
  return "none";
}

const toDate = (v: unknown): Date | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";

export class UnipileProvider implements MessagingProvider {
  readonly name = "unipile";

  private async config(): Promise<{ base: string; key: string }> {
    const [dsn, key] = await Promise.all([getSecret("unipile:dsn"), getSecret("unipile:api_key")]);
    if (!dsn || !key) throw new ProviderNotConfiguredError("Unipile DSN / API key not configured (LinkedIn › Accounts).");
    const host = dsn.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\/api\/v1$/, "");
    return { base: `https://${host}/api/v1`, key };
  }

  async apiUrl(): Promise<string> {
    return (await this.config()).base.replace(/\/api\/v1$/, "");
  }

  private async call(path: string, init: RequestInit = {}): Promise<Json> {
    const { base, key } = await this.config();
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "X-API-KEY": key, accept: "application/json", ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(45_000),
    });
    const text = await res.text();
    let body: Json = {};
    try {
      body = text ? (JSON.parse(text) as Json) : {};
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    if (!res.ok) {
      const type = typeof body.type === "string" ? body.type : null;
      const detail = String(body.detail ?? body.title ?? body.message ?? body.raw ?? "");
      throw new UnipileError(`Unipile ${res.status} ${type ?? ""} ${detail}`.trim(), res.status, type);
    }
    return body;
  }

  private fail(err: unknown): { ok: false; error: string; health?: AccountHealth } {
    if (err instanceof UnipileError) {
      return { ok: false, error: err.message, health: healthFromError(err.httpStatus, err.type, err.message) };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  async resolveProfile(accountId: string, profileId: string): Promise<ResolvedProfile> {
    const p = await this.call(`/users/${encodeURIComponent(profileId)}?account_id=${encodeURIComponent(accountId)}`);
    const providerId = typeof p.provider_id === "string" ? p.provider_id : null;
    if (!providerId) throw new Error(`Unipile returned no provider_id for ${profileId}`);
    return { providerId, connection: connectionFromProfile(p) };
  }

  async connectionState(accountId: string, providerId: string): Promise<ConnectionState> {
    const p = await this.call(`/users/${encodeURIComponent(providerId)}?account_id=${encodeURIComponent(accountId)}`);
    return connectionFromProfile(p);
  }

  async sendInvite(accountId: string, providerId: string, note?: string): Promise<InviteResult> {
    try {
      const body: Json = { provider_id: providerId, account_id: accountId };
      if (note?.trim()) body.message = note.trim().slice(0, 300);
      await this.call("/users/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { ok: true, providerId };
    } catch (err) {
      return this.fail(err);
    }
  }

  async sendMessage(
    accountId: string,
    providerId: string,
    text: string,
    attachment?: AttachmentRef,
    chatId?: string | null,
  ): Promise<MessageResult> {
    try {
      const form = new FormData();
      form.set("text", text);
      if (attachment) {
        form.append(
          "attachments",
          new Blob([new Uint8Array(attachment.data)], { type: attachment.contentType ?? "application/octet-stream" }),
          attachment.fileName,
        );
      }
      let body: Json;
      if (chatId) {
        body = await this.call(`/chats/${encodeURIComponent(chatId)}/messages`, { method: "POST", body: form });
        return { ok: true, chatId, messageId: typeof body.message_id === "string" ? body.message_id : null };
      }
      form.set("account_id", accountId);
      form.set("attendees_ids", providerId);
      body = await this.call("/chats", { method: "POST", body: form });
      const newChat = typeof body.chat_id === "string" ? body.chat_id : typeof body.id === "string" ? body.id : null;
      if (!newChat) return { ok: false, error: "Unipile returned no chat_id" };
      return { ok: true, chatId: newChat, messageId: typeof body.message_id === "string" ? body.message_id : null };
    } catch (err) {
      return this.fail(err);
    }
  }

  async listConversations(accountId: string, since: Date): Promise<Conversation[]> {
    const qs = new URLSearchParams({ account_id: accountId, after: since.toISOString(), limit: "100" });
    const body = await this.call(`/chats?${qs}`);
    const items = Array.isArray(body.items) ? (body.items as Json[]) : [];
    return items.map((c) => ({
      chatId: String(c.id),
      attendeeProviderId: typeof c.attendee_provider_id === "string" ? c.attendee_provider_id : null,
      lastMessageAt: toDate(c.timestamp),
      unreadCount: Number(c.unread_count ?? 0) || 0,
    }));
  }

  async getConversation(_accountId: string, conversationId: string): Promise<Message[]> {
    const body = await this.call(`/chats/${encodeURIComponent(conversationId)}/messages?limit=100`);
    const items = Array.isArray(body.items) ? (body.items as Json[]) : [];
    return items
      .map((m): Message | null => {
        const sentAt = toDate(m.timestamp);
        if (!sentAt || typeof m.id !== "string") return null;
        const atts = Array.isArray(m.attachments) ? (m.attachments as Json[]) : [];
        return {
          messageId: m.id,
          chatId: conversationId,
          fromMe: truthy(m.is_sender),
          text: typeof m.text === "string" ? m.text : null,
          attachmentName: atts.length ? String(atts[0].file_name ?? atts[0].name ?? "attachment") : null,
          sentAt,
          seenAt: truthy(m.seen) ? (toDate(m.seen_at) ?? sentAt) : null,
        };
      })
      .filter((m): m is Message => m !== null)
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  }

  async listConnections(accountId: string, since: Date): Promise<string[]> {
    const body = await this.call(`/users/relations?account_id=${encodeURIComponent(accountId)}&limit=100`);
    const items = Array.isArray(body.items) ? (body.items as Json[]) : [];
    return items
      .filter((r) => {
        const at = toDate(r.created_at);
        return !at || at >= since;
      })
      .map((r) => String(r.member_id ?? r.provider_id ?? ""))
      .filter(Boolean);
  }

  async accountHealth(accountId: string): Promise<AccountHealth> {
    try {
      const body = await this.call(`/accounts/${encodeURIComponent(accountId)}`);
      const sources = Array.isArray(body.sources) ? (body.sources as Json[]) : [];
      const status = String(sources[0]?.status ?? "OK").toUpperCase();
      if (status === "OK" || status === "CONNECTING" || status === "SYNC_SUCCESS") return "ok";
      if (status === "CREDENTIALS" || status === "ERROR" || status === "STOPPED") return "challenge";
      return "restricted";
    } catch (err) {
      if (err instanceof UnipileError) return healthFromError(err.httpStatus, err.type, err.message) ?? "challenge";
      throw err;
    }
  }

  async connectLink(args: { name: string; notifyUrl: string; successUrl: string }): Promise<string> {
    const apiUrl = await this.apiUrl();
    const body = await this.call("/hosted/accounts/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "create",
        providers: ["LINKEDIN"],
        api_url: apiUrl,
        expiresOn: new Date(Date.now() + 60 * 60_000).toISOString(),
        notify_url: args.notifyUrl,
        success_redirect_url: args.successUrl,
        name: args.name,
      }),
    });
    if (typeof body.url !== "string") throw new Error("Unipile returned no hosted-auth URL");
    return body.url;
  }
}
