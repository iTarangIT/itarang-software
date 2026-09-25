import { describe, expect, it } from "vitest";

import { parseFeedXml } from "../fetch";
import type { NewsSource } from "../sources";

const rssSource: NewsSource = { key: "t_rss", name: "Test RSS", kind: "rss", url: "https://x/feed" };
const gnewsSource: NewsSource = { key: "t_gn", name: "Google News", kind: "gnews", url: "https://x/rss" };

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Test</title>
  <item>
    <title>Tata Power wins 500 MW solar bid &amp; more</title>
    <link>https://example.com/story-1?utm_source=rss</link>
    <description><![CDATA[<p>Tata Power has <b>won</b> a 500 MW bid.</p>]]></description>
    <pubDate>Tue, 23 Sep 2026 10:15:00 +0530</pubDate>
    <media:content url="https://example.com/img1.jpg" medium="image"/>
  </item>
  <item>
    <title>No link item</title>
    <description>x</description>
  </item>
  <item>
    <title>Enclosure image</title>
    <link>https://example.com/story-2</link>
    <enclosure url="https://example.com/img2.png" type="image/png"/>
    <content:encoded><![CDATA[Body with <img src="https://example.com/inline.jpg"/> text]]></content:encoded>
  </item>
</channel>
</rss>`;

const GNEWS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>"green energy India" - Google News</title>
<item>
  <title>India adds 5 GW solar in Q2 - Mercom India</title>
  <link>https://news.google.com/rss/articles/CBMiabc?oc=5</link>
  <pubDate>Wed, 24 Sep 2026 03:00:00 GMT</pubDate>
  <description>&lt;a href="https://news.google.com/x"&gt;India adds 5 GW solar in Q2&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Mercom India&lt;/font&gt;</description>
  <source url="https://www.mercomindia.com">Mercom India</source>
</item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Test</title>
  <entry>
    <title>Grid storage tender opens</title>
    <link rel="alternate" href="https://example.org/tender"/>
    <link rel="enclosure" href="https://example.org/file.pdf"/>
    <summary type="html">&lt;p&gt;A 1 GWh tender.&lt;/p&gt;</summary>
    <published>2026-09-22T08:00:00Z</published>
  </entry>
</feed>`;

describe("parseFeedXml", () => {
  it("parses RSS 2.0 items, decodes entities, strips HTML, picks media image", () => {
    const out = parseFeedXml(RSS, rssSource);
    expect(out).toHaveLength(2); // the link-less item is dropped
    expect(out[0].title).toBe("Tata Power wins 500 MW solar bid & more");
    expect(out[0].link).toBe("https://example.com/story-1?utm_source=rss");
    expect(out[0].description).toBe("Tata Power has won a 500 MW bid.");
    expect(out[0].publishedAt?.toISOString()).toBe("2026-09-23T04:45:00.000Z");
    expect(out[0].imageUrl).toBe("https://example.com/img1.jpg");
    expect(out[0].publisher).toBeNull();
    expect(out[1].imageUrl).toBe("https://example.com/img2.png");
    expect(out[1].publishedAt).toBeNull();
  });

  it("splits Google News titles and reads the <source> publisher", () => {
    const out = parseFeedXml(GNEWS, gnewsSource);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("India adds 5 GW solar in Q2");
    expect(out[0].publisher).toBe("Mercom India");
    expect(out[0].link.startsWith("https://news.google.com/")).toBe(true);
  });

  it("parses Atom entries and prefers the alternate link", () => {
    const out = parseFeedXml(ATOM, rssSource);
    expect(out).toHaveLength(1);
    expect(out[0].link).toBe("https://example.org/tender");
    expect(out[0].description).toBe("A 1 GWh tender.");
    expect(out[0].publishedAt?.toISOString()).toBe("2026-09-22T08:00:00.000Z");
  });

  it("returns [] for non-feed bodies", () => {
    expect(parseFeedXml("<html><body>blocked</body></html>", rssSource)).toEqual([]);
    expect(parseFeedXml("garbage <<<", rssSource)).toEqual([]);
  });
});
