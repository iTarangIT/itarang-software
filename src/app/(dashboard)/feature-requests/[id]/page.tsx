"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Loader2, Pencil } from "lucide-react";

import { ActionPanel } from "@/components/feature-requests/ActionPanel";
import { api, formatDateTime, postJson, type Detail } from "@/components/feature-requests/api";
import { PriorityBadge, StatusBadge, StatusStepper } from "@/components/feature-requests/badges";
import { CommentThread } from "@/components/feature-requests/CommentThread";
import { AttachmentList } from "@/components/feature-requests/files";
import { FeatureRequestForm, type FeatureRequestValues } from "@/components/feature-requests/FeatureRequestForm";
import { SEAT_LABELS } from "@/lib/feature-requests/workflow";

export default function FeatureRequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["feature-request", id],
    queryFn: () => api<Detail>(`/api/feature-requests/${id}`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["feature-request", id] });
    qc.invalidateQueries({ queryKey: ["feature-requests"] });
  };

  const save = useMutation({
    mutationFn: ({ v, ids }: { v: FeatureRequestValues; ids: string[] }) =>
      postJson(`/api/feature-requests/${id}`, { ...v, attachmentIds: ids }, "PATCH"),
    onSuccess: () => {
      toast.success("Request updated — resubmit it when you're ready");
      setEditing(false);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-24 text-gray-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
      </div>
    );
  }
  if (error || !data) {
    return <div className="py-24 text-center text-sm text-red-600">{(error as Error)?.message ?? "Not found"}</div>;
  }

  const r = data.request;
  const requestFiles = data.attachments.filter((a) => !a.comment_id);
  const lastSendBack = [...data.comments].reverse().find((c) => c.kind === "changes_requested" || c.kind === "rejection");

  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-12">
      <Link href="/feature-requests" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="h-4 w-4" /> Feature Requests
      </Link>

      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span className="font-mono">{r.code}</span>
              {r.revision > 1 && <span>· revision {r.revision}</span>}
              <span>· {r.module}</span>
            </div>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">{r.title}</h1>
            <p className="mt-1 text-xs text-gray-500">
              Raised by {r.created_by_name ?? "—"} on {formatDateTime(r.created_at)}
              {r.assigned_developer_name && <> · Developer: {r.assigned_developer_name}</>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <PriorityBadge priority={r.priority} />
            <StatusBadge status={r.status} />
          </div>
        </div>
        <div className="mt-4 overflow-x-auto">
          <StatusStepper status={r.status} resubmitTo={r.resubmit_to_status} />
        </div>
      </div>

      {(r.status === "changes_requested" || r.status === "rejected") && lastSendBack && (
        <div className="flex gap-3 rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm">
          <AlertTriangle className="h-5 w-5 shrink-0 text-orange-600" />
          <div>
            <p className="font-semibold text-orange-900">
              {r.status === "rejected" ? "Rejected" : "Changes requested"} by {lastSendBack.author_name} (
              {SEAT_LABELS[lastSendBack.author_role as keyof typeof SEAT_LABELS] ?? lastSendBack.author_role})
              {r.status === "changes_requested" && r.current_owner_name && <> — with {r.current_owner_name}</>}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-orange-900/90">{lastSendBack.body}</p>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Description</h2>
              {data.canEdit && !editing && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  <Pencil className="h-3.5 w-3.5" /> Edit request
                </button>
              )}
            </div>
            {editing ? (
              <FeatureRequestForm
                initial={{ title: r.title, description: r.description, priority: r.priority, module: r.module }}
                submitLabel="Save changes"
                filesLabel="Add files"
                busy={save.isPending}
                onSubmit={(v, ids) => save.mutate({ v, ids })}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-800">{r.description}</p>
                {requestFiles.length > 0 && (
                  <div className="mt-4">
                    <AttachmentList attachments={requestFiles} />
                  </div>
                )}
              </>
            )}
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
              Discussion &amp; history ({data.comments.length})
            </h2>
            <CommentThread detail={data} onChanged={refresh} />
          </div>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <ActionPanel detail={data} onChanged={refresh} />

          <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Details</p>
            <dl className="mt-2 space-y-1.5">
              <Row k="Currently with" v={r.status === "closed" ? "—" : (r.current_owner_name ?? "—")} />
              <Row k="Developer" v={r.assigned_developer_name ?? "Not assigned"} />
              <Row k="Last update" v={formatDateTime(r.updated_at)} />
              {r.closed_at && <Row k="Closed" v={formatDateTime(r.closed_at)} />}
            </dl>
          </div>

          {data.attachments.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                All files ({data.attachments.length})
              </p>
              <AttachmentList attachments={data.attachments} />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-500">{k}</dt>
      <dd className="text-right font-medium text-gray-800">{v}</dd>
    </div>
  );
}
