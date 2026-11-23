/**
 * MessagingProvider (doc §3.1). Only the send / poll tickers call this, and
 * the send ticker only after the approval check. Swapping the provider needs
 * no change outside providers/ (acceptance test 7).
 */

export type AttachmentRef = { fileName: string; contentType: string | null; data: Buffer };

export type ConnectionState = "none" | "pending" | "connected";
export type AccountHealth = "ok" | "challenge" | "restricted";

export type InviteResult = { ok: true; providerId: string } | { ok: false; error: string; health?: AccountHealth };
export type MessageResult =
  | { ok: true; chatId: string; messageId: string | null }
  | { ok: false; error: string; health?: AccountHealth };

export type Conversation = {
  chatId: string;
  attendeeProviderId: string | null;
  lastMessageAt: Date | null;
  unreadCount: number;
};

export type Message = {
  messageId: string;
  chatId: string;
  fromMe: boolean;
  text: string | null;
  attachmentName: string | null;
  sentAt: Date;
  seenAt: Date | null;
};

export type ResolvedProfile = { providerId: string; connection: ConnectionState };

export interface MessagingProvider {
  readonly name: string;
  /** Resolve a public profile slug to the provider's id + connection degree (spike S6). */
  resolveProfile(accountId: string, profileId: string): Promise<ResolvedProfile>;
  sendInvite(accountId: string, providerId: string, note?: string): Promise<InviteResult>;
  sendMessage(
    accountId: string,
    providerId: string,
    text: string,
    attachment?: AttachmentRef,
    chatId?: string | null,
  ): Promise<MessageResult>;
  listConversations(accountId: string, since: Date): Promise<Conversation[]>;
  getConversation(accountId: string, conversationId: string): Promise<Message[]>;
  connectionState(accountId: string, providerId: string): Promise<ConnectionState>;
  /** provider_ids of people who are now connections (acceptances), newest first. */
  listConnections(accountId: string, since: Date): Promise<string[]>;
  accountHealth(accountId: string): Promise<AccountHealth>;
  /** A hosted login link that connects a new LinkedIn account. */
  connectLink(args: { name: string; notifyUrl: string; successUrl: string }): Promise<string>;
}
