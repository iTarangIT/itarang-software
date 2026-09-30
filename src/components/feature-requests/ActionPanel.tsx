"use client";

import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Loader2, RotateCcw, Send, Undo2, UserCheck, XCircle, ArrowRight, ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, type ActionName, type Status } from "@/lib/feature-requests/workflow";

import { postJson, type Detail } from "./api";
import { FilePicker, useFileUploads } from "./files";

type DialogSpec = {
  action: ActionName;
  title: string;
  confirm: string;
  tone: "primary" | "danger" | "warning";
  /** Label for the text box; `required` makes it mandatory. */
  text: { label: string; placeholder: string; required: boolean };
  toStatus?: Status;
};

const BTN_TONE: Record<DialogSpec["tone"], string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-700",
  danger: "bg-red-600 text-white hover:bg-red-700",
  warning: "bg-orange-500 text-white hover:bg-orange-600",
};

export function ActionPanel({ detail, onChanged }: { detail: Detail; onChanged: () => void }) {
  const [open, setOpen] = useState<DialogSpec | null>(null);
  const { actions, request, me } = detail;
  const isTech = me.seat === "tech_reviewer";

  const specs: { spec: DialogSpec; icon: ReactNode; variant: string }[] = [];
  if (actions.includes("approve"))
    specs.push({
      spec: {
        action: "approve",
        title: isTech ? "Approve technical review" : "Approve product review",
        confirm: "Approve",
        tone: "primary",
        text: { label: "Note (optional)", placeholder: "Anything the next reviewer should know", required: false },
      },
      icon: <CheckCircle2 className="h-4 w-4" />,
      variant: "bg-emerald-600 text-white hover:bg-emerald-700",
    });
  if (actions.includes("request_changes"))
    specs.push({
      spec: {
        action: "request_changes",
        title: "Request changes",
        confirm: "Send back",
        tone: "warning",
        text: { label: "What needs to change?", placeholder: "Be specific — this is what they will work from", required: true },
      },
      icon: <Undo2 className="h-4 w-4" />,
      variant: "border border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100",
    });
  if (actions.includes("reject"))
    specs.push({
      spec: {
        action: "reject",
        title: "Reject request",
        confirm: "Reject",
        tone: "danger",
        text: { label: "Reason for rejection", placeholder: "Why is this not going ahead?", required: true },
      },
      icon: <XCircle className="h-4 w-4" />,
      variant: "border border-red-300 bg-white text-red-700 hover:bg-red-50",
    });
  if (actions.includes("resubmit"))
    specs.push({
      spec: {
        action: "resubmit",
        title: "Resubmit for review",
        confirm: "Resubmit",
        tone: "primary",
        text: { label: "What changed? (optional)", placeholder: "Summarise how you addressed the feedback", required: false },
      },
      icon: <Send className="h-4 w-4" />,
      variant: "bg-blue-600 text-white hover:bg-blue-700",
    });
  if (actions.includes("reopen"))
    specs.push({
      spec: {
        action: "reopen",
        title: "Reopen request",
        confirm: "Reopen",
        tone: "primary",
        text: { label: "What changed since the rejection?", placeholder: "Required", required: true },
      },
      icon: <RotateCcw className="h-4 w-4" />,
      variant: "bg-blue-600 text-white hover:bg-blue-700",
    });
  if (actions.includes("assign"))
    specs.push({
      spec: {
        action: "assign",
        title: request.status === "assigned" ? "Reassign developer" : "Assign developer",
        confirm: "Assign",
        tone: "primary",
        text: { label: "Note for the developer (optional)", placeholder: "Scope, pointers, deadlines…", required: false },
      },
      icon: <UserCheck className="h-4 w-4" />,
      variant: "bg-indigo-600 text-white hover:bg-indigo-700",
    });
  for (const to of detail.nextStatuses) {
    const back = to === "in_development" && request.status !== "assigned";
    specs.push({
      spec: {
        action: "set_status",
        toStatus: to,
        title: `Move to ${STATUS_LABELS[to]}`,
        confirm: back ? "Move back" : "Move",
        tone: back ? "warning" : "primary",
        text: { label: "Note (optional)", placeholder: "e.g. PR link, test notes, deploy details", required: false },
      },
      icon: back ? <ArrowLeft className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />,
      variant: back
        ? "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
        : "bg-violet-600 text-white hover:bg-violet-700",
    });
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Your actions</p>
      {specs.length === 0 ? (
        <p className="mt-2 text-sm text-gray-600">
          {request.status === "closed"
            ? "This request is closed. You can still comment."
            : request.current_owner_name
              ? `Waiting on ${request.current_owner_name}. You can still comment and attach files.`
              : "Nothing for you to do right now."}
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {specs.map(({ spec, icon, variant }) => (
            <button
              key={`${spec.action}-${spec.toStatus ?? ""}`}
              type="button"
              onClick={() => setOpen(spec)}
              className={cn(
                "inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors",
                variant,
              )}
            >
              {icon}
              {spec.title}
            </button>
          ))}
        </div>
      )}

      {open && (
        <ActionDialog
          spec={open}
          detail={detail}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function ActionDialog({
  spec,
  detail,
  onClose,
  onDone,
}: {
  spec: DialogSpec;
  detail: Detail;
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState("");
  const developers = detail.members.filter((m) => m.seat === "developer");
  const productHead = detail.members.find((m) => m.seat === "product_reviewer");
  const [developerId, setDeveloperId] = useState(developers[0]?.id ?? "");
  const [target, setTarget] = useState<"requester" | "product_reviewer">("requester");
  const uploads = useFileUploads();
  const showTarget = spec.action === "request_changes" && detail.me.seat === "tech_reviewer";

  const run = useMutation({
    mutationFn: () =>
      postJson(`/api/feature-requests/${detail.request.id}/actions`, {
        action: spec.action,
        ...(spec.text.required ? { reason: text } : { note: text }),
        target: showTarget ? target : undefined,
        developerId: spec.action === "assign" ? developerId : undefined,
        toStatus: spec.toStatus,
        attachmentIds: uploads.ids,
      }),
    onSuccess: () => {
      toast.success("Done");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const ok =
    (!spec.text.required || text.trim().length > 0) &&
    (spec.action !== "assign" || !!developerId) &&
    !uploads.busy &&
    !run.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900">{spec.title}</h3>
        <p className="mt-0.5 text-xs text-gray-500">
          {detail.request.code} · {detail.request.title}
        </p>

        <div className="mt-4 space-y-4">
          {showTarget && (
            <div>
              <p className="mb-1.5 text-sm font-medium text-gray-700">Send back to</p>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["requester", detail.request.created_by_name ?? "CEO", "CEO"],
                    ["product_reviewer", productHead?.name ?? "Product Head", "Product Head"],
                  ] as const
                ).map(([value, name, role]) => (
                  <label
                    key={value}
                    className={cn(
                      "cursor-pointer rounded-lg border px-3 py-2 text-sm",
                      target === value ? "border-orange-400 bg-orange-50" : "border-gray-200 hover:bg-gray-50",
                    )}
                  >
                    <input
                      type="radio"
                      className="sr-only"
                      checked={target === value}
                      onChange={() => setTarget(value)}
                    />
                    <span className="block font-semibold text-gray-900">{name}</span>
                    <span className="text-xs text-gray-500">{role}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {spec.action === "assign" && (
            <div>
              <p className="mb-1.5 text-sm font-medium text-gray-700">Developer</p>
              {developers.length === 0 ? (
                <p className="text-sm text-red-600">No active developers are set up.</p>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {developers.map((d) => (
                    <label
                      key={d.id}
                      className={cn(
                        "cursor-pointer rounded-lg border px-3 py-2 text-sm font-semibold",
                        developerId === d.id ? "border-indigo-400 bg-indigo-50 text-indigo-800" : "border-gray-200 hover:bg-gray-50",
                      )}
                    >
                      <input
                        type="radio"
                        className="sr-only"
                        checked={developerId === d.id}
                        onChange={() => setDeveloperId(d.id)}
                      />
                      {d.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              {spec.text.label}
              {spec.text.required && <span className="text-red-500"> *</span>}
            </label>
            <textarea
              autoFocus
              className="min-h-[100px] w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
              placeholder={spec.text.placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>

          <FilePicker uploads={uploads} compact />
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={run.isPending}>
            Cancel
          </Button>
          <button
            type="button"
            disabled={!ok}
            onClick={() => run.mutate()}
            className={cn(
              "inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold disabled:opacity-50",
              BTN_TONE[spec.tone],
            )}
          >
            {run.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {spec.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
