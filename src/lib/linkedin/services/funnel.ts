// Funnel roll-up for LinkedIn analytics (E-398). Pure; no DB import, so unit tests load it alone.

export type FunnelCounts = {
  selected: number;
  approached: number;
  invited: number;
  accepted: number;
  replied: number;
  meetings: number;
  positive: number;
};

export type CampaignFunnel = FunnelCounts & {
  campaign_id: string;
  name: string;
  status: string;
  category: string;
  account_id: string;
  created_at: string;
};

export type CategoryFunnel = FunnelCounts & { category: string; campaigns: number };

const KEYS = ["selected", "approached", "invited", "accepted", "replied", "meetings", "positive"] as const;

/** Campaign rows → one row per category (+ a total). Pure; exported for tests. */
export function rollUp(campaigns: CampaignFunnel[]): { categories: CategoryFunnel[]; total: CategoryFunnel } {
  const by = new Map<string, CategoryFunnel>();
  const blank = (category: string): CategoryFunnel => ({
    category,
    campaigns: 0,
    selected: 0,
    approached: 0,
    invited: 0,
    accepted: 0,
    replied: 0,
    meetings: 0,
    positive: 0,
  });
  const total = blank("All categories");
  for (const c of campaigns) {
    const row = by.get(c.category) ?? blank(c.category);
    row.campaigns++;
    total.campaigns++;
    for (const k of KEYS) {
      row[k] += c[k];
      total[k] += c[k];
    }
    by.set(c.category, row);
  }
  const categories = [...by.values()].sort((a, b) => b.approached - a.approached || a.category.localeCompare(b.category));
  return { categories, total };
}

/** % of approached, one decimal; null when nothing was approached. Pure. */
export function pctOf(n: number, approached: number): number | null {
  return approached > 0 ? Math.round((n / approached) * 1000) / 10 : null;
}
