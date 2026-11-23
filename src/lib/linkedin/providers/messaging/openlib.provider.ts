/**
 * Placeholder for an unofficial TS LinkedIn client (plan D4). Not built: the
 * team chose Unipile (D5). Kept so a future spike can drop a client in here
 * without touching anything outside providers/.
 */
import { ProviderNotConfiguredError } from "../search/types";
import type { MessagingProvider } from "./types";

const notBuilt = (): never => {
  throw new ProviderNotConfiguredError("The open-library LinkedIn provider is not built; use Unipile.");
};

export class OpenLibProvider implements MessagingProvider {
  readonly name = "openlib";
  resolveProfile = notBuilt;
  sendInvite = notBuilt;
  sendMessage = notBuilt;
  listConversations = notBuilt;
  getConversation = notBuilt;
  connectionState = notBuilt;
  listConnections = notBuilt;
  accountHealth = notBuilt;
  connectLink = notBuilt;
}
