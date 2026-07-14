"use client";

/**
 * The evidence an admin reviews before accepting a request (M03/M04).
 *
 * Per battery line: every photo as a thumbnail, click to zoom; and the provenance
 * — who the previous owner was, and the ID proof that says the battery was theirs
 * to sell.
 *
 * WHY THE ID PROOF IS ON THIS SCREEN AND NOT BURIED IN A DOCUMENTS TAB:
 * it is the only thing standing between iTarang and buying a stolen battery. An
 * admin deciding whether to accept a request needs the photo and the proof in the
 * same glance — if checking provenance costs an extra click, it will be the click
 * that gets skipped on a busy afternoon, and the one time it mattered will be the
 * one time nobody looked.
 *
 * Every file is fetched through /api/buyback/media, which re-checks entitlement on
 * each request. The S3 key never reaches the browser.
 */

import { useEffect, useState } from "react";

import Lightbox, { type LightboxItem } from "./Lightbox";

interface Photo {
  id: string;
  unit_id: string | null;
  has_thumb: boolean;
}

interface Provenance {
  id: string;
  source_type: "PREV_OWNER_DOCS" | "DEALER_STOCK";
  prev_owner_name: string | null;
  prev_owner_phone: string | null;
  vehicle_no: string | null;
  id_proof_type: string | null;
  has_id_proof: boolean;
  has_purchase_proof: boolean;
}

interface LineEvidence {
  line_id: string;
  photos: Photo[];
  provenance: Provenance | null;
}

export default function EvidenceReview({
  requestId,
  labelForLine,
}: {
  requestId: string;
  /** The shared battery formatter's label, so this screen never invents its own. */
  labelForLine: (lineId: string) => string;
}) {
  const [lines, setLines] = useState<LineEvidence[]>([]);
  const [loading, setLoading] = useState(true);
  const [lightbox, setLightbox] = useState<{ items: LightboxItem[]; index: number } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const res = await fetch(`/api/buyback/requests/${requestId}/photos`);
      const json = await res.json();
      if (cancelled) return;
      setLines(json?.data?.lines ?? []);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [requestId]);

  if (loading) {
    return <div className="py-6 text-sm text-slate-400">Loading evidence…</div>;
  }

  const openPhotos = (line: LineEvidence, startAt: number) => {
    setLightbox({
      items: line.photos.map((p, i) => ({
        photoId: p.id,
        caption: `${labelForLine(line.line_id)} — photo ${i + 1} of ${line.photos.length}`,
      })),
      index: startAt,
    });
  };

  return (
    <div className="space-y-4">
      {lines.map((line) => {
        const prov = line.provenance;
        const stock = prov?.source_type === "DEALER_STOCK";

        return (
          <div key={line.line_id} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-bold text-slate-900">
                {labelForLine(line.line_id)}
              </div>
              <span
                className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${
                  line.photos.length >= 5
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-amber-50 text-amber-700"
                }`}
              >
                {line.photos.length} photo{line.photos.length === 1 ? "" : "s"}
              </span>
            </div>

            {/* --- Photos --- */}
            {line.photos.length === 0 ? (
              <p className="mt-3 text-xs text-slate-400">No photos on this line.</p>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {line.photos.map((photo, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={photo.id}
                    src={`/api/buyback/media?photo=${photo.id}&size=thumb`}
                    alt={`Battery photo ${i + 1}`}
                    onClick={() => openPhotos(line, i)}
                    title="Click to zoom"
                    className="h-20 w-20 cursor-zoom-in rounded-lg border border-slate-200 object-cover transition hover:border-slate-400"
                  />
                ))}
              </div>
            )}

            {/* --- Provenance --- */}
            <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 p-3">
              {!prov ? (
                // Submit is gated on provenance, so this should be unreachable on a
                // submitted request. If it ever shows, something has gone wrong that
                // an admin must not accept their way past.
                <p className="text-xs font-semibold text-red-600">
                  No provenance recorded on this line. Do not accept — this battery has
                  no traceable origin.
                </p>
              ) : stock ? (
                <p className="text-xs text-slate-600">
                  <b>Dealer&apos;s own stock.</b> Covered by the dealer&apos;s KYC already on
                  file.
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <Detail label="Previous owner" value={prov.prev_owner_name} />
                  <Detail label="Phone" value={prov.prev_owner_phone} />
                  <Detail label="Vehicle / RC" value={prov.vehicle_no} />

                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      {prov.id_proof_type ?? "ID"} proof
                    </div>
                    {prov.has_id_proof ? (
                      <button
                        onClick={() =>
                          setLightbox({
                            items: [
                              {
                                provenanceId: prov.id,
                                field: "id_proof",
                                caption: `${prov.id_proof_type ?? "ID"} — ${prov.prev_owner_name ?? "previous owner"}`,
                              },
                            ],
                            index: 0,
                          })
                        }
                        className="mt-0.5 text-sm font-semibold text-blue-600 hover:underline"
                      >
                        View
                      </button>
                    ) : (
                      // The one that matters. Without an ID proof, the owner's name is
                      // a claim typed into a box.
                      <div className="mt-0.5 text-sm font-semibold text-red-600">
                        Not provided
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      Purchase proof
                    </div>
                    {prov.has_purchase_proof ? (
                      <button
                        onClick={() =>
                          setLightbox({
                            items: [
                              {
                                provenanceId: prov.id,
                                field: "purchase_proof",
                                caption: "Purchase proof",
                              },
                            ],
                            index: 0,
                          })
                        }
                        className="mt-0.5 text-sm font-semibold text-blue-600 hover:underline"
                      >
                        View
                      </button>
                    ) : (
                      <div className="mt-0.5 text-sm text-slate-400">Not provided</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}

      {lightbox && (
        <Lightbox
          items={lightbox.items}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndex={(i) => setLightbox((l) => (l ? { ...l, index: i } : l))}
        />
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-medium text-slate-800">{value || "—"}</div>
    </div>
  );
}
