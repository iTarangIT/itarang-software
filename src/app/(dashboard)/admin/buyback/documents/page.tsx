"use client";

/**
 * Documents — per-deal document center, direction matrix (design handoff,
 * iTarang Portal.dc.html `scrDocuments`, lines 983-1005).
 *
 * The request picker is populated from `/api/admin/buyback/queue` — which
 * means, by that endpoint's own WHERE clause, only NON-terminal deals are
 * selectable here (DRAFT/CLOSED/SETTLED/REJECTED/CANCELLED never appear in
 * the queue). That is a real limitation for a screen whose underlying API's
 * own AC is "every CLOSED deal has the full set" — a CLOSED deal's document
 * set cannot be reached from this picker. Constraints for this task are
 * "documents/search/... endpoints consumed as-is" and "ONLY Ext-5/Ext-6"
 * change, so widening the picker's source is out of scope here.
 *
 * Once a request is picked, `/api/admin/buyback/requests/:id/documents`
 * (read verbatim — not modified) returns every document the deal has
 * produced, each carrying its own `direction` (who issued it to whom), plus
 * `missing` — the kinds still absent that M15's AC requires by CLOSED.
 */

import { useEffect, useMemo, useState } from "react";

import { DocPreviewCard, EmptyState, PageHeader } from "@/components/buyback/ui";

interface QueueRow {
  request_id: string;
  request_no: string;
  dealer_name: string;
}

type Direction = "ITARANG_TO_DEALER" | "DEALER_TO_ITARANG" | "ITARANG_TO_VENDOR" | "VENDOR_TO_ITARANG";

interface DocumentEntry {
  kind: string;
  label: string;
  direction: Direction;
  number: string | null;
  status: string | null;
  s3_key: string | null;
  href: string | null;
  present: boolean;
}

interface DocumentsResponse {
  request_id: string;
  request_no: string;
  status: string;
  documents: DocumentEntry[];
  complete: boolean;
  missing: string[];
  ac_breach: boolean;
}

const DIRECTION_LABEL: Record<Direction, string> = {
  ITARANG_TO_DEALER: "iTarang → Dealer",
  DEALER_TO_ITARANG: "Dealer → iTarang",
  ITARANG_TO_VENDOR: "iTarang → Vendor",
  VENDOR_TO_ITARANG: "Vendor → iTarang",
};

export default function AdminBuybackDocumentsPage() {
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [selected, setSelected] = useState("");

  const [docs, setDocs] = useState<DocumentsResponse | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/buyback/queue?scope=all")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setQueue(j?.data?.queue ?? []);
      })
      .finally(() => {
        if (!cancelled) setQueueLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    // setState calls live inside this async function, not synchronously in
    // the effect body — keeps react-hooks/set-state-in-effect happy (same
    // pattern as ScoreExplainabilityDrawer's `run()`).
    const run = async () => {
      if (!selected) {
        setDocs(null);
        return;
      }

      setDocsLoading(true);
      setError(null);

      try {
        const res = await fetch(`/api/admin/buyback/requests/${selected}/documents`);
        const j = await res.json();
        if (cancelled) return;
        if (j?.success === false) {
          setError(j?.error?.message ?? "Could not load this deal's documents.");
          setDocs(null);
          return;
        }
        setDocs(j?.data ?? null);
      } catch {
        if (!cancelled) setError("Could not load this deal's documents.");
      } finally {
        if (!cancelled) setDocsLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Every present document, as a preview card.
  const presentDocs = useMemo(() => (docs ? docs.documents.filter((d) => d.present) : []), [docs]);

  // Human labels for the missing kinds, read off the SAME documents array
  // (every required kind has an entry whether present or not) rather than a
  // second lookup table that could drift from the API's own labels.
  const missingLabels = useMemo(() => {
    if (!docs) return [];
    return docs.missing.map((kind) => docs.documents.find((d) => d.kind === kind)?.label ?? kind);
  }, [docs]);

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader title="Documents" sub="Per-deal document center — direction matrix" />

        <div className="mb-5">
          <label className="block max-w-md">
            <span className="text-[12px] font-semibold text-slate-600">Request</span>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={queueLoading}
              className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-slate-700"
            >
              <option value="">
                {queueLoading ? "Loading requests…" : "Select a request…"}
              </option>
              {queue.map((r) => (
                <option key={r.request_id} value={r.request_id}>
                  {r.request_no} — {r.dealer_name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!selected ? (
          <EmptyState icon="📄" title="Pick a deal" body="Choose a request to see its document set." />
        ) : error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : docsLoading || !docs ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          <>
            {/* Direction matrix — which leg issues what to whom. Static text:
                the schema fixes these directions (po_dealer is always
                ITARANG_TO_DEALER, invoice_dealer always DEALER_TO_ITARANG,
                and the mirror image on the vendor leg), so this is accurate
                for every deal, not just the selected one. */}
            <div className="mb-4 flex flex-wrap gap-3.5">
              <div className="flex-1 min-w-[240px] rounded-[10px] bg-[linear-gradient(135deg,#0B2239,#123a5c)] px-4 py-3 text-[12.5px] text-white">
                <div className="font-bold">Dealer leg</div>
                <div className="mt-1 text-[#9FB4C6]">
                  iTarang issues PO → Dealer issues invoice
                </div>
              </div>
              <div className="flex-1 min-w-[240px] rounded-[10px] border border-gray-200 bg-white px-4 py-3 text-[12.5px] text-slate-600">
                <div className="font-bold text-slate-900">Vendor leg</div>
                <div className="mt-1">Vendor issues PO → iTarang issues invoice</div>
              </div>
            </div>

            {docs.missing.length > 0 && (
              <div className="mb-4 rounded-[10px] border border-amber-300 bg-amber-50 px-4 py-3">
                <div className="text-[12px] font-bold uppercase tracking-wide text-amber-700">
                  Missing documents
                </div>
                <p className="mt-1 text-[13px] text-amber-900">{missingLabels.join(", ")}</p>
              </div>
            )}

            {presentDocs.length === 0 ? (
              <EmptyState
                icon="📄"
                title="No documents yet"
                body="Nothing has been generated or received for this deal."
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {presentDocs.map((d, i) => (
                  <DocPreviewCard
                    key={`${d.kind}-${i}`}
                    title={d.label}
                    docNumber={d.number ?? "—"}
                    badge={d.status ?? undefined}
                    rows={[["Direction", DIRECTION_LABEL[d.direction]]]}
                    action={
                      d.href ? (
                        <a
                          href={d.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          View PDF
                        </a>
                      ) : undefined
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
