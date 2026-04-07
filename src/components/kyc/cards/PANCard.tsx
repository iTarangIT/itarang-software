// components/kyc/cards/PANCard.tsx
"use client";

import { useState } from "react";

interface PANCardProps {
  leadId: string;
  leadName: string;
  panNumber?: string;
  dob?: string;
}

type CardStatus = "pending" | "loading" | "success" | "failed";

export default function PANCard({
  leadId,
  leadName,
  panNumber,
  dob,
}: PANCardProps) {
  const [pan, setPan] = useState(panNumber || "");
  const [dobVal, setDob] = useState(dob || "");
  const [status, setStatus] = useState<CardStatus>("pending");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");

  const handleVerify = async () => {
    if (!pan) return alert("PAN number is required");
    setStatus("loading");
    setError("");

    try {
      const res = await fetch(`/api/kyc/${leadId}/decentro/pan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pan_number: pan, dob: dobVal }),
      });

      const data = await res.json();
      setResult(data);
      setStatus(data.success ? "success" : "failed");
    } catch (e) {
      setStatus("failed");
      setError("Network error. Please try again.");
    }
  };

  const getMatchBadge = (score: number | null) => {
    if (score === null) return <span className="text-gray-400">N/A</span>;
    if (score >= 80)
      return (
        <span className="text-green-600 font-semibold">
          ✅ {score}% Strong Match
        </span>
      );
    if (score >= 50)
      return (
        <span className="text-yellow-600 font-semibold">
          ⚠️ {score}% Partial Match
        </span>
      );
    return (
      <span className="text-red-600 font-semibold">❌ {score}% Mismatch</span>
    );
  };

  const getStatusBadge = () => {
    const styles: Record<CardStatus, string> = {
      pending: "bg-gray-100 text-gray-600",
      loading: "bg-blue-100 text-blue-600",
      success: "bg-green-100 text-green-700",
      failed: "bg-red-100 text-red-700",
    };
    const labels: Record<CardStatus, string> = {
      pending: "⏳ Pending",
      loading: "🔵 Verifying...",
      success: "✅ Success",
      failed: "❌ Failed",
    };
    return (
      <span
        className={`px-3 py-1 rounded-full text-sm font-medium ${styles[status]}`}
      >
        {labels[status]}
      </span>
    );
  };

  return (
    <div className="border rounded-xl p-5 bg-white shadow-sm mb-4">
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-gray-800">
          🪪 PAN Verification
        </h3>
        {getStatusBadge()}
      </div>

      {/* Input Section */}
      <div className="bg-gray-50 rounded-lg p-4 mb-4">
        <p className="text-xs text-gray-500 uppercase font-semibold mb-3">
          Input Data
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-gray-600">PAN Number</label>
            <input
              type="text"
              value={pan}
              onChange={(e) => setPan(e.target.value.toUpperCase())}
              placeholder="ABCDE1234F"
              className="w-full mt-1 border rounded-lg px-3 py-2 text-sm uppercase"
              disabled={status === "loading"}
            />
          </div>
          <div>
            <label className="text-sm text-gray-600">Date of Birth</label>
            <input
              type="date"
              value={dobVal}
              onChange={(e) => setDob(e.target.value)}
              className="w-full mt-1 border rounded-lg px-3 py-2 text-sm"
              disabled={status === "loading"}
            />
          </div>
          <div>
            <label className="text-sm text-gray-600">Lead Name</label>
            <input
              type="text"
              value={leadName}
              disabled
              className="w-full mt-1 border rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-500"
            />
          </div>
        </div>

        <button
          onClick={handleVerify}
          disabled={status === "loading"}
          className="mt-4 bg-teal-600 hover:bg-teal-700 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {status === "loading" ? "⏳ Verifying..." : "▶ Run PAN Verification"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-red-600 text-sm">
          {error}
        </div>
      )}

      {/* Results Table */}
      {result && (
        <div className="mb-4">
          <p className="text-xs text-gray-500 uppercase font-semibold mb-3">
            Verification Results
          </p>
          <table className="w-full text-sm border rounded-lg overflow-hidden">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 text-gray-600">Field</th>
                <th className="text-left px-4 py-2 text-gray-600">
                  Input Data
                </th>
                <th className="text-left px-4 py-2 text-gray-600">From API</th>
                <th className="text-left px-4 py-2 text-gray-600">Match</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              <tr>
                <td className="px-4 py-2 text-gray-700">Name</td>
                <td className="px-4 py-2">
                  {result.data?.lead_name || leadName}
                </td>
                <td className="px-4 py-2">{result.data?.pan_name || "—"}</td>
                <td className="px-4 py-2">
                  {getMatchBadge(result.data?.name_match_score)}
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 text-gray-700">PAN Status</td>
                <td className="px-4 py-2">—</td>
                <td className="px-4 py-2">{result.data?.pan_status || "—"}</td>
                <td className="px-4 py-2">
                  {result.data?.pan_status === "VALID" ? (
                    <span className="text-green-600">✅ Valid</span>
                  ) : (
                    <span className="text-red-600">❌ Invalid</span>
                  )}
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 text-gray-700">Category</td>
                <td className="px-4 py-2">—</td>
                <td className="px-4 py-2">
                  {result.data?.pan_category || "—"}
                </td>
                <td className="px-4 py-2">—</td>
              </tr>
            </tbody>
          </table>

          {/* Message */}
          <div
            className={`mt-3 p-3 rounded-lg text-sm ${result.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}
          >
            {result.message}
          </div>
        </div>
      )}
    </div>
  );
}
