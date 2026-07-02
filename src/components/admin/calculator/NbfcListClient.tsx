"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Power, PowerOff, ChevronRight } from "lucide-react";
import { postJson } from "./helpers";

interface NbfcRow {
  id: number;
  nbfcCode: string;
  name: string;
  variant: "A" | "B";
  status: "active" | "disabled";
  activeSchemes: number;
  coverage: string;
}

export function NbfcListClient({ nbfcs }: { nbfcs: NbfcRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(nb: NbfcRow) {
    setBusy(nb.id);
    setError(null);
    try {
      await postJson("/api/admin/calculator/nbfc", {
        nbfcId: nb.id,
        status: nb.status === "active" ? "disabled" : "active",
      });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-5 py-3">
        <h2 className="text-sm font-bold text-gray-900">NBFCs</h2>
        <p className="text-xs text-gray-500">Disabling an NBFC removes its cards from the calculator; historical quotes are preserved.</p>
      </div>
      {error && <p className="px-5 py-2 text-xs text-red-600">{error}</p>}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-400">
            <th className="px-5 py-2 font-medium">NBFC</th>
            <th className="px-5 py-2 font-medium">Variant</th>
            <th className="px-5 py-2 font-medium">Schemes</th>
            <th className="px-5 py-2 font-medium">Coverage</th>
            <th className="px-5 py-2 font-medium">Status</th>
            <th className="px-5 py-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {nbfcs.map((nb) => (
            <tr key={nb.id} className="border-t border-gray-50">
              <td className="px-5 py-3 font-semibold text-gray-900">{nb.name}</td>
              <td className="px-5 py-3 text-gray-600">
                {nb.variant === "A" ? "A · EMI-folded" : "B · file-charge"}
              </td>
              <td className="px-5 py-3 text-gray-600">{nb.activeSchemes}</td>
              <td className="px-5 py-3 text-gray-600">{nb.coverage}</td>
              <td className="px-5 py-3">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    nb.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-500"
                  }`}
                >
                  {nb.status}
                </span>
              </td>
              <td className="px-5 py-3">
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => toggle(nb)}
                    disabled={busy === nb.id}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {busy === nb.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : nb.status === "active" ? (
                      <PowerOff className="h-3.5 w-3.5" />
                    ) : (
                      <Power className="h-3.5 w-3.5" />
                    )}
                    {nb.status === "active" ? "Disable" : "Enable"}
                  </button>
                  <Link
                    href={`/admin/calculator/nbfc/${nb.id}`}
                    className="inline-flex items-center gap-1 rounded-lg bg-gray-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-gray-800"
                  >
                    Edit <ChevronRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
