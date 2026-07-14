"use client";

/**
 * Admin buyback search box (M23) — a small, self-contained client component
 * so the queue page's PageHeader right-slot stays a one-line JSX call.
 *
 * Hits `/api/admin/buyback/search?q=` (admin-only endpoint, read verbatim —
 * see src/app/api/admin/buyback/search/route.ts for the exact response
 * shape: `{ query, hits: [{ kind, id, label, sublabel, href }] }`). Every hit
 * already carries its own `href` — request/vendor/transaction hits all point
 * somewhere sensible on their own, so this component just navigates there
 * rather than assuming everything is a request.
 *
 * The search covers three kinds of hit (request/vendor/transaction), but only
 * REQUEST hits carry a status — its `sublabel` is built server-side as
 * `[dealer, status].filter(Boolean).join(" · ")`, so it is split back apart
 * here to render "request_no bold + firm + StatusChip" exactly as specified.
 * Vendor/transaction hits have no status to show, so they render their
 * label/sublabel plainly with a small kind badge instead.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import StatusChip from "./StatusChip";

interface SearchHit {
  kind: "request" | "vendor" | "transaction";
  id: string;
  label: string;
  sublabel: string | null;
  href: string;
}

const DEBOUNCE_MS = 350;

export default function AdminBuybackSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // setState calls live inside this async function, not synchronously in
    // the effect body — keeps react-hooks/set-state-in-effect happy (same
    // pattern as ScoreExplainabilityDrawer's `run()`).
    const run = async () => {
      const query = q.trim();
      if (query.length < 2) {
        setHits([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DEBOUNCE_MS);
      });
      if (cancelled) return;

      try {
        const res = await fetch(`/api/admin/buyback/search?q=${encodeURIComponent(query)}`);
        const j = await res.json();
        if (cancelled) return;
        setHits(j?.success === false ? [] : (j?.data?.hits ?? []));
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [q]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const go = (hit: SearchHit) => {
    setOpen(false);
    router.push(hit.href);
  };

  return (
    <div ref={containerRef} className="relative w-[280px]">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search request, dealer, RC, TXN…"
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[12.5px] text-slate-700 placeholder:text-slate-400"
      />

      {open && q.trim().length >= 2 && (
        <div className="absolute right-0 top-[calc(100%+4px)] z-20 w-full min-w-[280px] overflow-hidden rounded-[10px] border border-gray-200 bg-white shadow-[0_4px_14px_rgba(15,23,42,.10)]">
          {loading ? (
            <div className="px-3.5 py-3 text-[12.5px] text-slate-400">Searching…</div>
          ) : hits.length === 0 ? (
            <div className="px-3.5 py-3 text-[12.5px] text-slate-400">No matches.</div>
          ) : (
            hits.map((h) => {
              // Request hits: "dealer · STATUS" (server-built) — split back
              // apart so the dealer renders as plain text and the status as
              // a real StatusChip, per spec.
              const [dealer, status] = h.kind === "request" ? (h.sublabel ?? "").split(" · ") : [];

              return (
                <button
                  key={`${h.kind}-${h.id}`}
                  type="button"
                  onClick={() => go(h)}
                  className="flex w-full items-center justify-between gap-2 border-b border-[#F4F6F9] px-3.5 py-2.5 text-left last:border-b-0 hover:bg-slate-50"
                >
                  {h.kind === "request" ? (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900">{h.label}</span>
                        <span className="text-[11.5px] text-slate-400">{dealer}</span>
                      </div>
                      {status && <StatusChip status={status} />}
                    </>
                  ) : (
                    <>
                      <div>
                        <div className="text-[12.5px] font-bold text-slate-900">{h.label}</div>
                        {h.sublabel && <div className="text-[11px] text-slate-400">{h.sublabel}</div>}
                      </div>
                      <span className="shrink-0 rounded-full bg-[#EEF2F7] px-2 py-[2px] text-[10px] font-bold uppercase text-slate-500">
                        {h.kind}
                      </span>
                    </>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
