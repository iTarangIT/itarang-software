"use client";

import React from "react";

const OUTCOME_CONFIG: Record<string, any> = {
  callback_requested: {
    label: "Callback Requested",
    color: "text-purple-700",
    bg: "bg-purple-50",
  },
  interested: {
    label: "Interested",
    color: "text-emerald-700",
    bg: "bg-emerald-50",
  },
  disqualified: {
    label: "Not Interested",
    color: "text-red-600",
    bg: "bg-red-50",
  },
  unknown: { label: "No Outcome", color: "text-gray-500", bg: "bg-gray-100" },
};

function formatDate(d: string | null) {
  if (!d) return "Not Scheduled";
  return new Date(d).toLocaleString("en-IN");
}

export function FollowUpUI({ history }: any) {
  const [expandedGroups, setExpandedGroups] = React.useState<
    Record<number, boolean>
  >({});

  const groupedHistory = [];
  for (let i = 0; i < history.length; i += 10) {
    groupedHistory.push(history.slice(i, i + 10));
  }

  const toggleGroup = (i: number) => {
    setExpandedGroups((prev) => ({
      ...prev,
      [i]: !prev[i],
    }));
  };

  return (
    <div className="bg-white border rounded-xl p-6">
      <h3 className="text-sm font-semibold mb-4">Follow-up History</h3>

      {groupedHistory.map((group, gi) => (
        <div key={gi} className="border rounded-xl p-4 mb-4">
          <div className="flex justify-between mb-3">
            <p className="text-sm font-semibold">
              Attempts {gi * 10 + 1}–{gi * 10 + group.length}
            </p>

            <button
              onClick={() => toggleGroup(gi)}
              className="text-xs text-gray-500"
            >
              {expandedGroups[gi] ? "Collapse ▲" : "Expand ▼"}
            </button>
          </div>

          {expandedGroups[gi] && (
            <div className="space-y-3">
              {group.map((item: any, i: number) => {
                const outcome =
                  OUTCOME_CONFIG[item.outcome] || OUTCOME_CONFIG.unknown;

                return (
                  <div key={i} className="bg-gray-50 border rounded-lg p-4">
                    <div className="flex justify-between mb-2">
                      <span className="text-sm font-medium">
                        Attempt #{item.attempt}
                      </span>
                      <span
                        className={`text-xs px-2 py-1 rounded ${outcome.bg} ${outcome.color}`}
                      >
                        {outcome.label}
                      </span>
                    </div>

                    <div className="grid grid-cols-4 gap-2 text-center text-sm mb-2">
                      <div>
                        <p className="text-gray-400 text-xs">Intent</p>
                        <p>{item.analysis?.intent_score ?? "-"}</p>
                      </div>
                      <div>
                        <p className="text-gray-400 text-xs">Engagement</p>
                        <p>{item.analysis?.engagement_depth ?? "-"}</p>
                      </div>
                      <div>
                        <p className="text-gray-400 text-xs">Urgency</p>
                        <p>{item.analysis?.urgency_signals ?? "-"}</p>
                      </div>
                      <div>
                        <p className="text-gray-400 text-xs">Objection</p>
                        <p>{item.analysis?.objection_quality ?? "-"}</p>
                      </div>
                    </div>

                    {item.transcript && (
                      <div className="bg-white border rounded p-3 text-xs max-h-40 overflow-y-auto">
                        {item.transcript
                          .split("\n")
                          .map((line: string, idx: number) => (
                            <p key={idx}>{line}</p>
                          ))}
                      </div>
                    )}

                    {item.next_call_at && (
                      <p className="text-xs text-blue-600 mt-2">
                        Next Call: {formatDate(item.next_call_at)}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
