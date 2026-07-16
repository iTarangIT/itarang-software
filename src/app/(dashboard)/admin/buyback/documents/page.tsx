"use client";

/**
 * Documents — per-deal document center, direction matrix (design handoff,
 * iTarang Portal.dc.html `scrDocuments`, lines 983-1005).
 *
 * E-192: the request picker is the shared AdminBuybackSearch typeahead (hits
 * `/api/admin/buyback/search?q=`, ≥2 chars). Once picked, the search box is
 * swapped for a small "request_no — firm" note with a "Change" affordance.
 *
 * V5/V6 (documents redesign) — an admin who knows only the dealer now has a
 * path in, without a request/RC/TXN number:
 *
 *  · Recent-docs dropdown: focusing the search box with <2 chars typed opens a
 *    panel of the 8 most recent formal documents network-wide
 *    (`/api/admin/buyback/documents/recent`); clicking one selects that request
 *    (the classic per-request matrix). ≥2 chars hands back to the typeahead.
 *  · Dealer directory: when nothing is picked, a searchable, paginated table of
 *    every dealer with a buyback request (`/documents/dealers`).
 *  · Dealer view: picking a dealer shows all their deals' document sets at once
 *    (`/documents/dealers/[entityId]`), each with the same DocPreviewCard grid
 *    and missing-docs banner; a section header jumps to the classic view.
 *
 * The per-request set comes from `/api/admin/buyback/requests/:id/documents`
 * (each document carries its `direction`, plus `missing` — the kinds M15's AC
 * requires by CLOSED). The dealer view embeds that same set per deal, built by
 * the shared `buildDealDocumentSet` lib so the two surfaces never drift.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Card, DocPreviewCard, EmptyState, PageHeader } from "@/components/buyback/ui";
import AdminBuybackSearch, { type SearchHit } from "@/components/buyback/AdminBuybackSearch";
import StatusChip from "@/components/buyback/StatusChip";

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

interface RecentItem {
  doc_type: string;
  request_id: string;
  request_no: string;
  dealer_name: string | null;
  ts: string;
}

interface DirItem {
  entity_id: string;
  name: string | null;
  requests: number;
  docs: number;
  last_doc_at: string | null;
}

interface DealerViewDeal {
  request_id: string;
  request_no: string;
  status: string;
  created_at: string;
  documents: DocumentsResponse;
}

interface DealerView {
  dealer: { entity_id: string; name: string | null };
  deals: DealerViewDeal[];
}

const DIRECTION_LABEL: Record<Direction, string> = {
  ITARANG_TO_DEALER: "iTarang → Dealer",
  DEALER_TO_ITARANG: "Dealer → iTarang",
  ITARANG_TO_VENDOR: "iTarang → Vendor",
  VENDOR_TO_ITARANG: "Vendor → iTarang",
};

const DOC_TYPE_LABEL: Record<string, string> = {
  quotation: "Quotation",
  po_dealer: "PO · Dealer",
  po_vendor: "PO · Vendor",
  invoice_dealer: "Invoice · Dealer",
  invoice_vendor: "Invoice · Vendor",
  proof_dealer: "Proof · Dealer",
  proof_vendor: "Proof · Vendor",
  eway_bill: "E-way bill",
  weighbridge_slip: "Weighbridge",
};

function humanDocType(t: string): string {
  return DOC_TYPE_LABEL[t] ?? t;
}

/** "15 Jul 2026" — a stable absolute date. */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/** "3h ago" / "2d ago" — relative, for the recent-docs feed. */
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

/** The present documents of a set as a card grid, plus the missing-docs banner. */
function DocSet({
  documents,
  missing,
  compact,
}: {
  documents: DocumentEntry[];
  missing: string[];
  compact?: boolean;
}) {
  const present = documents.filter((d) => d.present);
  // Read the missing labels off the SAME documents array (every required kind
  // has an entry whether present or not) rather than a second lookup table.
  const missingLabels = missing.map(
    (kind) => documents.find((d) => d.kind === kind)?.label ?? kind,
  );

  return (
    <>
      {missing.length > 0 && (
        <div className="mb-4 rounded-[10px] border border-amber-300 bg-amber-50 px-4 py-3">
          <div className="text-[12px] font-bold uppercase tracking-wide text-amber-700">
            Missing documents
          </div>
          <p className="mt-1 text-[13px] text-amber-900">{missingLabels.join(", ")}</p>
        </div>
      )}

      {present.length === 0 ? (
        compact ? (
          <p className="px-1 py-2 text-[13px] text-slate-400">No documents yet.</p>
        ) : (
          <EmptyState
            icon="📄"
            title="No documents yet"
            body="Nothing has been generated or received for this deal."
          />
        )
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {present.map((d, i) => (
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
  );
}

export default function AdminBuybackDocumentsPage() {
  const router = useRouter();
  const [selected, setSelected] = useState("");
  const [selectedNote, setSelectedNote] = useState<{ requestNo: string; dealer: string } | null>(null);

  const [docs, setDocs] = useState<DocumentsResponse | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Recent-docs dropdown (opens on focus with <2 chars typed).
  const [recentOpen, setRecentOpen] = useState(false);
  const [typedLen, setTypedLen] = useState(0);
  const [recentItems, setRecentItems] = useState<RecentItem[] | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);

  // Dealer directory.
  const [dirQ, setDirQ] = useState("");
  const [dirItems, setDirItems] = useState<DirItem[]>([]);
  const [dirPage, setDirPage] = useState(0);
  const [dirHasMore, setDirHasMore] = useState(false);
  const [dirLoading, setDirLoading] = useState(false);

  // Dealer view.
  const [dealerId, setDealerId] = useState("");
  const [dealerView, setDealerView] = useState<DealerView | null>(null);
  const [dealerLoading, setDealerLoading] = useState(false);
  const [dealerError, setDealerError] = useState<string | null>(null);

  const selectRequest = (requestId: string, requestNo: string, dealer: string) => {
    setSelected(requestId);
    setSelectedNote({ requestNo, dealer: dealer || "—" });
    setRecentOpen(false);
  };

  // Only REQUEST hits are meaningful for this screen — a vendor or transaction
  // hit falls back to the search component's own default: navigate to its href.
  const handleSelect = (hit: SearchHit) => {
    if (hit.kind !== "request") {
      router.push(hit.href);
      return;
    }
    const [dealer] = (hit.sublabel ?? "").split(" · ");
    selectRequest(hit.id, hit.label, dealer || "—");
  };

  const changeRequest = () => {
    setSelected("");
    setSelectedNote(null);
  };

  // Lazy-fetch the recent feed once, on first focus.
  const openRecent = () => {
    setRecentOpen(true);
    if (recentItems === null && !recentLoading) {
      setRecentLoading(true);
      fetch("/api/admin/buyback/documents/recent?limit=8")
        .then((r) => r.json())
        .then((j) => setRecentItems(j?.success === false ? [] : (j?.data?.items ?? [])))
        .catch(() => setRecentItems([]))
        .finally(() => setRecentLoading(false));
    }
  };

  // Classic per-request document set.
  useEffect(() => {
    let cancelled = false;

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

  // Dealer directory — debounced on the search box; only while it is visible.
  useEffect(() => {
    if (selected || dealerId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      setDirLoading(true);
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 300);
      });
      if (cancelled) return;

      try {
        const res = await fetch(
          `/api/admin/buyback/documents/dealers?q=${encodeURIComponent(dirQ.trim())}&page=0`,
        );
        const j = await res.json();
        if (cancelled) return;
        const data = j?.success === false ? null : j?.data;
        setDirItems(data?.items ?? []);
        setDirPage(0);
        setDirHasMore(Boolean(data?.has_more));
      } catch {
        if (!cancelled) setDirItems([]);
      } finally {
        if (!cancelled) setDirLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [dirQ, selected, dealerId]);

  // Dealer view — all of one dealer's deals with their full document sets.
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!dealerId) {
        setDealerView(null);
        return;
      }

      setDealerLoading(true);
      setDealerError(null);

      try {
        const res = await fetch(
          `/api/admin/buyback/documents/dealers/${encodeURIComponent(dealerId)}`,
        );
        const j = await res.json();
        if (cancelled) return;
        if (j?.success === false) {
          setDealerError(j?.error?.message ?? "Could not load this dealer's documents.");
          setDealerView(null);
          return;
        }
        setDealerView(j?.data ?? null);
      } catch {
        if (!cancelled) setDealerError("Could not load this dealer's documents.");
      } finally {
        if (!cancelled) setDealerLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [dealerId]);

  const loadMoreDealers = async () => {
    const next = dirPage + 1;
    setDirLoading(true);
    try {
      const res = await fetch(
        `/api/admin/buyback/documents/dealers?q=${encodeURIComponent(dirQ.trim())}&page=${next}`,
      );
      const j = await res.json();
      const data = j?.success === false ? null : j?.data;
      setDirItems((prev) => [...prev, ...(data?.items ?? [])]);
      setDirPage(next);
      setDirHasMore(Boolean(data?.has_more));
    } catch {
      // keep what we have
    } finally {
      setDirLoading(false);
    }
  };

  const dealerTotals = useMemo(() => {
    if (!dealerView) return { deals: 0, docs: 0 };
    return {
      deals: dealerView.deals.length,
      docs: dealerView.deals.reduce(
        (sum, d) => sum + d.documents.documents.filter((x) => x.present).length,
        0,
      ),
    };
  }, [dealerView]);

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader title="Documents" sub="Per-deal document center — direction matrix" />

        {!selected && (
          <div className="mb-5">
            <span className="mb-1 block text-[12px] font-semibold text-slate-600">Request</span>
            <div
              className="relative w-fit"
              onFocus={openRecent}
              onBlur={() => setRecentOpen(false)}
              onChange={(e) => setTypedLen((e.target as HTMLInputElement).value?.length ?? 0)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setRecentOpen(false);
              }}
            >
              <AdminBuybackSearch onSelect={handleSelect} />

              {recentOpen && typedLen < 2 && (
                <div
                  // mousedown-preventDefault keeps the input from blurring (which
                  // would close this panel) before a row's click registers.
                  onMouseDown={(e) => e.preventDefault()}
                  className="absolute left-0 top-[calc(100%+4px)] z-20 w-[340px] max-w-[90vw] overflow-hidden rounded-[10px] border border-gray-200 bg-white shadow-[0_4px_14px_rgba(15,23,42,.10)]"
                >
                  <div className="border-b border-[#F4F6F9] px-3.5 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">
                    Recent documents
                  </div>
                  {recentLoading ? (
                    <div className="px-3.5 py-3 text-[12.5px] text-slate-400">Loading…</div>
                  ) : !recentItems || recentItems.length === 0 ? (
                    <div className="px-3.5 py-3 text-[12.5px] text-slate-400">
                      No documents yet.
                    </div>
                  ) : (
                    recentItems.map((it, i) => (
                      <button
                        key={`${it.request_id}-${it.doc_type}-${i}`}
                        type="button"
                        onClick={() =>
                          selectRequest(it.request_id, it.request_no, it.dealer_name ?? "—")
                        }
                        className="flex w-full items-center justify-between gap-2 border-b border-[#F4F6F9] px-3.5 py-2.5 text-left last:border-b-0 hover:bg-slate-50"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 rounded-full bg-[#EEF2F7] px-2 py-[2px] text-[10px] font-bold text-slate-500">
                              {humanDocType(it.doc_type)}
                            </span>
                            <span className="font-bold text-slate-900">{it.request_no}</span>
                          </div>
                          <div className="mt-0.5 truncate text-[11.5px] text-slate-400">
                            {it.dealer_name ?? "—"}
                          </div>
                        </div>
                        <span className="shrink-0 text-[11px] text-slate-400">
                          {relativeTime(it.ts)}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {selected && selectedNote && (
          <div className="mb-5">
            <span className="mb-1 block text-[12px] font-semibold text-slate-600">Request</span>
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
          </div>
        )}

        {selected ? (
          // --- Classic per-request document center -----------------------------
          error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : docsLoading || !docs ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : (
            <>
              {/* Direction matrix — which leg issues what to whom. Static: the
                  schema fixes these directions, so it is accurate for every deal. */}
              <div className="mb-4 flex flex-wrap gap-3.5">
                <div className="flex-1 min-w-[240px] rounded-[10px] bg-[linear-gradient(135deg,#0B2239,#123a5c)] px-4 py-3 text-[12.5px] text-white">
                  <div className="font-bold">Dealer leg</div>
                  <div className="mt-1 text-[#9FB4C6]">iTarang issues PO → Dealer issues invoice</div>
                </div>
                <div className="flex-1 min-w-[240px] rounded-[10px] border border-gray-200 bg-white px-4 py-3 text-[12.5px] text-slate-600">
                  <div className="font-bold text-slate-900">Vendor leg</div>
                  <div className="mt-1">Vendor issues PO → iTarang issues invoice</div>
                </div>
              </div>

              <DocSet documents={docs.documents} missing={docs.missing} />
            </>
          )
        ) : dealerId ? (
          // --- Dealer view — all of one dealer's deals -------------------------
          dealerError ? (
            <p className="text-sm text-red-600">{dealerError}</p>
          ) : dealerLoading || !dealerView ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-[17px] font-bold text-slate-900">
                    {dealerView.dealer.name ?? "—"}
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-slate-500">
                    {dealerTotals.deals} deal{dealerTotals.deals === 1 ? "" : "s"} ·{" "}
                    {dealerTotals.docs} document{dealerTotals.docs === 1 ? "" : "s"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDealerId("")}
                  className="shrink-0 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  ← All dealers
                </button>
              </div>

              {dealerView.deals.length === 0 ? (
                <EmptyState
                  icon="📄"
                  title="No deals yet"
                  body="This dealer has no buyback requests."
                />
              ) : (
                <div className="space-y-4">
                  {dealerView.deals.map((deal) => (
                    <Card key={deal.request_id} className="p-4">
                      <button
                        type="button"
                        onClick={() =>
                          selectRequest(
                            deal.request_id,
                            deal.request_no,
                            dealerView.dealer.name ?? "—",
                          )
                        }
                        className="mb-3 flex w-full items-center justify-between gap-3 rounded-lg px-1 py-1 text-left hover:bg-slate-50"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="font-bold text-slate-900">{deal.request_no}</span>
                          <StatusChip status={deal.status} />
                        </div>
                        <span className="text-[12px] text-slate-400">
                          {fmtDate(deal.created_at)}
                        </span>
                      </button>

                      <DocSet
                        documents={deal.documents.documents}
                        missing={deal.documents.missing}
                        compact
                      />
                    </Card>
                  ))}
                </div>
              )}
            </>
          )
        ) : (
          // --- Dealer directory ------------------------------------------------
          <Card
            title="Dealers"
            action={
              <input
                value={dirQ}
                onChange={(e) => setDirQ(e.target.value)}
                placeholder="Search dealer…"
                className="w-[200px] rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[12.5px] font-normal text-slate-700 placeholder:text-slate-400"
              />
            }
          >
            {dirLoading && dirItems.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-400">Loading…</p>
            ) : dirItems.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-400">No dealers found.</p>
            ) : (
              <>
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-400">
                      <th className="px-4 py-2 font-semibold">Name</th>
                      <th className="px-4 py-2 font-semibold">Requests</th>
                      <th className="px-4 py-2 font-semibold">Documents</th>
                      <th className="px-4 py-2 font-semibold">Last document</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dirItems.map((d) => (
                      <tr
                        key={d.entity_id}
                        onClick={() => setDealerId(d.entity_id)}
                        className="cursor-pointer border-b border-slate-50 last:border-b-0 hover:bg-slate-50"
                      >
                        <td className="px-4 py-2.5 font-semibold text-slate-900">
                          {d.name ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{d.requests}</td>
                        <td className="px-4 py-2.5 text-slate-600">{d.docs}</td>
                        <td className="px-4 py-2.5 text-slate-500">
                          {d.last_doc_at ? fmtDate(d.last_doc_at) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {dirHasMore && (
                  <div className="border-t border-slate-100 px-4 py-3 text-center">
                    <button
                      type="button"
                      onClick={loadMoreDealers}
                      disabled={dirLoading}
                      className="rounded-lg border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {dirLoading ? "Loading…" : "Load more"}
                    </button>
                  </div>
                )}
              </>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
