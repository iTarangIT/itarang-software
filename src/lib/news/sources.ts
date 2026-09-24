/**
 * Green Energy News — where the items come from (E-306).
 *
 * Two kinds of source:
 *   rss    — a publisher's own feed (RSS 2.0 or Atom).
 *   gnews  — a Google News RSS *search*, one per topic the CEO asked for. The
 *            `when:2d` operator keeps each query to the last two days so the
 *            first fetch does not import a month of archive.
 *
 * Extra feeds / queries can be added at runtime through the `green_news`
 * app_settings row (see ./settings) — no deploy needed. Every URL here is
 * checked by scripts/verify-green-news.ts; a feed that stops answering is
 * logged per run and never fails the run (see ./run).
 */

import type { NewsRegion } from "./categories";
import type { GreenNewsSettings } from "./settings-core";

export type NewsSourceKind = "rss" | "gnews";

export type NewsSource = {
  /** Stable id stored on each item (≤ 40 chars). */
  key: string;
  /** Shown as the publisher when the feed does not carry one. */
  name: string;
  url: string;
  kind: NewsSourceKind;
  /** A hint for the classifier; Gemini still decides. */
  regionHint?: NewsRegion;
};

function gnews(key: string, name: string, query: string, regionHint?: NewsRegion): NewsSource {
  const q = encodeURIComponent(`${query} when:2d`);
  return {
    key,
    name,
    kind: "gnews",
    regionHint,
    url: `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`,
  };
}

export const DEFAULT_SOURCES: NewsSource[] = [
  // --- Google News topic searches -------------------------------------------
  gnews("gn_green_energy_india", "Google News", "green energy India", "india"),
  gnews("gn_renewable_policy_india", "Google News", "renewable energy policy subsidy India", "india"),
  gnews("gn_ev_battery_finance_india", "Google News", "EV battery financing India", "india"),
  gnews("gn_erickshaw_battery", "Google News", "e-rickshaw battery", "india"),
  gnews("gn_energy_storage_india", "Google News", "energy storage BESS India", "india"),
  gnews("gn_solar_india", "Google News", "solar power India", "india"),
  gnews("gn_green_investment", "Google News", "green energy investment funding", "world"),
  gnews("gn_renewable_world", "Google News", "renewable energy", "world"),
  gnews("gn_grid_distribution", "Google News", "power grid distribution renewable", "world"),

  // --- Publisher feeds --------------------------------------------------------
  { key: "mercom_india", name: "Mercom India", kind: "rss", regionHint: "india", url: "https://www.mercomindia.com/feed" },
  { key: "pv_magazine_india", name: "pv magazine India", kind: "rss", regionHint: "india", url: "https://www.pv-magazine-india.com/feed/" },
  { key: "et_energyworld_renewable", name: "ET EnergyWorld", kind: "rss", regionHint: "india", url: "https://energy.economictimes.indiatimes.com/rss/renewable" },
  { key: "pv_magazine_global", name: "pv magazine", kind: "rss", regionHint: "world", url: "https://www.pv-magazine.com/feed/" },
  { key: "cleantechnica", name: "CleanTechnica", kind: "rss", regionHint: "world", url: "https://cleantechnica.com/feed/" },
  { key: "electrek", name: "Electrek", kind: "rss", regionHint: "world", url: "https://electrek.co/feed/" },
];

/** Stable, ≤ 40-char key for a user-added source. */
function extraKey(prefix: string, i: number): string {
  return `${prefix}_${i + 1}`.slice(0, 40);
}

/** The default list plus whatever the settings row adds. */
export function resolveSources(settings: Pick<GreenNewsSettings, "extraFeeds" | "extraQueries">): NewsSource[] {
  const out = [...DEFAULT_SOURCES];
  settings.extraFeeds.forEach((url, i) => {
    if (!/^https?:\/\//i.test(url)) return;
    let name = "Feed";
    try {
      name = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return;
    }
    out.push({ key: extraKey("extra_feed", i), name, kind: "rss", url });
  });
  settings.extraQueries.forEach((q, i) => {
    if (!q.trim()) return;
    out.push(gnews(extraKey("extra_query", i), "Google News", q.trim()));
  });
  return out;
}
