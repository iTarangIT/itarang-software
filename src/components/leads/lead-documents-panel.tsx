"use client";

/**
 * "Documents & photos" tab on the dealer-lead page (E-311): documents filed on
 * the lead (today from the WhatsApp Sales Assistant) and the photos taken on
 * its visits. View-only — files open in a new tab through /api/files, which
 * needs the CRM session. Data: GET /api/dealer-leads/[id]/documents.
 */
import { useQuery } from "@tanstack/react-query";
import { Camera, FileText, Loader2, MessageCircle, Paperclip } from "lucide-react";

import type { LeadDocuments } from "@/app/api/dealer-leads/[id]/documents/route";

type ApiResult = { success: true; data: LeadDocuments } | { success: false; error?: { message?: string } };

const DOC_TYPE_LABEL: Record<string, string> = {
    gst_certificate: "GST certificate",
    pan: "PAN card",
    shop_licence: "Shop licence",
    shop_photo: "Shop photo",
    visiting_card: "Visiting card",
    purchase_order: "Purchase order",
    other: "Document",
};

const when = (iso: string | null) =>
    iso
        ? new Date(iso).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
              day: "numeric",
              month: "short",
              year: "numeric",
              ...(iso.length > 10 ? { hour: "2-digit", minute: "2-digit" } : {}),
          })
        : "—";

function Thumb({ url, mime, label }: { url: string; mime: string | null; label: string }) {
    const isPdf = mime === "application/pdf" || /\.pdf($|\?)/i.test(url);
    return (
        <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-gray-200 bg-gray-50 hover:border-gray-400"
            title={`Open ${label}`}
        >
            {isPdf ? (
                <FileText className="h-8 w-8 text-red-500" />
            ) : (
                // eslint-disable-next-line @next/next/no-img-element -- auth'd proxy URL, not an optimisable asset
                <img src={url} alt={label} className="h-full w-full object-cover" loading="lazy" />
            )}
        </a>
    );
}

export function LeadDocumentsPanel({ leadId }: { leadId: string }) {
    const q = useQuery<{ status: number; body: ApiResult }>({
        queryKey: ["lead-documents", leadId],
        queryFn: async () => {
            const res = await fetch(`/api/dealer-leads/${encodeURIComponent(leadId)}/documents`, { cache: "no-store" });
            let body: ApiResult;
            try {
                body = (await res.json()) as ApiResult;
            } catch {
                body = { success: false, error: { message: "Could not load documents." } };
            }
            return { status: res.status, body };
        },
        staleTime: 30 * 1000,
    });

    if (q.isLoading) {
        return (
            <div className="flex items-center gap-2 px-6 py-6 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading documents…
            </div>
        );
    }
    if (!q.data || !q.data.body.success) {
        const message =
            (q.data && !q.data.body.success && q.data.body.error?.message) || "Could not load documents.";
        return <div className="px-6 py-6 text-sm text-red-600">{message}</div>;
    }
    const { documents, visit_photos } = q.data.body.data;

    return (
        <div className="space-y-6 px-6 py-4">
            <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                    <Paperclip className="h-3.5 w-3.5 text-gray-500" /> Documents
                    <span className="text-xs font-normal text-gray-500">({documents.length})</span>
                </h3>
                {documents.length === 0 ? (
                    <p className="text-xs text-gray-500">
                        No documents yet. Reps can send a GST certificate, shop licence or visiting card to the
                        WhatsApp assistant to file it here.
                    </p>
                ) : (
                    <ul className="divide-y divide-gray-100">
                        {documents.map((d) => {
                            const label = DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type;
                            return (
                                <li key={d.id} className="flex items-start gap-3 py-2.5">
                                    <Thumb url={d.url} mime={d.mime_type} label={label} />
                                    <div className="min-w-0 text-xs">
                                        <div className="text-sm font-medium text-gray-900">{label}</div>
                                        {d.file_name && <div className="truncate text-gray-600">{d.file_name}</div>}
                                        {d.note && <div className="text-gray-700">{d.note}</div>}
                                        <div className="mt-0.5 flex items-center gap-1 text-gray-500">
                                            {d.source === "whatsapp_assistant" && <MessageCircle className="h-3 w-3" />}
                                            {d.uploaded_by_name ?? "Unknown"} · {when(d.created_at)}
                                            {d.source === "whatsapp_assistant" && " · via WhatsApp"}
                                        </div>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                    <Camera className="h-3.5 w-3.5 text-gray-500" /> Visit photos
                    <span className="text-xs font-normal text-gray-500">({visit_photos.length})</span>
                </h3>
                {visit_photos.length === 0 ? (
                    <p className="text-xs text-gray-500">No visit photos yet.</p>
                ) : (
                    <div className="flex flex-wrap gap-3">
                        {visit_photos.map((p, i) => (
                            <figure key={`${p.visit_id}-${i}`} className="w-20">
                                <Thumb url={p.url} mime={null} label="Visit photo" />
                                <figcaption className="mt-1 truncate text-[10px] text-gray-500">
                                    {when(p.visit_date)}
                                    {p.asm_name ? ` · ${p.asm_name}` : ""}
                                </figcaption>
                            </figure>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
