"use client";

import { useEffect, useState } from "react";

interface ConsentPdfViewerModalProps {
  open: boolean;
  onClose: () => void;
  pdfUrl: string;
  title: string;
}

export default function ConsentPdfViewerModal({
  open,
  onClose,
  pdfUrl,
  title,
}: ConsentPdfViewerModalProps) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900 capitalize">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-900 text-xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 relative bg-gray-50">
          {loading && !failed && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500">
              Loading PDF…
            </div>
          )}
          {failed ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm">
              <p className="text-gray-700">Failed to load PDF in viewer.</p>
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline break-all px-6 text-center"
              >
                Open in new tab: {pdfUrl}
              </a>
            </div>
          ) : (
            <iframe
              src={pdfUrl}
              title={title}
              className="w-full h-full"
              onLoad={() => setLoading(false)}
              onError={() => {
                setLoading(false);
                setFailed(true);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
