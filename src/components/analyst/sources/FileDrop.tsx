"use client";

// Data Analyst — choosing files for a dataset. Only picks and checks them; the caller uploads
// the whole batch in one request, because the agent builds a dataset from one files[] post.

import { FileSpreadsheet, FileText, Upload, X } from "lucide-react";
import { useRef, useState } from "react";

import { MAX_FILE_BYTES, MAX_UPLOAD_FILES, UPLOAD_EXTENSIONS, uploadAllowed } from "@/lib/analyst/sources-routes";
import { cn } from "@/lib/utils";

import { formatBytes } from "./api";

export type PickedFile = { key: string; file: File; problem: string | null };

function check(file: File): string | null {
  if (!uploadAllowed(file.name)) return "not a CSV, TSV, Excel, Parquet or PDF file";
  if (file.size > MAX_FILE_BYTES) return "larger than 25 MB";
  if (file.size === 0) return "empty file";
  return null;
}

export function usePickedFiles() {
  const [items, setItems] = useState<PickedFile[]>([]);
  return {
    items,
    add(list: FileList | File[]) {
      setItems((current) => {
        const seen = new Set(current.map((p) => p.file.name));
        const next = [...current];
        for (const file of Array.from(list)) {
          if (seen.has(file.name)) continue; // same name would overwrite a table on the agent
          seen.add(file.name);
          next.push({ key: `${file.name}-${file.size}-${file.lastModified}`, file, problem: check(file) });
        }
        return next;
      });
    },
    remove(key: string) {
      setItems((current) => current.filter((p) => p.key !== key));
    },
    clear() {
      setItems([]);
    },
    /** The files that can be sent, or a reason the batch cannot. */
    ready(): { files: File[]; problem: string | null } {
      const files = items.filter((p) => !p.problem).map((p) => p.file);
      if (files.length === 0) return { files, problem: "choose at least one supported file" };
      if (files.length > MAX_UPLOAD_FILES) return { files, problem: `at most ${MAX_UPLOAD_FILES} files at a time` };
      return { files, problem: null };
    },
  };
}

export type PickedFiles = ReturnType<typeof usePickedFiles>;

export function FileDrop({ picked, disabled }: { picked: PickedFiles; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  return (
    <div>
      <input
        ref={input}
        type="file"
        multiple
        accept={UPLOAD_EXTENSIONS.join(",")}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) picked.add(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (!disabled) picked.add(e.dataTransfer.files);
        }}
        className={cn(
          "block w-full rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors disabled:opacity-60",
          drag ? "border-brand-400 bg-brand-50" : "border-border bg-bg hover:border-brand-300",
        )}
      >
        <Upload aria-hidden className="mx-auto mb-1.5 size-5 text-ink-muted" />
        <span className="block text-[0.875rem] font-medium text-ink">Drop files here or click to browse</span>
        <span className="mt-0.5 block text-[0.75rem] text-ink-muted">
          CSV, TSV, Excel (.xlsx), Parquet or PDF — up to 25 MB each, {MAX_UPLOAD_FILES} at a time. Each Excel sheet
          becomes its own table; scanned PDFs can&rsquo;t be read.
        </span>
      </button>

      {picked.items.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {picked.items.map((p) => (
            <li
              key={p.key}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[0.75rem]",
                p.problem ? "border-danger/30 bg-danger-bg" : "border-border bg-surface",
              )}
            >
              <FileKindIcon name={p.file.name} />
              <span className="min-w-0 flex-1 truncate text-ink">{p.file.name}</span>
              {p.problem ? (
                <span className="text-danger">{p.problem}</span>
              ) : (
                <span className="text-ink-muted">{formatBytes(p.file.size)}</span>
              )}
              <button
                type="button"
                disabled={disabled}
                onClick={() => picked.remove(p.key)}
                className="rounded p-0.5 text-ink-muted hover:bg-bg hover:text-ink"
                aria-label={`Remove ${p.file.name}`}
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function FileKindIcon({ name }: { name: string }) {
  return name.toLowerCase().endsWith(".pdf") ? (
    <FileText aria-hidden className="size-3.5 shrink-0 text-danger" />
  ) : (
    <FileSpreadsheet aria-hidden className="size-3.5 shrink-0 text-success" />
  );
}
