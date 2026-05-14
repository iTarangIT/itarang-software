// Human-friendly one-liner for a RegionSelection JSONB blob. Used by:
//   - src/lib/queue/campaignTracker.ts (campaign name generation)
//   - src/components/leads/campaigns-table.tsx (history table subtitle)
//   - src/components/leads/campaign-detail-view.tsx (detail-page chip)
//
// Shape matches RegionSelection from src/components/leads/region-selector.tsx:
//   { states: string[], cities: { state, city }[], pincodes: string[],
//     groupIds: string[], groupNames?: string[] }
// `groupNames` is optional — the server may snapshot it at start time so
// historical campaigns survive group renames; if missing, we fall back to a
// neutral "Saved group" placeholder.

export function summarizeRegion(region: unknown): string {
  if (!region || typeof region !== "object") return "All regions";
  const r = region as {
    states?: unknown;
    cities?: unknown;
    pincodes?: unknown;
    groupIds?: unknown;
    groupNames?: unknown;
  };

  const states = Array.isArray(r.states) ? (r.states as string[]) : [];
  const cities = Array.isArray(r.cities)
    ? (r.cities as { state?: string; city?: string }[])
    : [];
  const pincodes = Array.isArray(r.pincodes) ? (r.pincodes as string[]) : [];
  const groupNames = Array.isArray(r.groupNames)
    ? (r.groupNames as string[])
    : [];
  const groupIds = Array.isArray(r.groupIds) ? (r.groupIds as string[]) : [];

  const parts: string[] = [];

  if (groupNames.length > 0) {
    parts.push(
      groupNames.length === 1
        ? groupNames[0]
        : `${groupNames[0]} +${groupNames.length - 1} group${groupNames.length - 1 === 1 ? "" : "s"}`,
    );
  } else if (groupIds.length > 0) {
    parts.push(
      groupIds.length === 1 ? "Saved group" : `${groupIds.length} groups`,
    );
  }

  if (states.length > 0) {
    parts.push(
      states.length === 1
        ? states[0]
        : `${states[0]} +${states.length - 1}`,
    );
  }

  if (cities.length > 0) {
    const cityNames = cities.map((c) => c?.city).filter(Boolean) as string[];
    if (cityNames.length > 0) {
      parts.push(
        cityNames.length === 1
          ? cityNames[0]
          : `${cityNames[0]} +${cityNames.length - 1} cit${cityNames.length - 1 === 1 ? "y" : "ies"}`,
      );
    }
  }

  if (pincodes.length > 0) {
    parts.push(`${pincodes.length} pincode${pincodes.length === 1 ? "" : "s"}`);
  }

  return parts.length > 0 ? parts.join(" · ") : "All regions";
}

const CATEGORY_LABELS: Record<string, string> = {
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
  all: "All segments",
  scheduled: "Scheduled",
};

// Derive a campaign display title at read time, NOT from the frozen
// dialer_campaigns.name column. Older rows created before the region-shape
// fix have a stale name like "All segments · All regions" even though their
// region_filter JSONB has the right state/city data — compute it fresh.
export function displayCampaignName(opts: {
  category?: string | null;
  regionFilter?: unknown;
  startedAt?: string | Date | null;
}): string {
  const segment = opts.category
    ? (CATEGORY_LABELS[opts.category] ?? opts.category)
    : "All segments";
  const region = summarizeRegion(opts.regionFilter);
  const ts = (() => {
    if (!opts.startedAt) return "";
    const d =
      typeof opts.startedAt === "string"
        ? new Date(opts.startedAt)
        : opts.startedAt;
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  })();
  return ts ? `${segment} · ${region} · ${ts}` : `${segment} · ${region}`;
}

// Detailed view — used by the campaign detail page header to render the
// full state→cities breakdown instead of just a short summary.
export function describeRegion(region: unknown): string {
  if (!region || typeof region !== "object") return "All regions";
  const r = region as {
    states?: unknown;
    cities?: unknown;
    pincodes?: unknown;
    groupNames?: unknown;
    groupIds?: unknown;
  };

  const states = Array.isArray(r.states) ? (r.states as string[]) : [];
  const cities = Array.isArray(r.cities)
    ? (r.cities as { state?: string; city?: string }[])
    : [];
  const pincodes = Array.isArray(r.pincodes) ? (r.pincodes as string[]) : [];
  const groupNames = Array.isArray(r.groupNames)
    ? (r.groupNames as string[])
    : [];

  const segments: string[] = [];

  if (groupNames.length > 0) segments.push(`Groups: ${groupNames.join(", ")}`);
  if (states.length > 0) segments.push(`States: ${states.join(", ")}`);

  // Group cities by state for readability.
  if (cities.length > 0) {
    const byState = cities.reduce<Record<string, string[]>>((acc, c) => {
      const k = c.state ?? "—";
      if (!c.city) return acc;
      (acc[k] ??= []).push(c.city);
      return acc;
    }, {});
    const parts = Object.entries(byState).map(
      ([s, cs]) => `${s} (${cs.join(", ")})`,
    );
    if (parts.length > 0) segments.push(`Cities: ${parts.join("; ")}`);
  }

  if (pincodes.length > 0) {
    segments.push(`Pincodes: ${pincodes.join(", ")}`);
  }

  return segments.length > 0 ? segments.join(" · ") : "All regions";
}
