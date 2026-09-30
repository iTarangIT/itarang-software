"use client";

import { useRef, useState } from "react";
import { Download, FileText, Film, Image as ImageIcon, Loader2, Paperclip, X, Archive } from "lucide-react";

import { cn } from "@/lib/utils";

import { attachmentUrl, formatBytes, uploadFile, type Attachment, type UploadedFile } from "./api";

type Pending = { key: string; name: string; size: number; state: "uploading" | "done" | "error"; error?: string; file?: UploadedFile };

const ACCEPT =
  ".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.rtf,.odt,.ods,.png,.jpg,.jpeg,.gif,.webp,.heic,.mp4,.mov,.webm,.zip,.rar,.7z";

/**
 * Files upload as soon as they are picked (one request each, so one bad file
 * doesn't sink the rest); the parent only ever sees the ids that made it.
 */
export function useFileUploads() {
  const [items, setItems] = useState<Pending[]>([]);

  const add = (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      const key = `${f.name}-${f.size}-${Math.random()}`;
      setItems((cur) => [...cur, { key, name: f.name, size: f.size, state: "uploading" }]);
      uploadFile(f)
        .then((file) => setItems((cur) => cur.map((p) => (p.key === key ? { ...p, state: "done", file } : p))))
        .catch((e: Error) =>
          setItems((cur) => cur.map((p) => (p.key === key ? { ...p, state: "error", error: e.message } : p))),
        );
    }
  };

  return {
    items,
    add,
    remove: (key: string) => setItems((cur) => cur.filter((p) => p.key !== key)),
    reset: () => setItems([]),
    ids: items.filter((p) => p.state === "done" && p.file).map((p) => p.file!.id),
    busy: items.some((p) => p.state === "uploading"),
  };
}

export type FileUploads = ReturnType<typeof useFileUploads>;

export function FilePicker({ uploads, compact = false }: { uploads: FileUploads; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  return (
    <div>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) uploads.add(e.target.files);
          e.target.value = "";
        }}
      />
      {compact ? (
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
        >
          <Paperclip className="h-3.5 w-3.5" /> Attach files
        </button>
      ) : (
        <div
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            uploads.add(e.dataTransfer.files);
          }}
          className={cn(
            "cursor-pointer rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition-colors",
            drag ? "border-blue-400 bg-blue-50" : "border-gray-200 bg-gray-50 hover:border-gray-300",
          )}
        >
          <Paperclip className="mx-auto mb-1 h-5 w-5 text-gray-400" />
          <p className="font-medium text-gray-700">Drop files here or click to browse</p>
          <p className="mt-0.5 text-xs text-gray-500">PDF, Word, Excel, images, videos, ZIP — up to 25 MB each</p>
        </div>
      )}

      {uploads.items.length > 0 && (
        <ul className="mt-2 space-y-1">
          {uploads.items.map((p) => (
            <li
              key={p.key}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
                p.state === "error" ? "border-red-200 bg-red-50" : "border-gray-200 bg-white",
              )}
            >
              {p.state === "uploading" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
              ) : (
                <FileIcon name={p.name} />
              )}
              <span className="min-w-0 flex-1 truncate text-gray-800">{p.name}</span>
              <span className="text-gray-400">{formatBytes(p.size)}</span>
              {p.state === "error" && <span className="text-red-600">{p.error}</span>}
              <button
                type="button"
                onClick={() => uploads.remove(p.key)}
                className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                aria-label={`Remove ${p.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileIcon({ name, mime }: { name: string; mime?: string | null }) {
  const n = name.toLowerCase();
  if (mime?.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic)$/.test(n))
    return <ImageIcon className="h-3.5 w-3.5 shrink-0 text-emerald-600" />;
  if (mime?.startsWith("video/") || /\.(mp4|mov|webm)$/.test(n)) return <Film className="h-3.5 w-3.5 shrink-0 text-violet-600" />;
  if (/\.(zip|rar|7z)$/.test(n)) return <Archive className="h-3.5 w-3.5 shrink-0 text-amber-600" />;
  return <FileText className="h-3.5 w-3.5 shrink-0 text-blue-600" />;
}

const isPreviewable = (a: Attachment) => /^image\/(png|jpe?g|gif|webp)$/i.test(a.mime_type ?? "");

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {attachments.map((a) => (
        <li key={a.id}>
          <a
            href={attachmentUrl(a.id)}
            className="group flex max-w-xs items-center gap-2 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs hover:border-blue-300 hover:bg-blue-50"
            title={`Download ${a.file_name}`}
          >
            {isPreviewable(a) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={attachmentUrl(a.id, true)} alt="" className="h-8 w-8 rounded object-cover" />
            ) : (
              <FileIcon name={a.file_name} mime={a.mime_type} />
            )}
            <span className="min-w-0 truncate font-medium text-gray-800">{a.file_name}</span>
            <span className="shrink-0 text-gray-400">{formatBytes(a.size_bytes)}</span>
            <Download className="h-3.5 w-3.5 shrink-0 text-gray-400 group-hover:text-blue-600" />
          </a>
        </li>
      ))}
    </ul>
  );
}
