/**
 * The only place that names a concrete provider class. Services and tickers
 * call these getters and see only the interfaces (acceptance test 7).
 */
import { OpenLibProvider } from "./messaging/openlib.provider";
import type { MessagingProvider } from "./messaging/types";
import { UnipileProvider } from "./messaging/unipile.provider";
import { BrightDataProvider } from "./search/brightdata.provider";
import type { SearchProvider } from "./search/types";

export type { MessagingProvider } from "./messaging/types";
export type { SearchProvider } from "./search/types";
export { ProviderNotConfiguredError } from "./search/types";

let search: SearchProvider | null = null;
const messaging = new Map<string, MessagingProvider>();

export function searchProvider(): SearchProvider {
  return (search ??= new BrightDataProvider());
}

export function messagingProvider(name = "unipile"): MessagingProvider {
  let p = messaging.get(name);
  if (!p) {
    p = name === "openlib" ? new OpenLibProvider() : new UnipileProvider();
    messaging.set(name, p);
  }
  return p;
}

/** Tests only. */
export function setProvidersForTest(args: { search?: SearchProvider; messaging?: MessagingProvider }): void {
  if (args.search) search = args.search;
  if (args.messaging) messaging.set("unipile", args.messaging);
}
