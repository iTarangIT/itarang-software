"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, UploadCloud, RefreshCcw, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

type VerificationState =
  | "idle"
  | "uploading"
  | "processing"
  | "verified"
  | "rejected"
  | "reupload";

export type UploadCardValue = {
  id: string;
  label: string;
  file: File | null;
  previewUrl: string | null;
  verificationState: VerificationState;
  progress: number;
  uploadedAt?: string;
};

type Props = {
  label: string;
  hint?: string;
  value: UploadCardValue | null;
  onChange: (item: UploadCardValue) => void;
  error?: string;
};

function getBadgeClasses(status: VerificationState) {
  switch (status) {
    case "uploading":
      return "bg-blue-100 text-blue-700 border-blue-200";
    case "processing":
      return "bg-amber-100 text-amber-700 border-amber-200";
    case "verified":
      return "bg-green-100 text-green-700 border-green-200";
    case "rejected":
      return "bg-red-100 text-red-700 border-red-200";
    case "reupload":
      return "bg-orange-100 text-orange-700 border-orange-200";
    default:
      return "bg-slate-100 text-slate-600 border-slate-200";
  }
}

function getBadgeLabel(status: VerificationState) {
  switch (status) {
    case "uploading":
      return "Uploading";
    case "processing":
      return "Processing";
    case "verified":
      return "Verified";
    case "rejected":
      return "Rejected";
    case "reupload":
      return "Needs Re-upload";
    default:
      return "Not Uploaded";
  }
}

function getBadgeIcon(status: VerificationState) {
  switch (status) {
    case "uploading":
    case "processing":
      return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
    case "verified":
      return <CheckCircle2 className="h-3.5 w-3.5" />;
    case "rejected":
    case "reupload":
      return <AlertCircle className="h-3.5 w-3.5" />;
    default:
      return null;
  }
}

export default function FileUploadCard({ label, hint, value, onChange, error }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const currentValue = useMemo<UploadCardValue>(
    () =>
      value ?? {
        id: "",
        label,
        file: null,
        previewUrl: null,
        verificationState: "idle",
        progress: 0,
      },
    [label, value]
  );

  const handleFile = (file: File | null) => {
    if (!file) return;

    const previewUrl = URL.createObjectURL(file);

    const baseItem: UploadCardValue = {
      id: crypto.randomUUID(),
      label,
      file,
      previewUrl,
      verificationState: "uploading",
      progress: 20,
      uploadedAt: new Date().toISOString(),
    };

    onChange(baseItem);

    setTimeout(() => {
      onChange({
        ...baseItem,
        verificationState: "processing",
        progress: 65,
      });
    }, 700);

    setTimeout(() => {
      onChange({
        ...baseItem,
        verificationState: "verified",
        progress: 100,
      });
    }, 1600);
  };

  useEffect(() => {
    return () => {
      if (currentValue?.previewUrl) {
        URL.revokeObjectURL(currentValue.previewUrl);
      }
    };
  }, [currentValue?.previewUrl]);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <label className="block text-sm font-semibold text-[#173F63]">{label}</label>
          {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
        </div>

        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${getBadgeClasses(
            currentValue.verificationState
          )}`}
        >
          {getBadgeIcon(currentValue.verificationState)}
          {getBadgeLabel(currentValue.verificationState)}
        </span>
      </div>

      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          handleFile(e.dataTransfer.files?.[0] || null);
        }}
        className={`group relative overflow-hidden rounded-2xl border-2 border-dashed p-6 sm:p-7 transition-all cursor-pointer ${
          dragActive
            ? "border-[#1F5C8F] bg-blue-50 shadow-[0_0_0_4px_rgba(31,92,143,0.08)]"
            : "border-[#E3E8EF] bg-[#F9FBFD] hover:border-[#1F5C8F]/40 hover:bg-[#F4F8FC]"
        }`}
      >
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 rounded-2xl bg-white p-3 shadow-sm border border-[#E3E8EF]">
            <UploadCloud className="h-6 w-6 text-[#1F5C8F]" />
          </div>

          <p className="text-sm font-semibold text-slate-700">Drag file or click to upload</p>
          <p className="mt-1 text-xs text-slate-500">Secure upload for dealer onboarding</p>

          {currentValue.file ? (
            <div className="mt-5 w-full max-w-md">
              <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
                <span>Upload progress</span>
                <span>{currentValue.progress}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-[#1F5C8F] transition-all duration-300"
                  style={{ width: `${currentValue.progress}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/*,.pdf"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0] || null)}
        />
      </div>

      {currentValue.file ? (
        <div className="rounded-2xl border border-[#E3E8EF] bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="rounded-xl bg-[#F4F8FC] p-2 border border-[#E3E8EF]">
                <FileText className="h-5 w-5 text-[#1F5C8F]" />
              </div>

              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-800">{currentValue.file.name}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {(currentValue.file.size / 1024).toFixed(1)} KB
                </p>
                {currentValue.uploadedAt ? (
                  <p className="mt-1 text-xs text-slate-400">
                    Uploaded {new Date(currentValue.uploadedAt).toLocaleString()}
                  </p>
                ) : null}
              </div>
            </div>

            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-xl border border-[#E3E8EF] px-3 py-2 text-xs font-semibold text-[#1F5C8F] hover:bg-[#F4F8FC]"
            >
              <RefreshCcw className="h-3.5 w-3.5" />
              Replace
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
    </div>
  );
}