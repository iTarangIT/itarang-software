"use client";

/**
 * Documents — per-deal document center, direction matrix (design handoff,
 * iTarang Portal.dc.html `scrDocuments`, lines 983-1005).
 *
 * E-192: the request picker used to be a `<select>` populated from
 * `/api/admin/buyback/queue?scope=all` — every non-DRAFT deal ever, loaded
 * into one dropdown. At 10K+ dealers that is an unbounded full-history fetch
 * on every page load. Replaced with the shared AdminBuybackSearch typeahead
 * (the same one on the review queue's header), which hits
 * `/api/admin/buyback/search?q=` and only ever returns a handful of matches.
 * That component navigates by default; here it's used purely as a picker via
 * its `onSelect` override, so choosing a request stays on this page. Once
 * picked, the search box is swapped for a small "request_no — firm" note
 * with a "Change" affordance that brings the search box back.
 *
 * That matches this screen's own AC, "every CLOSED deal has the full set":
 * search still surfaces CLOSED/SETTLED/REJECTED/CANCELLED requests (the
 * search endpoint has no status filter at all, unlike the queue's default).
 *
 * Once a request is picked, `/api/admin/buyback/requests/:id/documents`
 * (read verbatim — not modified) returns every document the deal has
 * produced, each carrying its own `direction` (who issued it to whom), plus
 * `missing` — the kinds still absent that M15's AC requires by CLOSED.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { DocPreviewCard, EmptyState, PageHeader } from "@/components/buyback/ui";
import AdminBuybackSearch, { type SearchHit } from "@/components/buyback/AdminBuybackSearch";

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
  const router = useRouter();
  const [selected, setSelected] = useState("");
  // E-192 — the picker's own note ("BB-1024 — Acme Traders"), captured
  // straight off the picked search hit rather than a second lookup that
  // could drift from what the search endpoint itself displayed.
  const [selectedNote, setSelectedNote] = useState<{ requestNo: string; dealer: string } | null>(null);

  const [docs, setDocs] = useState<DocumentsResponse | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only REQUEST hits are meaningful for this screen (this is a per-request
  // document center, not a vendor/transaction one) — a vendor or transaction
  // hit falls back to the search component's own default: navigate to its href.
  const handleSelect = (hit: SearchHit) => {
    if (hit.kind !== "request") {
      router.push(hit.href);
      return;
    }
    const [dealer] = (hit.sublabel ?? "").split(" · ");
    setSelected(hit.id);
    setSelectedNote({ requestNo: hit.label, dealer: dealer || "—" });
  };

  const changeRequest = () => {
    setSelected("");
    setSelectedNote(null);
  };

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
          <span className="mb-1 block text-[12px] font-semibold text-slate-600">Request</span>
          {selected && selectedNote ? (
            <div className="flex max-w-md items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm">
              <span className="text-slate-700">
                <span className="font-bold text-slate-900">{selectedNote.requestNo}</span>
                {" — "}
                {selectedNote.dealer}
              </span>
              <button
                type="button"
                onClick={changeRequest}
                className="shrink-0 text-xs font-semibold text-blue-600 hover:underline"
              >
                Change
              </button>
            </div>
          ) : (
            <AdminBuybackSearch onSelect={handleSelect} />
          )}
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
