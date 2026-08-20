"use client";

// E-254 — the calling-window control for AI dialer campaigns.
//
// One component, three mount points: the region flow (DialerStartModal), the
// list-upload flow (ListsTab) and the scraper flow (RunCampaignSheet). All
// three can start a campaign, so all three must be able to schedule one — and
// a picker per surface is three places for the vocabulary to drift.
//
// Field shape, weekday chips and both warnings are lifted from
// src/components/scraper/BatchScrapeForm.tsx:451-545, which is the same idea
// for the scraper queue. Reusing its look means an operator who has scheduled a
// scrape already knows how to schedule a campaign.
//
// The component is CONTROLLED and owns no defaults of its own: the parent holds
// the value and seeds it from /api/ai-dialer/schedule-defaults. That keeps the
// "where do the 09:00-19:00 defaults come from" question in exactly one place
// (assignment_config, E-120) rather than hard-coded here as well.

import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Clock } from "lucide-react";
import type { ScheduleMode, Weekday } from "@/lib/queue/campaignSchedule";

export interface CampaignScheduleValue {
  mode: ScheduleMode;
  window_start: string;
  window_end: string;
  window_days: Weekday[];
}

const DAY_CHIPS: Array<{ key: Weekday; label: string }> = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];

const MODES: Array<{ key: ScheduleMode; label: string; hint: string }> = [
  {
    key: "now",
    label: "Call now",
    hint: "Dial continuously until every lead is done, whatever the time.",
  },
  {
    key: "single",
    label: "Single run",
    hint: "Dial inside the window today, then pause. You resume it when you want.",
  },
  {
    key: "recurring",
    label: "Recurring",
    hint: "Dial inside the window every selected day, resuming automatically until the list is finished.",
  },
];

/** The payload shape POST /api/ai-dialer/start (and the other two start routes)
 *  expect under the top-level `schedule` key. Null for an unscheduled campaign
 *  so the request body stays identical to what those routes used to receive. */
export function toSchedulePayload(v: CampaignScheduleValue) {
  if (v.mode === "now") return null;
  return {
    mode: v.mode,
    window_start: v.window_start,
    window_end: v.window_end,
    // Weekdays only mean something for a repeating campaign. Sending them for a
    // single run would have the server store a recurrence the campaign will
    // never act on.
    window_days: v.mode === "recurring" ? v.window_days : null,
  };
}

/** True when the current value would be rejected by campaignScheduleSchema.
 *  Parents use this to disable their submit button, so the user is stopped at
 *  the form rather than by a 400. */
export function isScheduleInvalid(v: CampaignScheduleValue): boolean {
  if (v.mode === "now") return false;
  if (!v.window_start || !v.window_end) return true;
  if (v.window_start === v.window_end) return true;
  if (v.mode === "recurring" && v.window_days.length === 0) return true;
  return false;
}

export function CampaignWindowPicker({
  value,
  onChange,
  idPrefix = "campaign-window",
  compact = false,
}: {
  value: CampaignScheduleValue;
  onChange: (v: CampaignScheduleValue) => void;
  /** Radio groups need a unique `name` per mounted instance, otherwise two
   *  pickers on the same page (e.g. two draft rows in the Lists tab) share one
   *  selection and clicking either moves both. */
  idPrefix?: string;
  compact?: boolean;
}) {
  const set = (patch: Partial<CampaignScheduleValue>) =>
    onChange({ ...value, ...patch });

  const toggleDay = (d: Weekday) =>
    set({
      window_days: value.window_days.includes(d)
        ? value.window_days.filter((x) => x !== d)
        : [...value.window_days, d],
    });

  const overnight =
    value.window_end < value.window_start &&
    value.window_end !== value.window_start;
  const equal =
    Boolean(value.window_start) && value.window_start === value.window_end;
  const noDays = value.mode === "recurring" && value.window_days.length === 0;

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
        <Clock className="w-3.5 h-3.5" />
        Calling window
        <span className="font-normal text-gray-400">all times IST</span>
      </div>

      <div className="flex flex-wrap gap-4 text-sm">
        {MODES.map((m) => (
          <label
            key={m.key}
            className="flex items-center gap-1.5 cursor-pointer"
            title={m.hint}
          >
            <input
              type="radio"
              name={`${idPrefix}-mode`}
              checked={value.mode === m.key}
              onChange={() => set({ mode: m.key })}
              className="w-3.5 h-3.5 text-teal-600 focus:ring-teal-500"
            />
            <span className="text-gray-700">{m.label}</span>
          </label>
        ))}
      </div>

      <p className="text-[11px] text-gray-500">
        {MODES.find((m) => m.key === value.mode)?.hint}
      </p>

      {value.mode !== "now" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <input
              type="time"
              aria-label="Window start"
              value={value.window_start}
              onChange={(e) => set({ window_start: e.target.value })}
              className="px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
            <span className="text-gray-400">to</span>
            <input
              type="time"
              aria-label="Window end"
              value={value.window_end}
              onChange={(e) => set({ window_end: e.target.value })}
              className="px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>

          {value.mode === "recurring" && (
            <div className="flex flex-wrap gap-1">
              {DAY_CHIPS.map((d) => {
                const on = value.window_days.includes(d.key);
                return (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => toggleDay(d.key)}
                    className={`px-2.5 py-1 text-xs rounded-md border ${
                      on
                        ? "bg-teal-600 text-white border-teal-600"
                        : "bg-white text-gray-500 border-gray-200"
                    }`}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          )}

          <p className="text-[11px] text-gray-500">
            No call is placed outside this window. A call already in progress
            when it closes is allowed to finish.
            {value.mode === "recurring"
              ? " Remaining leads carry over to the next selected day, and the campaign completes once the list is done."
              : " Remaining leads stay pending until you resume."}
            {overnight && (
              <span className="text-amber-700">
                {" "}
                This window crosses midnight.
              </span>
            )}
          </p>

          {equal && (
            <p className="text-[11px] text-red-600">
              Start and end cannot be the same time — that is a zero-length
              window, and the campaign would never dial.
            </p>
          )}
          {noDays && (
            <p className="text-[11px] text-red-600">
              Pick at least one day for a recurring campaign.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Seeds a picker value from /api/ai-dialer/schedule-defaults exactly once per
 *  mount, leaving the mode alone. Every mount point needs this and none of them
 *  should be hard-coding 09:00.
 *
 *  Takes the useState SETTER, not the value: the setter is referentially stable,
 *  so the effect has a genuinely empty-ish dependency and cannot re-fetch on
 *  every keystroke. The functional update is what lets it merge into whatever
 *  the user has typed in the meantime without the hook holding a copy of the
 *  value (which would mean writing a ref during render). */
export function useScheduleDefaults(
  setValue: Dispatch<SetStateAction<CampaignScheduleValue>>,
) {
  // Only ever touched inside the effect, so this is not a render-phase read.
  // Guards against a slow response overwriting a window the user has already
  // edited, and against StrictMode's double-invoke seeding twice.
  const seeded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/ai-dialer/schedule-defaults");
        if (!res.ok) return;
        const json = await res.json();
        const d = json?.data ?? json;
        if (cancelled || seeded.current || !d?.window_start) return;
        seeded.current = true;
        setValue((prev) => ({
          ...prev,
          window_start: d.window_start,
          window_end: d.window_end,
          window_days: d.window_days ?? prev.window_days,
        }));
      } catch {
        // Non-fatal: the picker keeps whatever the parent seeded it with.
        // A campaign form is not worth failing over a defaults lookup.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setValue]);
}

/** The value a parent starts from before the defaults land. Deliberately the
 *  same 09:00-19:00 Mon-Sat as FALLBACK_DEFAULTS on the server. */
export const INITIAL_SCHEDULE: CampaignScheduleValue = {
  mode: "now",
  window_start: "09:00",
  window_end: "19:00",
  window_days: ["mon", "tue", "wed", "thu", "fri", "sat"],
};
