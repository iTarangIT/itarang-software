"use client";

type Signer = {
  id: string;
  signerRole: string;
  signerName: string;
  signerEmail?: string | null;
  signerMobile?: string | null;
  signingMethod?: string | null;
  signerStatus: string;
  signedAt?: string | null;
};
// hello world
function statusClasses(status: string) {
  const safe = String(status || "").toLowerCase();

  if (safe === "signed") return "bg-green-50 text-green-700 border-green-200";
  if (safe === "viewed") return "bg-indigo-50 text-indigo-700 border-indigo-200";
  if (safe === "sent") return "bg-blue-50 text-blue-700 border-blue-200";
  if (safe === "failed") return "bg-red-50 text-red-700 border-red-200";
  if (safe === "expired") return "bg-amber-50 text-amber-700 border-amber-200";

  return "bg-slate-50 text-slate-700 border-slate-200";
}

export default function AgreementSignersTable({
  signers,
  agreementCopyUrl,
  auditTrailUrl,
  showReinitiate,
  onReinitiate,
}: {
  signers: Signer[];
  agreementCopyUrl?: string | null;
  auditTrailUrl?: string | null;
  showReinitiate?: boolean;
  onReinitiate?: () => void;
}) {
  return (
    <div className="rounded-2xl border border-[#E3E8EF] bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#E3E8EF]">
        <div>
          <h2 className="text-lg font-semibold text-[#173F63]">Agreement Tracking</h2>
          <p className="text-sm text-slate-500">Signer-wise agreement progress and actions</p>
        </div>

        {showReinitiate ? (
          <button
            onClick={onReinitiate}
            className="rounded-xl bg-[#1F5C8F] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Re-initiate Agreement
          </button>
        ) : null}
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-[#F8FAFC] text-slate-600">
            <tr>
              <th className="px-6 py-3 text-left font-medium">Signer</th>
              <th className="px-6 py-3 text-left font-medium">Email / Mobile</th>
              <th className="px-6 py-3 text-left font-medium">Method</th>
              <th className="px-6 py-3 text-left font-medium">Status</th>
              <th className="px-6 py-3 text-left font-medium">Signed At</th>
              <th className="px-6 py-3 text-left font-medium">Agreement Copy</th>
              <th className="px-6 py-3 text-left font-medium">Audit Trail</th>
            </tr>
          </thead>
          <tbody>
            {signers.map((signer) => (
              <tr key={signer.id} className="border-t border-[#E3E8EF]">
                <td className="px-6 py-4">
                  <div className="font-medium text-slate-900">{signer.signerName}</div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">
                    {signer.signerRole.replaceAll("_", " ")}
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="text-slate-800">{signer.signerEmail || "-"}</div>
                  <div className="text-xs text-slate-500">{signer.signerMobile || "-"}</div>
                </td>
                <td className="px-6 py-4 text-slate-700">{signer.signingMethod || "-"}</td>
                <td className="px-6 py-4">
                  <span
                    className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${statusClasses(
                      signer.signerStatus
                    )}`}
                  >
                    {signer.signerStatus}
                  </span>
                </td>
                <td className="px-6 py-4 text-slate-700">
                  {signer.signedAt ? new Date(signer.signedAt).toLocaleString() : "-"}
                </td>
                <td className="px-6 py-4">
                  {agreementCopyUrl ? (
                    <a
                      href={agreementCopyUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#1F5C8F] hover:underline"
                    >
                      View / Download
                    </a>
                  ) : (
                    <span className="text-slate-400">Not available</span>
                  )}
                </td>
                <td className="px-6 py-4">
                  {auditTrailUrl ? (
                    <a
                      href={auditTrailUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#1F5C8F] hover:underline"
                    >
                      View / Download
                    </a>
                  ) : (
                    <span className="text-slate-400">Not available</span>
                  )}
                </td>
              </tr>
            ))}

            {!signers.length ? (
              <tr>
                <td colSpan={7} className="px-6 py-10 text-center text-slate-500">
                  No signer tracking available yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}