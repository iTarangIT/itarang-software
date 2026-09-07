"use client";

/**
 * E-283 — the delete control for a customer application, shared by the admin
 * queues and the NBFC Acquire pipeline.
 *
 * The wording is the point. Deleting here removes the application from THIS
 * dashboard; the other parties keep theirs, and the file is only destroyed once
 * everyone holding it has deleted it. The confirm dialog says so explicitly,
 * because the old dealer-side delete was a hard cascade and people remember it
 * that way.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Trash2, X } from "lucide-react";
import { toast } from "sonner";

export interface DeleteApplicationButtonProps {
  /** DELETE endpoint for this party's scope. */
  endpoint: string;
  /** Shown in the dialog so the operator can confirm they picked the right row. */
  applicationLabel: string;
  applicationId: string;
  /** Which dashboard the row is disappearing from, e.g. "the admin dashboard". */
  scopeLabel: string;
  /** Who else still holds a copy, e.g. "the dealer and the lender". */
  otherPartiesLabel: string;
  /** Called after a successful delete; defaults to router.refresh(). */
  onDeleted?: () => void;
  className?: string;
}

export default function DeleteApplicationButton({
  endpoint,
  applicationLabel,
  applicationId,
  scopeLabel,
  otherPartiesLabel,
  onDeleted,
  className,
}: DeleteApplicationButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch(endpoint, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      const ok = res.ok && (data?.success ?? data?.ok ?? false);
      if (!ok) {
        toast.error(
          data?.error?.message ??
            (typeof data?.error === "string" ? data.error : null) ??
            data?.message ??
            "Failed to delete application",
        );
        return;
      }
      // successResponse() nests under `data`; the NBFC route answers flat.
      toast.success(data?.data?.message ?? data?.message ?? "Application removed");
      setOpen(false);
      if (onDeleted) onDeleted();
      else router.refresh();
    } catch {
      toast.error("Failed to delete application");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        title="Delete from this dashboard"
        aria-label={`Delete ${applicationLabel} from this dashboard`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={
          className ??
          "p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
        }
      >
        <Trash2 className="w-4 h-4" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={(e) => {
            e.stopPropagation();
            if (!busy) setOpen(false);
          }}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-rose-50 text-rose-600">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-bold text-slate-900">
                  Remove this application?
                </h2>
                <p className="text-sm text-slate-600 mt-2">
                  <span className="font-semibold text-slate-900">
                    {applicationLabel}
                  </span>{" "}
                  <span className="text-slate-500">({applicationId})</span> will
                  disappear from {scopeLabel}.
                </p>
                <p className="text-sm text-slate-600 mt-2">
                  It stays with {otherPartiesLabel}. The application is deleted
                  for good only once every party has removed it.
                </p>
              </div>
              <button
                type="button"
                onClick={() => !busy && setOpen(false)}
                className="text-slate-400 hover:text-slate-600"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="px-4 py-2 rounded-xl text-sm font-bold text-slate-600 border border-slate-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={submit}
                className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
