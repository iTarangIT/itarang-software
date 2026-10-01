"use client";

import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2,
  CircleDot,
  Loader2,
  MessageSquareReply,
  Pencil,
  RotateCcw,
  Send,
  Undo2,
  UserCheck,
  XCircle,
  FilePlus2,
  ArrowRightCircle,
  Edit3,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SEAT_LABELS, STATUS_LABELS, type Seat } from "@/lib/feature-requests/workflow";

import { formatDateTime, postJson, type Attachment, type Comment, type Detail } from "./api";
import { AttachmentList, FilePicker, useFileUploads } from "./files";

type EventRow = Detail["events"][number];

const roleLabel = (r: string) => SEAT_LABELS[r as Seat] ?? r.replace(/_/g, " ");

const initials = (name: string | null) =>
  (name ?? "?")
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** Pair a system comment with the event written in the same transaction. */
function eventFor(c: Comment, events: EventRow[]): EventRow | undefined {
  const t = new Date(c.created_at).getTime();
  return events.find(
    (e) => e.action !== "edit" && Math.abs(new Date(e.created_at).getTime() - t) < 5000 && e.actor_id === c.author_id,
  );
}

function systemHeadline(c: Comment, e?: EventRow): { text: string; icon: ReactNode; tone: string } {
  const to = e?.to_status ? STATUS_LABELS[e.to_status] : null;
  switch (c.kind) {
    case "created":
      return { text: "raised this request", icon: <FilePlus2 className="h-4 w-4" />, tone: "text-blue-600 bg-blue-50" };
    case "approval":
      return { text: `approved${to ? ` — moved to ${to}` : ""}`, icon: <CheckCircle2 className="h-4 w-4" />, tone: "text-emerald-600 bg-emerald-50" };
    case "rejection":
      return { text: "rejected this request", icon: <XCircle className="h-4 w-4" />, tone: "text-red-600 bg-red-50" };
    case "changes_requested":
      return {
        text: `requested changes${e?.target_name ? ` — sent back to ${e.target_name}` : ""}`,
        icon: <Undo2 className="h-4 w-4" />,
        tone: "text-orange-600 bg-orange-50",
      };
    case "resubmission":
      return { text: `resubmitted${to ? ` for ${to}` : ""}`, icon: <Send className="h-4 w-4" />, tone: "text-blue-600 bg-blue-50" };
    case "reopen":
      return { text: "reopened this request", icon: <RotateCcw className="h-4 w-4" />, tone: "text-blue-600 bg-blue-50" };
    case "assignment":
      return {
        text: `assigned this to ${e?.target_name ?? "a developer"}`,
        icon: <UserCheck className="h-4 w-4" />,
        tone: "text-indigo-600 bg-indigo-50",
      };
    case "status_change":
      return { text: `moved this to ${to ?? "a new status"}`, icon: <ArrowRightCircle className="h-4 w-4" />, tone: "text-violet-600 bg-violet-50" };
    case "edited":
      return { text: "edited the request", icon: <Edit3 className="h-4 w-4" />, tone: "text-gray-600 bg-gray-100" };
    default:
      return { text: "", icon: <CircleDot className="h-4 w-4" />, tone: "text-gray-600 bg-gray-100" };
  }
}

export function CommentThread({
  detail,
  onChanged,
}: {
  detail: Detail;
  onChanged: () => void;
}) {
  const top = detail.comments.filter((c) => !c.parent_id);
  const repliesOf = (id: string) => detail.comments.filter((c) => c.parent_id === id);
  const filesOf = (id: string) => detail.attachments.filter((a) => a.comment_id === id);

  return (
    <div className="space-y-4">
      {top.map((c) => (
        <div key={c.id} className="rounded-xl border border-gray-200 bg-white">
          <CommentItem
            c={c}
            files={filesOf(c.id)}
            event={c.kind === "comment" ? undefined : eventFor(c, detail.events)}
            meId={detail.me.id}
            onChanged={onChanged}
          />
          {repliesOf(c.id).length > 0 && (
            <div className="space-y-0 border-t border-gray-100 bg-gray-50/60 pl-10">
              {repliesOf(c.id).map((r) => (
                <CommentItem key={r.id} c={r} files={filesOf(r.id)} meId={detail.me.id} onChanged={onChanged} isReply />
              ))}
            </div>
          )}
          <ReplyBox requestId={detail.request.id} parentId={c.id} onChanged={onChanged} />
        </div>
      ))}

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <p className="mb-2 text-sm font-semibold text-gray-800">Add a comment</p>
        <Composer requestId={detail.request.id} onChanged={onChanged} placeholder="Share feedback, ask a question, or attach files…" />
      </div>
    </div>
  );
}

function CommentItem({
  c,
  files,
  event,
  meId,
  onChanged,
  isReply = false,
}: {
  c: Comment;
  files: Attachment[];
  event?: EventRow;
  meId: string;
  onChanged: () => void;
  isReply?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  const [showHistory, setShowHistory] = useState(false);
  const isSystem = c.kind !== "comment";
  const sys = isSystem ? systemHeadline(c, event) : null;

  const save = useMutation({
    mutationFn: () => postJson(`/api/feature-requests/comments/${c.id}`, { body: draft }, "PATCH"),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className={cn("flex gap-3 p-4", isReply && "py-3")}>
      {sys ? (
        <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", sys.tone)}>{sys.icon}</div>
      ) : (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-[11px] font-bold text-white">
          {initials(c.author_name)}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="font-semibold text-gray-900">{c.author_name ?? "Unknown user"}</span>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">
            {roleLabel(c.author_role)}
          </span>
          {sys && <span className="text-gray-700">{sys.text}</span>}
          <span className="text-xs text-gray-400">{formatDateTime(c.created_at)}</span>
          {c.edited_at && (
            <button
              type="button"
              onClick={() => setShowHistory((s) => !s)}
              className="text-xs text-gray-400 underline decoration-dotted hover:text-gray-600"
            >
              edited{c.edits.length > 1 ? ` ${c.edits.length}×` : ""}
            </button>
          )}
          {!isSystem && c.author_id === meId && !editing && (
            <button
              type="button"
              onClick={() => {
                setDraft(c.body);
                setEditing(true);
              }}
              className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100"
            >
              <Pencil className="h-3 w-3" /> Edit
            </button>
          )}
        </div>

        {editing ? (
          <div className="mt-2 space-y-2">
            <textarea
              className="min-h-[80px] w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={save.isPending}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => save.mutate()} disabled={!draft.trim() || save.isPending}>
                {save.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Save
              </Button>
            </div>
          </div>
        ) : (
          c.body && (
            <p
              className={cn(
                "mt-1 whitespace-pre-wrap break-words text-sm text-gray-800",
                c.kind === "rejection" && "rounded-md bg-red-50 px-3 py-2 text-red-900",
                c.kind === "changes_requested" && "rounded-md bg-orange-50 px-3 py-2 text-orange-900",
              )}
            >
              {c.body}
            </p>
          )
        )}

        {showHistory && c.edits.length > 0 && (
          <div className="mt-2 space-y-1.5 rounded-md border border-dashed border-gray-200 bg-gray-50 p-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Earlier versions</p>
            {c.edits.map((e, i) => (
              <div key={i} className="text-xs">
                <span className="text-gray-400">before {formatDateTime(e.edited_at)}:</span>
                <p className="whitespace-pre-wrap text-gray-600 line-through decoration-gray-300">{e.previous_body}</p>
              </div>
            ))}
          </div>
        )}

        {files.length > 0 && (
          <div className="mt-2">
            <AttachmentList attachments={files} />
          </div>
        )}
      </div>
    </div>
  );
}

function ReplyBox({ requestId, parentId, onChanged }: { requestId: string; parentId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="border-t border-gray-100 px-4 py-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-blue-600"
        >
          <MessageSquareReply className="h-3.5 w-3.5" /> Reply
        </button>
      </div>
    );
  }
  return (
    <div className="border-t border-gray-100 p-3 pl-14">
      <Composer
        requestId={requestId}
        parentId={parentId}
        autoFocus
        placeholder="Write a reply…"
        onCancel={() => setOpen(false)}
        onChanged={() => {
          setOpen(false);
          onChanged();
        }}
      />
    </div>
  );
}

function Composer({
  requestId,
  parentId,
  placeholder,
  autoFocus,
  onCancel,
  onChanged,
}: {
  requestId: string;
  parentId?: string;
  placeholder: string;
  autoFocus?: boolean;
  onCancel?: () => void;
  onChanged: () => void;
}) {
  const [body, setBody] = useState("");
  const uploads = useFileUploads();

  const send = useMutation({
    mutationFn: () =>
      postJson(`/api/feature-requests/${requestId}/comments`, { body, parentId, attachmentIds: uploads.ids }),
    onSuccess: () => {
      setBody("");
      uploads.reset();
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canSend = (body.trim().length > 0 || uploads.ids.length > 0) && !uploads.busy && !send.isPending;

  return (
    <div className="space-y-2">
      <textarea
        autoFocus={autoFocus}
        className="min-h-[72px] w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
        placeholder={placeholder}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <FilePicker uploads={uploads} compact />
        </div>
        <div className="flex shrink-0 gap-2">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button size="sm" onClick={() => send.mutate()} disabled={!canSend}>
            {send.isPending || uploads.busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            {parentId ? "Reply" : "Comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}
