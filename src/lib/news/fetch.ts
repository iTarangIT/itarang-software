/**
 * Green Energy News — fetch one feed and normalise its entries (E-306).
 *
 * Handles RSS 2.0 (`rss.channel.item`) and Atom (`feed.entry`). Google News
 * RSS is RSS 2.0 with a `<source>` element naming the publisher and titles of
 * the form "Headline - Publisher".
 *
 * `parseFeedXml` is pure (unit tested with fixtures); `fetchFeed` wraps it
 * with a timed fetch. A feed that fails throws — the run catches per source.
 */

import { XMLParser } from "fast-xml-parser";

import type { NewsSource } from "./sources";
import { clip, splitGoogleTitle, stripHtml } from "./normalize";

export type FeedEntry = {
  title: string;
  link: string;
  description: string;
  publishedAt: Date | null;
  imageUrl: string | null;
  /** Publisher when the feed names one (Google News `<source>`, or the title suffix). */
  publisher: string | null;
};

const FETCH_TIMEOUT_MS = Number(process.env.GREEN_NEWS_FETCH_TIMEOUT_MS || 10_000);
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 iTarangNewsBot/1.0";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: false,
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
});

type Node = string | number | boolean | null | undefined | Node[] | { [k: string]: Node };

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Text of a node that may be a string, {#text}, or an array of those. */
function text(v: Node): string {
  if (v == null) return "";
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") return text((v as Record<string, Node>)["#text"]);
  return String(v);
}

function attr(v: Node, name: string): string {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return "";
  const a = (v as Record<string, Node>)[`@_${name}`];
  return a == null ? "" : String(a);
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function firstHttpsImage(...candidates: string[]): string | null {
  for (const c of candidates) {
    if (c && /^https:\/\//i.test(c)) return c;
  }
  return null;
}

/** Pull an image out of media:content / media:thumbnail / enclosure / an <img> in the body. */
function imageOf(item: Record<string, Node>, body: string): string | null {
  const media = asArray(item["media:content"] as Node[]).map((m) => attr(m, "url"));
  const thumb = asArray(item["media:thumbnail"] as Node[]).map((m) => attr(m, "url"));
  const enclosure = asArray(item["enclosure"] as Node[])
    .filter((e) => /^image\//i.test(attr(e, "type")) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(attr(e, "url")))
    .map((e) => attr(e, "url"));
  const inBody = body.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? "";
  return firstHttpsImage(...media, ...thumb, ...enclosure, inBody);
}

function rssEntry(item: Record<string, Node>, source: NewsSource): FeedEntry | null {
  const rawTitle = stripHtml(text(item.title));
  const link = text(item.link) || attr(item.link, "href") || text(item.guid);
  if (!rawTitle || !/^https?:\/\//i.test(link)) return null;

  const rawBody = text(item["content:encoded"]) || text(item.description) || "";
  const description = clip(stripHtml(rawBody), 600);
  const publishedAt = parseDate(text(item.pubDate) || text(item["dc:date"]) || text(item.published));

  let title = rawTitle;
  let publisher: string | null = text(item.source) || null;
  if (source.kind === "gnews") {
    const split = splitGoogleTitle(rawTitle);
    title = split.title;
    publisher = publisher || split.publisher;
  }

  return {
    title,
    link,
    description,
    publishedAt,
    imageUrl: imageOf(item, rawBody),
    publisher,
  };
}

function atomEntry(entry: Record<string, Node>): FeedEntry | null {
  const title = stripHtml(text(entry.title));
  const links = asArray(entry.link as Node[]);
  const alt =
    links.find((l) => attr(l, "rel") === "alternate" || !attr(l, "rel")) ?? links[0];
  const link = attr(alt, "href") || text(alt);
  if (!title || !/^https?:\/\//i.test(link)) return null;

  const rawBody = text(entry.content) || text(entry.summary) || "";
  const publishedAt = parseDate(text(entry.published) || text(entry.updated));
  return {
    title,
    link,
    description: clip(stripHtml(rawBody), 600),
    publishedAt,
    imageUrl: imageOf(entry, rawBody),
    publisher: text((entry.source as Record<string, Node> | undefined)?.title) || null,
  };
}

/** Pure: XML → entries. Unknown shapes return []. */
export function parseFeedXml(xml: string, source: NewsSource): FeedEntry[] {
  let doc: Record<string, Node>;
  try {
    doc = parser.parse(xml) as Record<string, Node>;
  } catch {
    return [];
  }

  const rss = doc.rss as Record<string, Node> | undefined;
  const channel = rss?.channel as Record<string, Node> | undefined;
  if (channel) {
    return asArray(channel.item as Node[])
      .map((it) => rssEntry(it as Record<string, Node>, source))
      .filter((e): e is FeedEntry => e !== null);
  }

  const feed = doc.feed as Record<string, Node> | undefined;
  if (feed) {
    return asArray(feed.entry as Node[])
      .map((it) => atomEntry(it as Record<string, Node>))
      .filter((e): e is FeedEntry => e !== null);
  }

  // RSS 1.0 (RDF) — rare; items sit at the root.
  const rdf = doc["rdf:RDF"] as Record<string, Node> | undefined;
  if (rdf) {
    return asArray(rdf.item as Node[])
      .map((it) => rssEntry(it as Record<string, Node>, source))
      .filter((e): e is FeedEntry => e !== null);
  }

  return [];
}

/** Fetch + parse one source. Throws on network / HTTP failure. */
export async function fetchFeed(source: NewsSource): Promise<FeedEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const entries = parseFeedXml(xml, source);
    if (entries.length === 0 && !/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) {
      throw new Error("not a feed");
    }
    return entries;
  } finally {
    clearTimeout(timer);
  }
}
