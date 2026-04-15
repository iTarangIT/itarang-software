"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  UploadCloud,
  RefreshCcw,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Eye,
} from "lucide-react";

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
  uploadedUrl?: string | null;
  storagePath?: string | null;
  bucketName?: string | null;
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
      return "border-blue-200 bg-blue-50 text-blue-700";
    case "processing":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "verified":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "rejected":
      return "border-red-200 bg-red-50 text-red-700";
    case "reupload":
      return "border-orange-200 bg-orange-50 text-orange-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-600";
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

function makeFolderName(label: string) {
  return label
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function FileUploadCard({
  label,
  hint,
  value,
  onChange,
  error,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const currentValue = useMemo<UploadCardValue>(
    () =>
      value ?? {
        id: "",
        label,
        file: null,
        previewUrl: null,
        uploadedUrl: null,
        storagePath: null,
        bucketName: null,
        verificationState: "idle",
        progress: 0,
      },
    [label, value]
  );

  const handleFile = async (file: File | null) => {
    if (!file) return;

    const allowedTypes = [
      "application/pdf",
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
    ];

    if (!allowedTypes.includes(file.type)) {
      onChange({
        id: crypto.randomUUID(),
        label,
        file,
        previewUrl: null,
        uploadedUrl: null,
        storagePath: null,
        bucketName: null,
        verificationState: "reupload",
        progress: 0,
        uploadedAt: new Date().toISOString(),
      });
      return;
    }

    const previewUrl = URL.createObjectURL(file);

    const baseItem: UploadCardValue = {
      id: crypto.randomUUID(),
      label,
      file,
      previewUrl,
      uploadedUrl: null,
      storagePath: null,
      bucketName: null,
      verificationState: "uploading",
      progress: 15,
      uploadedAt: new Date().toISOString(),
    };

    onChange(baseItem);

    try {
      onChange({
        ...baseItem,
        verificationState: "uploading",
        progress: 35,
      });

      const formData = new FormData();
      formData.append("file", file);
      formData.append("folder", makeFolderName(label));

      const response = await fetch("/api/uploads/dealer-documents", {
        method: "POST",
        body: formData,
      });

      onChange({
        ...baseItem,
        verificationState: "processing",
        progress: 70,
      });

      const result = await response.json();

      if (!response.ok || !result?.success) {
        onChange({
          ...baseItem,
          verificationState: "reupload",
          progress: 0,
          uploadedUrl: null,
          storagePath: null,
          bucketName: null,
        });
        return;
      }

      onChange({
        ...baseItem,
        uploadedUrl: result.file?.url ?? null,
        storagePath: result.file?.path ?? null,
        bucketName: result.file?.bucketName ?? "dealer-documents",
        verificationState: "verified",
        progress: 100,
      });
    } catch (uploadError) {
      console.error("File upload failed:", uploadError);

      onChange({
        ...baseItem,
        verificationState: "reupload",
        progress: 0,
        uploadedUrl: null,
        storagePath: null,
        bucketName: null,
      });
    }
  };

  const handleReplace = () => {
    inputRef.current?.click();
  };

  useEffect(() => {
    return () => {
      if (currentValue?.previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(currentValue.previewUrl);
      }
    };
  }, [currentValue?.previewUrl]);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <label className="block text-sm font-semibold text-[#173F63]">
            {label}
          </label>
          <p className="mt-1 text-xs text-slate-500">
            {hint || "Drag file or click to upload"}
          </p>
        </div>

        <span
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${getBadgeClasses(
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
        className={`group relative cursor-pointer overflow-hidden rounded-2xl border-2 border-dashed p-6 transition-all sm:p-7 ${
          dragActive
            ? "border-[#1F5C8F] bg-blue-50 shadow-[0_0_0_4px_rgba(31,92,143,0.08)]"
            : "border-[#E3E8EF] bg-[#F9FBFD] hover:border-[#1F5C8F]/40 hover:bg-[#F4F8FC]"
        }`}
      >
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 rounded-2xl border border-[#E3E8EF] bg-white p-3 shadow-sm">
            <UploadCloud className="h-6 w-6 text-[#1F5C8F]" />
          </div>

          <p className="text-sm font-semibold text-slate-700">
            Drag file or click to upload
          </p>
          <p className="mt-1 text-xs text-slate-500">
            PDF, JPG, JPEG, PNG, WEBP supported
          </p>

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
          accept=".pdf,image/jpeg,image/jpg,image/png,image/webp"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0] || null)}
        />
      </div>

      {currentValue.file ? (
        <div className="rounded-2xl border border-[#E3E8EF] bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="rounded-xl border border-[#E3E8EF] bg-[#F4F8FC] p-2">
                <FileText className="h-5 w-5 text-[#1F5C8F]" />
              </div>

              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-800">
                  {currentValue.file.name}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {(currentValue.file.size / 1024).toFixed(1)} KB
                </p>

                {currentValue.uploadedAt ? (
                  <p className="mt-1 text-xs text-slate-400">
                    Uploaded {new Date(currentValue.uploadedAt).toLocaleString()}
                  </p>
                ) : null}

                <div className="mt-2 flex flex-wrap items-center gap-3">
                  {/* {currentValue.previewUrl ? (
                    <a
                      href={currentValue.previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Eye className="h-3.5 w-3.5" />
                      Preview file
                    </a>
                  ) : null} */}

                  {currentValue.uploadedUrl ? (
                    <a
                      href={currentValue.uploadedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#1F5C8F] hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Eye className="h-3.5 w-3.5" />
                      View uploaded file
                    </a>
                  ) : null}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleReplace();
              }}
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