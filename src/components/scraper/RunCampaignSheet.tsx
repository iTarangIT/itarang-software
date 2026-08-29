"use client";

// The confirm step behind "Run Campaign" on a scrape-run detail page.
//
// A small dedicated sheet rather than a reuse of DialerStartModal: that modal is
// ~700 lines of region tree, saved groups and an Excel Lists tab, has no prop to
// pre-seed a region, and deliberately does not reset its region between opens.
// Bending it to "one fixed set of cities, confirm" would mean a new prop, a new
// mode and a new reset branch, all to hide most of its own UI.
//
// The one thing this sheet must communicate clearly is the scope: the campaign
// targets EVERY dialable lead in the run's cities, not the leads that run
// produced. On a page headed "80 new leads saved" that is genuinely surprising —
// the verified example run saved 80 and produces a 145-lead campaign.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CampaignWindowPicker,
  INITIAL_SCHEDULE,
  isScheduleInvalid,
  toSchedulePayload,
  useScheduleDefaults,
  type CampaignScheduleValue,
} from "@/components/leads/campaign-window-picker";
import { Loader2, MapPin, Phone, X } from "lucide-react";

type RunCity = {
  raw: string;
  state: string | null;
  city: string;
  resolved: boolean;
};

type CampaignPreview = {
  runId: string;
  cities: RunCity[];
  unresolvedRaw: string[];
  citySource: "chunks" | "scraped_leads" | "none";
  preview: {
    counts: { hot: number; warm: number; cold: number; all: number };
    excluded: { total: number; byReason: Record<string, number> };
    totalWithPhone: number;
    aiConnectedCount: number;
    queueIds: string[];
  } | null;
  canRun: boolean;
  reason: "no_city_data" | "no_dialable_leads" | null;
};

const PROVIDERS = [
  { key: "bolna" as const, label: "Bolna" },
  { key: "elevenlabs" as const, label: "ElevenLabs" },
];

const EXCLUDED_REASON_LABEL: Record<string, string> = {
  already_ai_connected: "already reached by AI",
  already_queued: "already in a queue",
  converted: "converted",
  not_interested: "not interested",
  dnc: "on do-not-call",
  blacklisted: "blacklisted",
};

// Observed connect rate: 83 of 298 placed calls produced a transcript. Used only
// to size the burn-down warning, so a rough figure is the honest one — it is
// labelled "about" in the copy.
const OBSERVED_CONNECT_RATE = 0.28;

export function RunCampaignSheet({
  runId,
  isOpen,
  onClose,
  onStarted,
}: {
  runId: string;
  isOpen: boolean;
  onClose: () => void;
  onStarted: (campaignId: string) => void;
}) {
  const [provider, setProvider] = useState<"bolna" | "elevenlabs">("bolna");
  const [starting, setStarting] = useState(false);
  // E-254 — the calling window for the campaign this run kicks off.
  const [schedule, setSchedule] =
    useState<CampaignScheduleValue>(INITIAL_SCHEDULE);
  useScheduleDefaults(setSchedule);
  const [error, setError] = useState<string | null>(null);

  // No reset-on-open effect: the host mounts this only while the sheet is open,
  // so every open gets fresh state for free. A `setState` inside an effect keyed
  // on `isOpen` would do the same job while tripping react-hooks/set-state-in-effect
  // and re-rendering twice.
  const { data, isLoading } = useQuery<CampaignPreview | null>({
    queryKey: ["run-campaign-preview", runId],
    enabled: isOpen,
    staleTime: 0,
    queryFn: async () => {
      const res = await fetch(`/api/scraper/runs/${runId}/campaign-preview`);
      const json = await res.json();
      return json?.success ? (json.data as CampaignPreview) : null;
    },
  });

  if (!isOpen) return null;

  const counts = data?.preview?.counts;
  const excluded = data?.preview?.excluded;
  const dialable = counts?.all ?? 0;
  const burnDown = Math.round(dialable * OBSERVED_CONNECT_RATE);

  async function start() {
    if (isScheduleInvalid(schedule)) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`/api/scraper/runs/${runId}/campaign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          schedule: toSchedulePayload(schedule),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setError(json?.error ?? "Could not start the campaign.");
        setStarting(false);
        return;
      }
      onStarted(json.data.campaignId);
    } catch {
      setError("Could not reach the server. Please try again.");
      setStarting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-gray-100 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              Run AI campaign
            </h2>
            <p className="mt-0.5 font-mono text-[11px] text-gray-500">{runId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
          {isLoading ? (
            <p className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Working out who this would call…
            </p>
          ) : !data ? (
            <p className="text-sm text-gray-500">
              Could not load the campaign preview for this run.
            </p>
          ) : data.reason === "no_city_data" ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
              <p className="font-medium text-gray-800">
                No city was recorded for this run.
              </p>
              <p className="mt-1 leading-relaxed">
                City tracking was added after this run finished, so there is
                nothing to scope a campaign to. Start one from{" "}
                <span className="font-medium">Leads → Campaigns</span> and pick
                the region there.
              </p>
            </div>
          ) : (
            <>
              <div className="mb-4">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                  Cities
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {data.cities.map((c) => (
                    <span
                      key={`${c.state}:${c.city}`}
                      className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-700"
                    >
                      <MapPin className="h-3 w-3 text-gray-400" />
                      {c.state ? `${c.state} › ${c.city}` : c.city}
                    </span>
                  ))}
                  {data.unresolvedRaw.map((raw) => (
                    <span
                      key={raw}
                      title="We could not match this to a known city, so it is not being targeted."
                      className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-700 line-through"
                    >
                      {raw}
                    </span>
                  ))}
                </div>
              </div>

              {/* The scope warning. Not decoration — see the file header. */}
              <div className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] leading-relaxed text-sky-900">
                This dials <strong>all dialable leads in these cities</strong> —
                not only the leads this run produced.
              </div>

              <div className="mb-4 rounded-lg border border-gray-200 p-4">
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold tabular-nums text-gray-900">
                    {dialable}
                  </span>
                  <span className="text-sm text-gray-500">
                    dealers will be called
                  </span>
                </div>

                {counts && dialable > 0 && (
                  <p className="mt-1 text-[11px] tabular-nums text-gray-500">
                    Hot {counts.hot} · Warm {counts.warm} · Cold {counts.cold}
                  </p>
                )}

                {excluded && excluded.total > 0 && (
                  <p className="mt-2 border-t border-gray-100 pt-2 text-[11px] leading-relaxed text-gray-500">
                    <span className="font-medium text-gray-600">
                      {excluded.total} not called:
                    </span>{" "}
                    {Object.entries(excluded.byReason)
                      .filter(([, n]) => n > 0)
                      .map(
                        ([reason, n]) =>
                          `${n} ${EXCLUDED_REASON_LABEL[reason] ?? reason.replace(/_/g, " ")}`,
                      )
                      .join(" · ")}
                  </p>
                )}
              </div>

              {/* The number nobody is shown anywhere else, and the most
                  consequential thing about pressing this button: the AI-eligible
                  pool only ever shrinks, and the scraper is the sole inflow. */}
              {dialable > 0 && (
                <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
                  About <strong>{burnDown}</strong> of these will be reached and
                  become permanently ineligible for future AI campaigns. The AI
                  never calls the same dealer twice.
                </div>
              )}

              {data.reason === "no_dialable_leads" && (
                <div className="mb-4 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] leading-relaxed text-gray-600">
                  There is nothing left for the AI to call here. The breakdown
                  above is the whole story — these dealers need manual follow-up.
                </div>
              )}

              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                  Voice agent
                </p>
                <div className="flex gap-2">
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => setProvider(p.key)}
                      className={`rounded-lg border px-3 py-2 text-sm ${
                        provider === p.key
                          ? "border-emerald-500 bg-emerald-50 font-medium text-emerald-700"
                          : "border-gray-200 text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {error && (
                <p className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        {/* E-254 — calling window for the campaign this run starts. */}
        <div className="border-t border-gray-100 px-6 py-4">
          <CampaignWindowPicker
            value={schedule}
            onChange={setSchedule}
            idPrefix="run-campaign"
            compact
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 bg-gray-50 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={start}
            disabled={
              isLoading ||
              starting ||
              !data?.canRun ||
              isScheduleInvalid(schedule)
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {starting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Phone className="h-3.5 w-3.5" />
            )}
            {data?.reason === "no_dialable_leads"
              ? "Nothing left to dial"
              : `Start campaign${dialable > 0 ? ` · ${dialable}` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
