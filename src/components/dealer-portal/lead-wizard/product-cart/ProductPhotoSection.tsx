"use client";

import { Plus, X } from "lucide-react";

import { SectionCard } from "@/components/dealer-portal/lead-wizard/shared";

/**
 * E-130 / Addendum V0.1 §5.1 — dealer-captured battery / charger photos.
 * Two named slots (serial close-up, unit photo) plus an unlimited "add
 * another" slot; each upload immediately returns a stored URL.
 */
export function ProductPhotoSection({
  title,
  subtitle,
  kind,
  urls,
  onAdd,
  onRemove,
  uploadingTag,
}: {
  title: string;
  subtitle: string;
  kind: "battery" | "charger";
  urls: string[];
  onAdd: (label: string, file: File) => Promise<void> | void;
  onRemove: (idx: number) => void;
  uploadingTag: string | null;
}) {
  const slots = [
    { label: "serial", caption: "Serial close-up" },
    { label: "unit", caption: "Unit photo" },
  ];
  return (
    <SectionCard title={title}>
      <p className="text-[11px] text-gray-400 mb-4 px-1">{subtitle}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {slots.map((slot) => {
          const isUploading = uploadingTag === `${kind}:${slot.label}`;
          return (
            <label
              key={slot.label}
              className={`flex flex-col items-center justify-center h-32 border-2 border-dashed rounded-xl cursor-pointer transition-all px-3 ${
                isUploading
                  ? "border-blue-300 bg-blue-50 cursor-wait"
                  : "border-gray-200 hover:border-[#0047AB] hover:bg-blue-50/30"
              }`}
            >
              <input
                type="file"
                accept="image/png,image/jpeg,image/jpg"
                className="hidden"
                disabled={isUploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onAdd(slot.label, file);
                  e.currentTarget.value = "";
                }}
              />
              {isUploading ? (
                <span className="text-xs font-bold text-blue-700">Uploading…</span>
              ) : (
                <>
                  <Plus className="w-5 h-5 text-gray-400 mb-1" />
                  <span className="text-xs font-bold text-gray-700">{slot.caption}</span>
                  <span className="text-[10px] text-gray-400 mt-0.5">JPG/PNG · 5 MB max</span>
                </>
              )}
            </label>
          );
        })}
        <label
          className={`flex flex-col items-center justify-center h-32 border-2 border-dashed rounded-xl cursor-pointer transition-all px-3 ${
            uploadingTag?.startsWith(`${kind}:extra_`)
              ? "border-blue-300 bg-blue-50 cursor-wait"
              : "border-gray-200 hover:border-[#0047AB] hover:bg-blue-50/30"
          }`}
        >
          <input
            type="file"
            accept="image/png,image/jpeg,image/jpg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onAdd(`extra_${Date.now()}`, file);
              e.currentTarget.value = "";
            }}
          />
          <Plus className="w-5 h-5 text-gray-400 mb-1" />
          <span className="text-xs font-bold text-gray-700">Add another</span>
          <span className="text-[10px] text-gray-400 mt-0.5">Optional</span>
        </label>
      </div>
      {urls.length > 0 && (
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {urls.map((url, idx) => (
            <div
              key={`${url}-${idx}`}
              className="relative aspect-square rounded-lg overflow-hidden border border-gray-200 bg-gray-50 group"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={`${title} ${idx + 1}`}
                className="w-full h-full object-cover"
              />
              <button
                type="button"
                onClick={() => onRemove(idx)}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label="Remove"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
