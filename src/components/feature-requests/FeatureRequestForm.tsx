"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PRIORITIES } from "@/lib/feature-requests/workflow";

import { MODULE_SUGGESTIONS } from "./api";
import { FilePicker, useFileUploads } from "./files";

export type FeatureRequestValues = {
  title: string;
  description: string;
  priority: string;
  module: string;
};

const EMPTY: FeatureRequestValues = { title: "", description: "", priority: "medium", module: "" };

const field =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";

/** Used to raise a request and to edit one that was sent back for changes. */
export function FeatureRequestForm({
  initial = EMPTY,
  submitLabel,
  filesLabel = "Attachments (optional)",
  busy,
  onSubmit,
  onCancel,
}: {
  initial?: FeatureRequestValues;
  submitLabel: string;
  filesLabel?: string;
  busy: boolean;
  onSubmit: (values: FeatureRequestValues, attachmentIds: string[]) => void;
  onCancel?: () => void;
}) {
  const [v, setV] = useState<FeatureRequestValues>(initial);
  const uploads = useFileUploads();
  const set = (k: keyof FeatureRequestValues) => (e: { target: { value: string } }) =>
    setV((cur) => ({ ...cur, [k]: e.target.value }));

  const valid = v.title.trim().length >= 3 && v.description.trim().length >= 10 && v.module.trim().length > 0;

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !uploads.busy) onSubmit(v, uploads.ids);
      }}
    >
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Title</label>
        <input className={field} value={v.title} onChange={set("title")} maxLength={200} placeholder="e.g. Bulk re-assign leads between ASMs" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Priority</label>
          <select className={field} value={v.priority} onChange={set("priority")}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p[0].toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Module</label>
          <input
            className={field}
            value={v.module}
            onChange={set("module")}
            list="fr-module-suggestions"
            maxLength={120}
            placeholder="Pick or type a module"
          />
          <datalist id="fr-module-suggestions">
            {MODULE_SUGGESTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
        <textarea
          className={`${field} min-h-[180px]`}
          value={v.description}
          onChange={set("description")}
          placeholder="What should it do, who is it for, and why does it matter?"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">{filesLabel}</label>
        <FilePicker uploads={uploads} />
      </div>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={!valid || busy || uploads.busy}>
          {(busy || uploads.busy) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {uploads.busy ? "Uploading…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
