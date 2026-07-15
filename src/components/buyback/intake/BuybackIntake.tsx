"use client";

/**
 * M02 — the single-page buyback intake. No wizard (BRD U1).
 *
 * Per the design handoff: a row card per SKU, the variant picker auto-filling the
 * read-only spec pills / estimated price / measured voltage, qty expanding to
 * Unit 1..N chips, six photo slots, the Owner vs Dealer-own-stock provenance
 * toggle with bulk apply, a pickup address picker, and a sticky footer with the
 * running unit count and estimated value.
 *
 * The Submit button is gated by the SAME rules the server enforces — it calls the
 * server's gate result, so the button and the API can never disagree. (The
 * prototype only *warned* about missing photos and let you submit anyway.)
 *
 * Photos upload in the background while the dealer keeps typing — through the
 * same-origin /api/buyback/uploads route (the server writes to S3 itself). The
 * BRD's presigned-PUT path exists (/api/buyback/photos/presign) but a browser
 * PUT to S3 is cross-origin and the bucket has no CORS rule, so it dies as
 * "Failed to fetch" before reaching AWS.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Lightbox, { type LightboxItem } from "@/components/buyback/Lightbox";
import { PageHeader } from "@/components/buyback/ui";
import { useRouter } from "next/navigation";

import { inr } from "@/lib/buyback/format";
import { MIN_PHOTOS_PER_LINE } from "@/lib/buyback/submit-gate";

interface Variant {
  id: string;
  type: string;
  voltage: string;
  ah: string;
  est_buyback_price_working: string | null;
  est_buyback_price_dead: string | null;
}

interface PickupAddress {
  id: string;
  label: string;
  address_line1: string;
  city: string | null;
  pincode: string | null;
}

type Condition = "WORKING" | "DEAD";

/** One SKU row on the page, before it is persisted. */
interface DraftRow {
  key: string;
  line_id: string | null;
  variant_id: string;
  quantity: number;
  condition: Condition;
  expected_price: string;
  measured_voltage: string;
  /**
   * `previewUrl` is a local object URL, shown while the bytes are still uploading
   * so the dealer sees their photo immediately instead of a grey placeholder. It
   * is revoked once the server copy exists.
   */
  photos: Array<{ id: string; uploading: boolean; previewUrl?: string }>;
  provenance: "OWNER" | "STOCK";
  owner_name: string;
  owner_phone: string;
  vehicle_no: string;
  /**
   * The previous owner's ID and the purchase receipt (BRD M04 / P2).
   *
   * These are the documents that prove the dealer had the right to sell the
   * battery at all. Without them a "provenance record" is just a name typed into
   * a box — which is exactly how stolen batteries get laundered through a buyback
   * scheme. The DB has always had the columns; the form simply never asked.
   */
  id_proof_type: "PAN" | "DL" | "AADHAAR" | "OTHER";
  id_proof_key: string | null;
  id_proof_name: string | null;
  id_proof_uploading: boolean;
  /** Optional — a dealer buying from a walk-in often has no receipt. */
  purchase_proof_key: string | null;
  purchase_proof_name: string | null;
  purchase_proof_uploading: boolean;
  /**
   * The saved provenance record. Needed to build the media URL for a proof, so the
   * thumbnail survives a reload rather than living only in a local object URL.
   */
  provenance_id: string | null;
  /** Local object URLs, shown until the record exists on the server. */
  id_proof_preview: string | null;
  purchase_proof_preview: string | null;
  /**
   * E-191 — the dealer-declared battery spec. Kept as strings (they are form
   * inputs); converted to numbers/booleans in the save payload. The * fields
   * (brand, chemistry, nominal V/Ah, unit weight, IOT yes/no + IOT brand when
   * yes) are required by the SERVER's submit gate — same one-implementation
   * rule as the photo minimum, so this form never disagrees with the API.
   */
  brand: string;
  chemistry: "" | "NMC" | "LFP";
  form_factor: "" | "CELL" | "PRISMATIC" | "CYLINDRICAL";
  nominal_voltage: string;
  nominal_ampere: string;
  unit_weight_kg: string;
  warranty_cycles: string;
  functional_qty: string;
  non_functional_qty: string;
  iot_battery: "" | "YES" | "NO";
  iot_brand_name: string;
  applyAll: boolean;
  open: boolean;
  saving: boolean;
}

const newRow = (): DraftRow => ({
  key: crypto.randomUUID(),
  line_id: null,
  variant_id: "",
  quantity: 1,
  condition: "WORKING",
  expected_price: "",
  measured_voltage: "",
  photos: [],
  provenance: "OWNER",
  owner_name: "",
  owner_phone: "",
  vehicle_no: "",
  id_proof_type: "PAN",
  id_proof_key: null,
  id_proof_name: null,
  id_proof_uploading: false,
  purchase_proof_key: null,
  purchase_proof_name: null,
  purchase_proof_uploading: false,
  provenance_id: null,
  id_proof_preview: null,
  purchase_proof_preview: null,
  brand: "",
  chemistry: "",
  form_factor: "",
  nominal_voltage: "",
  nominal_ampere: "",
  unit_weight_kg: "",
  warranty_cycles: "",
  functional_qty: "",
  non_functional_qty: "",
  iot_battery: "",
  iot_brand_name: "",
  applyAll: true,
  open: false,
  saving: false,
});

/**
 * Auto-fill for the measured voltage, mirroring the prototype: a dead battery
 * reads ~0V; a healthy one sits a little above nominal.
 */
function measuredFor(nominalV: number, condition: Condition): string {
  if (condition === "DEAD") return "0.0";
  const bump = nominalV >= 58 ? 0.6 : nominalV >= 50 ? 0.4 : 1.2;
  return (nominalV + bump).toFixed(1);
}

function catalogPrice(v: Variant | undefined, condition: Condition): string {
  if (!v) return "";
  const p = condition === "DEAD" ? v.est_buyback_price_dead : v.est_buyback_price_working;
  return p ? String(Math.round(Number(p))) : "";
}

/**
 * A spec input's string → the API's number, or null for anything unusable.
 * Null never blocks a save — it means "not provided yet", and the submit gate
 * is what flags a required field as missing. Sending NaN or a zero voltage to
 * zod instead would fail the WHOLE line save (quantity, price and all) over
 * one bad keystroke in an optional-for-now field.
 */
function specNum(s: string, opts?: { int?: boolean; allowZero?: boolean }): number | null {
  if (s.trim() === "") return null;
  let n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (opts?.int) n = Math.trunc(n);
  if (n < 0 || (!opts?.allowZero && n === 0)) return null;
  return n;
}

/**
 * Send a file's bytes through our own /api/buyback/uploads route and return the
 * s3_key the server stored them under.
 *
 * Same-origin on purpose: the presigned-PUT path uploads cross-origin to S3,
 * and without a bucket CORS rule the browser kills that PUT with a literal
 * "TypeError: Failed to fetch" — which then appeared verbatim in the error
 * banner and told the dealer nothing. A network failure here still throws, but
 * as a sentence a human can act on.
 */
async function uploadBytes(
  lineId: string,
  file: File,
  kind: "photo" | "id_proof" | "purchase_proof",
): Promise<string> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("line_id", lineId);
  form.append("kind", kind);

  let res: Response;
  try {
    res = await fetch("/api/buyback/uploads", { method: "POST", body: form });
  } catch {
    throw new Error(
      "The upload could not reach the server — check your internet connection and try again.",
    );
  }

  const json = await res.json().catch(() => null);
  if (!json?.success) throw new Error(json?.error?.message ?? "Upload failed.");
  return json.data.s3_key as string;
}

export default function BuybackIntake() {
  const router = useRouter();

  const [variants, setVariants] = useState<Variant[]>([]);
  const [addresses, setAddresses] = useState<PickupAddress[]>([]);
  const [addressId, setAddressId] = useState<string | null>(null);

  const [requestId, setRequestId] = useState<string | null>(null);
  const [requestNo, setRequestNo] = useState<string | null>(null);
  const [rows, setRows] = useState<DraftRow[]>([newRow()]);

  /** The zoom viewer. Null when closed. */
  const [lightbox, setLightbox] = useState<{
    items: LightboxItem[];
    index: number;
  } | null>(null);

  const [gateIssues, setGateIssues] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The inline "add a pickup address" form. */
  const [addingAddress, setAddingAddress] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);
  const [addressForm, setAddressForm] = useState({
    label: "",
    address_line1: "",
    city: "",
    pincode: "",
  });

  const variantById = useMemo(
    () => new Map(variants.map((v) => [v.id, v])),
    [variants],
  );

  // ---- bootstrap: catalog, addresses, and the DRAFT request ----------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [catRes, addrRes] = await Promise.all([
          fetch("/api/buyback/catalog/variants"),
          fetch("/api/buyback/pickup-addresses"),
        ]);
        const cat = await catRes.json();
        const addr = await addrRes.json();
        if (cancelled) return;

        setVariants(cat?.data?.variants ?? []);
        const list: PickupAddress[] = addr?.data?.addresses ?? [];
        setAddresses(list);
        setAddressId(list[0]?.id ?? null);

        // Open the draft up front so lines/photos have something to attach to.
        // The default pickup address (if any) rides along, so the batch is born
        // with it instead of needing a follow-up PATCH.
        const draftRes = await fetch("/api/buyback/requests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pickup_address_id: list[0]?.id ?? null }),
        });
        const draft = await draftRes.json();
        if (cancelled) return;

        if (draft?.success) {
          setRequestId(draft.data.request_id);
          setRequestNo(draft.data.request_no);
        } else {
          setError(draft?.error?.message ?? "Could not start a new request.");
        }
      } catch {
        // Network-level failure on any of the three bootstrap calls. Named for
        // what the dealer can do about it — not "Failed to fetch".
        if (!cancelled)
          setError(
            "Could not reach the server to start a request — check your connection and reload the page.",
          );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const patch = useCallback((key: string, next: Partial<DraftRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...next } : r)));
  }, []);

  /**
   * saveLine's dedup and ordering state.
   *
   * React state is a render snapshot: pick a SKU and then type a quantity (or
   * click a photo slot) before the create-POST returns, and BOTH calls see
   * `line_id === null` — both POST, and the server grows duplicate lines the
   * page never shows. Those ghost lines then block submit with reasons naming
   * batteries the dealer cannot see ("×1 has 0 of 5 required photos" on a page
   * with one row). Found live: one on-screen row, three buyback_lines.
   *
   * `lineIdsRef` holds the authoritative id the moment creation resolves;
   * `saveChainsRef` serializes saves per row so a second save waits for the
   * first instead of racing it.
   */
  const lineIdsRef = useRef<Record<string, string | null>>({});
  const saveChainsRef = useRef<Record<string, Promise<string | null>>>({});

  /**
   * Save a row to the server: CREATE it the first time, UPDATE it every time after.
   *
   * This used to bail out with `if (row.line_id) return` — it wrote the line once,
   * when the SKU was picked, and never again. So a dealer who then set the quantity
   * to 2 saw "Unit 1 / Unit 2" and ₹8,400 on their screen while the SERVER still
   * held quantity 1. They would have submitted a request to sell two batteries and
   * iTarang would have seen one. Every edit now goes back.
   *
   * Returns the line id so a caller that needs one immediately (the photo upload)
   * can wait for it rather than silently doing nothing. Never rejects — a failed
   * save surfaces its reason in the banner and resolves null.
   */
  const saveLine = useCallback(
    (row: DraftRow): Promise<string | null> => {
      if (!requestId || !row.variant_id) return Promise.resolve(null);

      const run = async (): Promise<string | null> => {
        // The ref, not the row: `row` is the closure from whichever render
        // queued this save, and the line may have been created since.
        const knownId = lineIdsRef.current[row.key] ?? row.line_id;

        patch(row.key, { saving: true });

        const payload = {
          quantity: row.quantity,
          condition: row.condition,
          expected_price_per_unit: row.expected_price ? Number(row.expected_price) : null,
          measured_voltage: row.measured_voltage ? Number(row.measured_voltage) : null,
          // E-191 spec. Empty inputs go as null (PATCH semantics: null clears),
          // so what the dealer sees and what the server holds never drift.
          brand: row.brand.trim() || null,
          chemistry: row.chemistry || null,
          form_factor: row.form_factor || null,
          nominal_voltage: specNum(row.nominal_voltage),
          nominal_ampere: specNum(row.nominal_ampere),
          unit_weight_kg: specNum(row.unit_weight_kg),
          warranty_cycles: specNum(row.warranty_cycles, { int: true, allowZero: true }),
          functional_qty: specNum(row.functional_qty, { int: true, allowZero: true }),
          non_functional_qty: specNum(row.non_functional_qty, { int: true, allowZero: true }),
          iot_battery: row.iot_battery === "" ? null : row.iot_battery === "YES",
          iot_brand_name:
            row.iot_battery === "YES" ? row.iot_brand_name.trim() || null : null,
        };

        let json: { success?: boolean; error?: { message?: string }; data?: { line_id: string } } | null;
        try {
          const res = knownId
            ? await fetch(`/api/buyback/requests/${requestId}/lines/${knownId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              })
            : await fetch(`/api/buyback/requests/${requestId}/lines`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ variant_id: row.variant_id, ...payload }),
              });
          json = await res.json();
        } catch {
          patch(row.key, { saving: false });
          setError("Could not save the battery line — check your connection and try again.");
          return null;
        }

        if (!json?.success) {
          patch(row.key, { saving: false });
          setError(json?.error?.message ?? "Could not save the battery line.");
          return null;
        }

        const lineId = knownId ?? json.data!.line_id;
        lineIdsRef.current[row.key] = lineId;
        patch(row.key, { line_id: lineId, saving: false });
        return lineId;
      };

      // Chain onto any in-flight save for this row — never race it.
      const chained = (saveChainsRef.current[row.key] ?? Promise.resolve(null)).then(run, run);
      saveChainsRef.current[row.key] = chained;
      return chained;
    },
    [requestId, patch],
  );

  /** Delete a photo — from the page AND from the server. */
  const removePhoto = async (row: DraftRow, photoId: string) => {
    if (!requestId) return;

    const res = await fetch(
      `/api/buyback/requests/${requestId}/photos?photo_id=${photoId}`,
      { method: "DELETE" },
    );
    const json = await res.json();

    if (!json?.success) {
      // Do NOT remove it from the page. A photo that vanished from the grid but
      // survived on the server would leave the dealer believing they had five when
      // they had six — and vice versa when the delete silently failed.
      setError(json?.error?.message ?? "Could not remove the photo.");
      return;
    }

    setRows((rs) =>
      rs.map((r) =>
        r.key === row.key ? { ...r, photos: r.photos.filter((p) => p.id !== photoId) } : r,
      ),
    );
  };

  /** Open the zoom viewer on one line's photos, starting at the one clicked. */
  const openPhotos = (row: DraftRow, startAt: number) => {
    const variant = variantById.get(row.variant_id);
    const label = variant ? variant.type : "Battery";

    setLightbox({
      items: row.photos
        .filter((p) => !p.uploading)
        .map((p, i) => ({
          photoId: p.id,
          caption: `${label} — photo ${i + 1}`,
        })),
      index: startAt,
    });
  };

  /** Remove a battery line — from the page AND from the server. */
  const removeRow = async (row: DraftRow) => {
    // The ref may know the id before this render does (see saveLine).
    const lineId = lineIdsRef.current[row.key] ?? row.line_id;
    // A row that was never persisted only exists in React.
    if (requestId && lineId) {
      const res = await fetch(`/api/buyback/requests/${requestId}/lines/${lineId}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!json?.success) {
        // Do NOT drop it from the page. A row that vanished from the screen but
        // survived on the server would be submitted without the dealer knowing.
        setError(json?.error?.message ?? "Could not remove the battery line.");
        return;
      }
    }
    delete lineIdsRef.current[row.key];
    delete saveChainsRef.current[row.key];
    setRows((rs) => rs.filter((r) => r.key !== row.key));
  };

  /** Picking a SKU auto-fills the spec, the price and the measured voltage. */
  const pickVariant = (row: DraftRow, variantId: string) => {
    const v = variantById.get(variantId);
    const next: Partial<DraftRow> = {
      variant_id: variantId,
      expected_price: catalogPrice(v, row.condition),
      measured_voltage: v ? measuredFor(Number(v.voltage), row.condition) : "",
      // E-191: the nominal spec prefills from the catalog SKU — editable, the
      // dealer's declaration wins over the catalog's.
      nominal_voltage: v ? trim(v.voltage) : row.nominal_voltage,
      nominal_ampere: v ? trim(v.ah) : row.nominal_ampere,
    };
    patch(row.key, next);
    void saveLine({ ...row, ...next } as DraftRow);
  };

  /**
   * Switching Working↔Dead rewrites BOTH the price and the measured voltage —
   * and, now, saves. A dealer flipping a battery to Dead was previously changing
   * only what was on their screen: iTarang would still have been quoted a working
   * battery at the working price.
   */
  const setCondition = (row: DraftRow, condition: Condition) => {
    const v = variantById.get(row.variant_id);
    const next: Partial<DraftRow> = {
      condition,
      expected_price: catalogPrice(v, condition),
      measured_voltage: v ? measuredFor(Number(v.voltage), condition) : "",
    };
    patch(row.key, next);
    void saveLine({ ...row, ...next } as DraftRow);
  };

  /**
   * Quantity, price and measured voltage: edit freely, save on blur.
   *
   * On blur rather than on every keystroke — a PATCH per character would reconcile
   * the unit rows on every digit, so typing "12" would briefly create 1 unit and
   * then 11 more.
   */
  const commitRow = (row: DraftRow) => {
    if (!row.variant_id) return;
    void saveLine(row);
  };

  // ---- photos: upload same-origin → record the row -------------------------
  const uploadPhoto = async (row: DraftRow, file: File) => {
    if (!requestId) {
      setError("The draft request has not been created yet. Wait a moment and try again.");
      return;
    }
    if (!row.variant_id) {
      setError("Choose a battery type first — photos attach to a battery line.");
      return;
    }

    // The line may not be saved yet: the dealer can pick a SKU and click a photo
    // slot faster than the POST completes, and the save can also simply have
    // failed. Create it now rather than refusing — the alternative is a slot that
    // does nothing and never says why, which is exactly the bug this replaces.
    // (The ref first: `row` may be a stale render snapshot — see saveLine.)
    const lineId = lineIdsRef.current[row.key] ?? row.line_id ?? (await saveLine(row));
    if (!lineId) return; // saveLine has already surfaced the reason

    const tempId = crypto.randomUUID();
    // Show the dealer their own photo instantly, from the local file, while the
    // bytes go up in the background.
    const previewUrl = URL.createObjectURL(file);
    patch(row.key, {
      photos: [...row.photos, { id: tempId, uploading: true, previewUrl }],
    });

    try {
      const s3Key = await uploadBytes(lineId, file, "photo");

      const recordRes = await fetch(`/api/buyback/requests/${requestId}/photos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // `lineId`, not `row.line_id` — the line may have been created moments
          // ago by saveLine() above, and `row` is the stale closure from render.
          line_id: lineId,
          s3_key_original: s3Key,
        }),
      });
      const record = await recordRes.json();
      if (!record?.success) throw new Error(record?.error?.message);

      // The server copy exists now, so the local blob can go. Leaving object URLs
      // alive holds the whole file in memory — six 8 MB photos per line adds up.
      URL.revokeObjectURL(previewUrl);

      setRows((rs) =>
        rs.map((r) =>
          r.key === row.key
            ? {
                ...r,
                photos: r.photos.map((p) =>
                  p.id === tempId ? { id: record.data.photo_id, uploading: false } : p,
                ),
              }
            : r,
        ),
      );
    } catch (e) {
      URL.revokeObjectURL(previewUrl);

      // Drop the optimistic slot — a photo that failed to upload must not count
      // towards the 5-photo minimum.
      setRows((rs) =>
        rs.map((r) =>
          r.key === row.key
            ? { ...r, photos: r.photos.filter((p) => p.id !== tempId) }
            : r,
        ),
      );
      setError(e instanceof Error ? e.message : "Photo upload failed.");
    }
  };

  /**
   * The previous owner's ID proof, or the purchase receipt.
   *
   * Same upload path as a photo, but a different `kind`: proofs accept a PDF
   * (an ID card or a receipt is usually a scan) and land under their own key
   * prefix, so the nightly photo-dedup sweep never tries to perceptually hash
   * somebody's driving licence.
   */
  const uploadProof = async (row: DraftRow, file: File, kind: "id_proof" | "purchase_proof") => {
    if (!requestId || !row.variant_id) {
      setError("Choose a battery type first — proof attaches to a battery line.");
      return;
    }

    // Same as the photo path: create the line now if it does not exist yet.
    const lineId = lineIdsRef.current[row.key] ?? row.line_id ?? (await saveLine(row));
    if (!lineId) return;

    const busy = kind === "id_proof" ? "id_proof_uploading" : "purchase_proof_uploading";
    patch(row.key, { [busy]: true } as Partial<DraftRow>);

    try {
      const s3Key = await uploadBytes(lineId, file, kind);

      // The local file, shown as the thumbnail until the provenance record exists
      // and the server can serve it.
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;

      const patched: Partial<DraftRow> =
        kind === "id_proof"
          ? {
              id_proof_key: s3Key,
              id_proof_name: file.name,
              id_proof_preview: preview,
              id_proof_uploading: false,
            }
          : {
              purchase_proof_key: s3Key,
              purchase_proof_name: file.name,
              purchase_proof_preview: preview,
              purchase_proof_uploading: false,
            };

      patch(row.key, patched);

      // Persist immediately. A proof the dealer attached and then lost because they
      // never blurred a text field would be worse than not offering the upload.
      await saveProvenance({ ...row, ...patched } as DraftRow);
    } catch (e) {
      patch(row.key, { [busy]: false } as Partial<DraftRow>);
      setError(e instanceof Error ? e.message : "Could not attach the proof.");
    }
  };

  const saveProvenance = async (row: DraftRow) => {
    const lineId = lineIdsRef.current[row.key] ?? row.line_id;
    if (!requestId || !lineId) return;

    // Don't scream mid-typing. An OWNER record is only saveable once the
    // required fields exist (server rule: name present, phone ≥ 6 chars) —
    // blurring the name field before the phone was typed used to fire a doomed
    // POST and put a red "Validation failed" banner over a form that was being
    // filled in perfectly normally. The submit-time flush sends the complete
    // record; the server gate still catches genuinely missing provenance.
    if (
      row.provenance === "OWNER" &&
      (!row.owner_name.trim() || row.owner_phone.trim().length < 6)
    ) {
      return;
    }

    const body =
      row.provenance === "STOCK"
        ? { source_type: "DEALER_STOCK", scope: "LINE", line_id: lineId }
        : {
            source_type: "PREV_OWNER_DOCS",
            scope: "LINE",
            line_id: lineId,
            prev_owner_name: row.owner_name,
            prev_owner_phone: row.owner_phone,
            vehicle_no: row.vehicle_no || null,
            // One field on the form, two columns in the DB: a dealer types
            // "MH12 AB 1234" and does not care which of the two it is.
            rc_number: row.vehicle_no || null,
            id_proof_type: row.id_proof_key ? row.id_proof_type : null,
            id_proof_s3: row.id_proof_key,
            payment_proof_ref: row.purchase_proof_key,
          };

    const res = await fetch(`/api/buyback/requests/${requestId}/provenance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();

    if (!json?.success) {
      setError(json?.error?.message ?? "Could not save provenance.");
      return;
    }

    // Keep the record id: it is what lets a proof thumbnail be served from the
    // server (and therefore survive a page reload) rather than from a local blob.
    patch(row.key, { provenance_id: json.data.provenance_id });
  };

  /**
   * Selecting an address persists it. The cards used to be pure decoration —
   * the highlight lived in React state, the server never heard about it, and
   * every request went to pickup with pickup_address_id NULL.
   */
  const selectAddress = async (id: string) => {
    setAddressId(id);
    if (!requestId) return;

    const res = await fetch(`/api/buyback/requests/${requestId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickup_address_id: id }),
    });
    const json = await res.json().catch(() => null);
    if (!json?.success) {
      setError(json?.error?.message ?? "Could not save the pickup address.");
    }
  };

  /**
   * The empty state used to say "add one in your profile" — and there was no
   * profile page that could. The address is created right here and immediately
   * selected onto the draft.
   */
  const addAddress = async () => {
    if (!addressForm.label.trim() || !addressForm.address_line1.trim()) {
      setError("Give the address a label and a street line — e.g. “Shop — Nashik”.");
      return;
    }
    setSavingAddress(true);

    const res = await fetch("/api/buyback/pickup-addresses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: addressForm.label.trim(),
        address_line1: addressForm.address_line1.trim(),
        city: addressForm.city.trim() || null,
        pincode: addressForm.pincode.trim() || null,
        is_default: addresses.length === 0,
      }),
    });
    const json = await res.json().catch(() => null);
    setSavingAddress(false);

    if (!json?.success) {
      // Zod refusals (e.g. a 5-digit pincode) arrive in details, per field.
      const detail = json?.error?.details?.[0]?.message;
      setError(detail ?? json?.error?.message ?? "Could not save the address.");
      return;
    }

    const created: PickupAddress = json.data.address;
    setAddresses((as) => [...as, created]);
    setAddingAddress(false);
    setAddressForm({ label: "", address_line1: "", city: "", pincode: "" });
    void selectAddress(created.id);
  };

  /**
   * Everything on this page already autosaves (lines on blur, photos on upload,
   * provenance on blur) — "Save draft" is the explicit "keep this, I'll come
   * back later". It flushes any provenance not yet blurred and returns to the
   * request list, where the draft sits at the top. The button used to have no
   * onClick at all.
   */
  const saveDraft = async () => {
    setSavingDraft(true);
    for (const row of rows) {
      await saveProvenance(row);
    }
    setSavingDraft(false);
    router.push("/dealer-portal/buyback");
  };

  const submit = async () => {
    if (!requestId) return;
    setSubmitting(true);
    setError(null);
    setGateIssues([]);

    // Flush provenance for every row before the gate runs. saveProvenance
    // no-ops for rows with no server line yet.
    for (const row of rows) {
      await saveProvenance(row);
    }

    const res = await fetch(`/api/buyback/requests/${requestId}/submit`, { method: "POST" });
    const json = await res.json();
    setSubmitting(false);

    if (json?.success) {
      router.push(`/dealer-portal/buyback/${requestId}`);
      return;
    }

    // The server's gate is the source of truth; show exactly what it refused.
    const issues: string[] = json?.error?.details?.map((d: { message: string }) => d.message) ?? [];
    setGateIssues(issues.length ? issues : [json?.error?.message ?? "Could not submit."]);
  };

  const totalUnits = rows.reduce((n, r) => n + (r.variant_id ? r.quantity : 0), 0);
  const estimatedValue = rows.reduce(
    (sum, r) => sum + (Number(r.expected_price) || 0) * (r.variant_id ? r.quantity : 0),
    0,
  );

  return (
    <div className="mx-auto max-w-5xl px-6 pb-32 pt-6">
      <PageHeader
        title="New Buyback Request"
        sub="Add battery lines, attach provenance, choose pickup — one page, no wizard."
        right={
          requestNo ? (
            <div className="flex items-center gap-1.5 text-xs font-semibold text-green-600">
              <span className="h-[7px] w-[7px] rounded-full bg-green-600" />
              Autosaved · {requestNo}
            </div>
          ) : undefined
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <h2 className="mb-3 text-sm font-bold text-slate-600">Battery lines</h2>

      {rows.map((row) => {
        const variant = variantById.get(row.variant_id);
        const photoCount = row.photos.length;

        return (
          <div
            key={row.key}
            className="mb-3.5 rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            {/* SKU · qty · price · condition */}
            <div className="grid grid-cols-[1.9fr_0.6fr_1fr_1fr_auto] items-end gap-3 px-4 py-3.5">
              <Field label="Battery type (SKU)">
                <select
                  value={row.variant_id}
                  onChange={(e) => pickVariant(row, e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                >
                  <option value="">Select type…</option>
                  {variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.type}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Qty">
                <input
                  type="number"
                  min={1}
                  value={row.quantity}
                  onChange={(e) =>
                    patch(row.key, { quantity: Math.max(1, Number(e.target.value) || 1) })
                  }
                  // On blur, not on keystroke: a save per character would recreate
                  // the unit rows on every digit typed.
                  onBlur={() => commitRow({ ...row, quantity: row.quantity })}
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm tabular-nums"
                />
              </Field>

              <Field label="Expected ₹/unit">
                <div className="relative">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                    ₹
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={row.expected_price}
                    onChange={(e) => patch(row.key, { expected_price: e.target.value })}
                    onBlur={() => commitRow(row)}
                    className="w-full rounded-lg border border-slate-200 py-2 pl-6 pr-2 text-sm tabular-nums"
                  />
                </div>
              </Field>

              <Field label="Condition">
                <select
                  value={row.condition}
                  onChange={(e) => setCondition(row, e.target.value as Condition)}
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                >
                  <option value="WORKING">Working</option>
                  <option value="DEAD">Dead</option>
                </select>
              </Field>

              {rows.length > 1 && (
                <button
                  // Was `setRows(filter)` — it removed the row from the PAGE and
                  // left the line on the SERVER, so a battery the dealer thought
                  // they had deleted would still have been submitted.
                  onClick={() => void removeRow(row)}
                  className="h-9 w-9 rounded-lg border border-red-300 text-red-600 hover:bg-red-50"
                  aria-label="Remove battery line"
                >
                  ×
                </button>
              )}
            </div>

            {/* Auto-filled spec — read-only. Only the measured voltage is editable. */}
            <div className="flex items-end gap-4 px-4 pb-3">
              <div>
                <Label>Spec (auto from SKU)</Label>
                <div className="flex gap-1.5">
                  <SpecPill value={variant ? `${trim(variant.voltage)}V` : "—V"} filled={!!variant} />
                  <SpecPill value={variant ? `${trim(variant.ah)}Ah` : "—Ah"} filled={!!variant} />
                </div>
              </div>

              <div className="min-w-[180px]">
                <Label>Measured voltage (auto · editable)</Label>
                <input
                  value={row.measured_voltage}
                  onChange={(e) => patch(row.key, { measured_voltage: e.target.value })}
                  onBlur={() => commitRow(row)}
                  placeholder="e.g. 49.2"
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm tabular-nums"
                />
              </div>
            </div>

            {/* E-191 — the dealer-declared battery details. Fields marked * are
                required to SUBMIT (the server's gate enforces them, exactly like
                the 5-photo minimum), not to autosave — so a half-typed row never
                blocks. Selects save immediately; text/number inputs on blur. */}
            <div className="border-t border-slate-100 px-4 py-3">
              <Label>Battery details — fields marked * are required to submit</Label>
              <div className="grid grid-cols-4 gap-3">
                <Field label="Brand *">
                  <input
                    value={row.brand}
                    onChange={(e) => patch(row.key, { brand: e.target.value })}
                    onBlur={() => commitRow(row)}
                    placeholder="e.g. Exide"
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                  />
                </Field>

                <Field label="Chemistry *">
                  <select
                    value={row.chemistry}
                    onChange={(e) => {
                      const next = { chemistry: e.target.value as DraftRow["chemistry"] };
                      patch(row.key, next);
                      void saveLine({ ...row, ...next } as DraftRow);
                    }}
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                  >
                    <option value="">Select…</option>
                    <option value="NMC">NMC</option>
                    <option value="LFP">LFP</option>
                  </select>
                </Field>

                <Field label="Form factor">
                  <select
                    value={row.form_factor}
                    onChange={(e) => {
                      const next = { form_factor: e.target.value as DraftRow["form_factor"] };
                      patch(row.key, next);
                      void saveLine({ ...row, ...next } as DraftRow);
                    }}
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                  >
                    <option value="">Select…</option>
                    <option value="CELL">Cell</option>
                    <option value="PRISMATIC">Prismatic</option>
                    <option value="CYLINDRICAL">Cylindrical</option>
                  </select>
                </Field>

                <Field label="Nominal voltage (V) *">
                  <input
                    type="number"
                    min={0}
                    value={row.nominal_voltage}
                    onChange={(e) => patch(row.key, { nominal_voltage: e.target.value })}
                    onBlur={() => commitRow(row)}
                    placeholder="e.g. 51.2"
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm tabular-nums"
                  />
                </Field>

                <Field label="Nominal ampere (Ah) *">
                  <input
                    type="number"
                    min={0}
                    value={row.nominal_ampere}
                    onChange={(e) => patch(row.key, { nominal_ampere: e.target.value })}
                    onBlur={() => commitRow(row)}
                    placeholder="e.g. 100"
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm tabular-nums"
                  />
                </Field>

                <Field label="Unit weight (kg) *">
                  <input
                    type="number"
                    min={0}
                    value={row.unit_weight_kg}
                    onChange={(e) => patch(row.key, { unit_weight_kg: e.target.value })}
                    onBlur={() => commitRow(row)}
                    placeholder="e.g. 12.5"
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm tabular-nums"
                  />
                </Field>

                <Field label="Warranty cycles">
                  <input
                    type="number"
                    min={0}
                    value={row.warranty_cycles}
                    onChange={(e) => patch(row.key, { warranty_cycles: e.target.value })}
                    onBlur={() => commitRow(row)}
                    placeholder="e.g. 800"
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm tabular-nums"
                  />
                </Field>

                <Field label="IOT battery *">
                  <select
                    value={row.iot_battery}
                    onChange={(e) => {
                      const next = { iot_battery: e.target.value as DraftRow["iot_battery"] };
                      patch(row.key, next);
                      void saveLine({ ...row, ...next } as DraftRow);
                    }}
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                  >
                    <option value="">Select…</option>
                    <option value="YES">Yes</option>
                    <option value="NO">No</option>
                  </select>
                </Field>

                <Field label="Functional qty">
                  <input
                    type="number"
                    min={0}
                    value={row.functional_qty}
                    onChange={(e) => patch(row.key, { functional_qty: e.target.value })}
                    onBlur={() => commitRow(row)}
                    placeholder="working units"
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm tabular-nums"
                  />
                </Field>

                <Field label="Non-functional qty">
                  <input
                    type="number"
                    min={0}
                    value={row.non_functional_qty}
                    onChange={(e) => patch(row.key, { non_functional_qty: e.target.value })}
                    onBlur={() => commitRow(row)}
                    placeholder="dead units"
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm tabular-nums"
                  />
                </Field>

                {row.iot_battery === "YES" && (
                  <Field label="IOT brand name *">
                    <input
                      value={row.iot_brand_name}
                      onChange={(e) => patch(row.key, { iot_brand_name: e.target.value })}
                      onBlur={() => commitRow(row)}
                      placeholder="e.g. BoltIoT"
                      className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                    />
                  </Field>
                )}
              </div>

              {/* Live version of the gate's QTY_SPLIT_MISMATCH rule, so the
                  dealer sees it while typing rather than at submit. */}
              {row.functional_qty !== "" &&
                row.non_functional_qty !== "" &&
                Number(row.functional_qty) + Number(row.non_functional_qty) !==
                  row.quantity && (
                  <p className="mt-2 text-[11.5px] text-red-600">
                    ⚠ Functional + non-functional must add up to Qty ({row.quantity}).
                  </p>
                )}
            </div>

            {/* Units 1..N */}
            {row.variant_id && (
              <div className="px-4 pb-3">
                <Label>Units — photos &amp; provenance attach per unit</Label>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-slate-900 px-2.5 py-1 text-[11.5px] font-bold text-white">
                    All units
                  </span>
                  {Array.from({ length: Math.min(row.quantity, 20) }, (_, i) => (
                    <span
                      key={i}
                      className="rounded-full border border-slate-200 px-2.5 py-1 text-[11.5px] font-semibold text-slate-600"
                    >
                      Unit {i + 1}
                    </span>
                  ))}
                  {row.quantity > 20 && (
                    <span className="text-[11px] text-slate-400">+{row.quantity - 20} more</span>
                  )}
                </div>
              </div>
            )}

            {/* Photos — six slots, min five */}
            <div className="px-4 pb-3.5">
              <Label>Photos for all units (min {MIN_PHOTOS_PER_LINE})</Label>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex gap-1.5">
                  {Array.from({ length: 6 }, (_, i) => {
                    const photo = row.photos[i];
                    if (photo) {
                      // While the bytes are still going up we show the LOCAL file
                      // (an object URL) — the dealer sees their photo the instant
                      // they pick it, not a grey box for two seconds. Once the row
                      // exists we switch to the server thumbnail, so a reload shows
                      // it too.
                      const src = photo.uploading
                        ? photo.previewUrl
                        : `/api/buyback/media?photo=${photo.id}&size=thumb`;

                      return (
                        <div key={photo.id} className="group relative h-[52px] w-[52px]">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={src}
                            alt="Battery photo"
                            onClick={() => {
                              if (photo.uploading) return;
                              openPhotos(row, i);
                            }}
                            className={`h-full w-full rounded-lg border border-slate-200 object-cover ${
                              photo.uploading
                                ? "animate-pulse opacity-60"
                                : "cursor-zoom-in hover:border-slate-400"
                            }`}
                          />

                          {!photo.uploading && (
                            <button
                              type="button"
                              onClick={() => void removePhoto(row, photo.id)}
                              aria-label="Remove photo"
                              title="Remove photo"
                              className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[11px] font-bold text-white shadow group-hover:flex"
                            >
                              ×
                            </button>
                          )}
                        </div>
                      );
                    }
                    // A slot with no SKU chosen yet cannot upload — there is no
                    // line for the photo to hang off. It used to be `disabled`,
                    // which meant clicking it did NOTHING AT ALL while it still
                    // looked and hovered like a button. Now it says why.
                    const ready = Boolean(row.variant_id);

                    return (
                      <label
                        key={i}
                        title={
                          ready
                            ? "Add a photo"
                            : "Choose a battery type first — photos attach to a battery line."
                        }
                        onClick={() => {
                          if (!ready) {
                            setError(
                              "Choose a battery type first — photos attach to a battery line.",
                            );
                          }
                        }}
                        className={`flex h-[52px] w-[52px] items-center justify-center rounded-lg border-[1.5px] border-dashed text-slate-400 ${
                          ready
                            ? "cursor-pointer border-slate-300 hover:border-slate-400 hover:text-slate-600"
                            : "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-300"
                        }`}
                      >
                        +
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          disabled={!ready}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void uploadPhoto(row, file);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    );
                  })}
                </div>

                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                    photoCount < MIN_PHOTOS_PER_LINE
                      ? "bg-amber-100 text-amber-700"
                      : "bg-green-100 text-green-700"
                  }`}
                >
                  {photoCount}/6 photos
                </span>
                {photoCount < MIN_PHOTOS_PER_LINE && (
                  <span className="text-[11.5px] text-red-600">
                    ⚠ Minimum {MIN_PHOTOS_PER_LINE} required
                  </span>
                )}
              </div>
            </div>

            {/* Provenance */}
            <div className="rounded-b-xl border-t border-slate-100 bg-slate-50 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-[12.5px] font-bold text-slate-700">
                    Provenance — all units
                  </span>
                  <div className="flex overflow-hidden rounded-md border border-slate-200">
                    {(["OWNER", "STOCK"] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => patch(row.key, { provenance: mode, open: true })}
                        className={`px-2.5 py-1 text-[11.5px] font-semibold ${
                          row.provenance === mode
                            ? "bg-slate-900 text-white"
                            : "bg-white text-slate-600"
                        }`}
                      >
                        {mode === "OWNER" ? "Owner" : "Dealer own stock"}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => patch(row.key, { open: !row.open })}
                  className="text-xs text-slate-400"
                >
                  {row.open ? "▲ collapse" : "▼ expand"}
                </button>
              </div>

              {row.open && row.provenance === "OWNER" && (
                <div className="mt-3">
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Owner name">
                      <input
                        value={row.owner_name}
                        onChange={(e) => patch(row.key, { owner_name: e.target.value })}
                        onBlur={() => void saveProvenance(row)}
                        placeholder="Full name"
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                      />
                    </Field>
                    <Field label="Owner phone">
                      <input
                        value={row.owner_phone}
                        onChange={(e) => patch(row.key, { owner_phone: e.target.value })}
                        onBlur={() => void saveProvenance(row)}
                        placeholder="+91"
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                      />
                    </Field>
                    <Field label="Vehicle / RC number">
                      <input
                        value={row.vehicle_no}
                        onChange={(e) => patch(row.key, { vehicle_no: e.target.value })}
                        onBlur={() => void saveProvenance(row)}
                        placeholder="MH00 AB 0000"
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                      />
                    </Field>
                  </div>

                  {/* The documents that make this a provenance record rather than a
                      name in a box. Without an ID proof, "the previous owner was
                      Ramesh" is an unverifiable claim — which is how a stolen
                      battery gets laundered through a buyback scheme. */}
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <Field label="ID proof (PAN / DL / Aadhaar)">
                      <div className="flex gap-2">
                        <select
                          value={row.id_proof_type}
                          onChange={(e) =>
                            patch(row.key, {
                              id_proof_type: e.target.value as DraftRow["id_proof_type"],
                            })
                          }
                          className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm"
                        >
                          <option value="PAN">PAN</option>
                          <option value="DL">DL</option>
                          <option value="AADHAAR">Aadhaar</option>
                          <option value="OTHER">Other</option>
                        </select>

                        <ProofUpload
                          fileName={row.id_proof_name}
                          // The local blob while it is fresh; the server copy once
                          // the record exists, so a reload still shows it.
                          previewUrl={
                            row.id_proof_preview ??
                            (row.provenance_id && row.id_proof_key
                              ? `/api/buyback/media?provenance=${row.provenance_id}&field=id_proof`
                              : null)
                          }
                          isPdf={Boolean(row.id_proof_name?.toLowerCase().endsWith(".pdf"))}
                          uploading={row.id_proof_uploading}
                          placeholder="Upload ID proof"
                          onPick={(file) => void uploadProof(row, file, "id_proof")}
                          onView={() =>
                            row.provenance_id &&
                            setLightbox({
                              items: [
                                {
                                  provenanceId: row.provenance_id,
                                  field: "id_proof",
                                  caption: `${row.id_proof_type} — ${row.id_proof_name ?? "ID proof"}`,
                                  isPdf: Boolean(
                                    row.id_proof_name?.toLowerCase().endsWith(".pdf"),
                                  ),
                                },
                              ],
                              index: 0,
                            })
                          }
                          onClear={() => {
                            patch(row.key, {
                              id_proof_key: null,
                              id_proof_name: null,
                              id_proof_preview: null,
                            });
                            void saveProvenance({
                              ...row,
                              id_proof_key: null,
                              id_proof_name: null,
                            });
                          }}
                        />
                      </div>
                    </Field>

                    <Field label="Purchase proof (optional)">
                      <ProofUpload
                        fileName={row.purchase_proof_name}
                        previewUrl={
                          row.purchase_proof_preview ??
                          (row.provenance_id && row.purchase_proof_key
                            ? `/api/buyback/media?provenance=${row.provenance_id}&field=purchase_proof`
                            : null)
                        }
                        isPdf={Boolean(row.purchase_proof_name?.toLowerCase().endsWith(".pdf"))}
                        uploading={row.purchase_proof_uploading}
                        placeholder="Upload receipt"
                        onPick={(file) => void uploadProof(row, file, "purchase_proof")}
                        onView={() =>
                          row.provenance_id &&
                          setLightbox({
                            items: [
                              {
                                provenanceId: row.provenance_id,
                                field: "purchase_proof",
                                caption: row.purchase_proof_name ?? "Purchase proof",
                                isPdf: Boolean(
                                  row.purchase_proof_name?.toLowerCase().endsWith(".pdf"),
                                ),
                              },
                            ],
                            index: 0,
                          })
                        }
                        onClear={() => {
                          patch(row.key, {
                            purchase_proof_key: null,
                            purchase_proof_name: null,
                            purchase_proof_preview: null,
                          });
                          void saveProvenance({
                            ...row,
                            purchase_proof_key: null,
                            purchase_proof_name: null,
                          });
                        }}
                      />
                    </Field>
                  </div>

                  <label className="mt-3 flex items-center gap-2 text-[12.5px] text-slate-500">
                    <input
                      type="checkbox"
                      checked={row.applyAll}
                      onChange={(e) => patch(row.key, { applyAll: e.target.checked })}
                    />
                    Apply this owner and proof to all units in this line (same-source lot)
                  </label>
                </div>
              )}

              {row.open && row.provenance === "STOCK" && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3.5 py-3 text-sm">
                  <span className="font-bold text-slate-800">🗂 Dealer own stock</span>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Uses the ID already on file — no re-entry needed.
                  </p>
                  <button
                    onClick={() => void saveProvenance(row)}
                    className="mt-2 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-semibold hover:bg-slate-50"
                  >
                    Confirm own stock
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}

      <button
        onClick={() => setRows((rs) => [...rs, newRow()])}
        className="mb-6 rounded-lg border border-green-200 bg-white px-4 py-2 text-sm font-semibold text-green-700 hover:bg-green-50"
      >
        + Add Battery
      </button>

      {/* Pickup */}
      <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-bold text-slate-900">Pickup address</h3>
        <p className="mb-3 text-xs text-slate-500">How should we pick up this order?</p>

        {/* Pickup mode — only "one address" is supported today; the per-batch /
            per-row modes are shown but disabled ("coming soon") so the roadmap is
            visible without pretending it works. Purely presentational: the intake
            always sends one address per request (see selectAddress), so there is
            no mode state to wire. */}
        <div className="mb-4 flex flex-wrap gap-2">
          <span className="rounded-lg border border-bb-navy bg-bb-navy px-3 py-1.5 text-[12.5px] font-semibold text-white">
            One address for whole order
          </span>
          {["Per batch", "Per battery row"].map((label) => (
            <span
              key={label}
              title="Coming soon"
              className="cursor-not-allowed rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-300"
            >
              {label}
            </span>
          ))}
        </div>

        {addresses.length > 0 && (
          <div className="mb-3 grid grid-cols-2 gap-3">
            {addresses.map((a) => (
              <button
                key={a.id}
                onClick={() => void selectAddress(a.id)}
                className={`rounded-lg border p-3 text-left ${
                  addressId === a.id
                    ? "border-green-600 bg-green-50"
                    : "border-slate-200 bg-white"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-slate-900">{a.label}</div>
                  {addressId === a.id && (
                    <span className="text-sm font-bold text-green-600">✓</span>
                  )}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {a.address_line1}
                  {a.city ? `, ${a.city}` : ""} {a.pincode ?? ""}
                </div>
              </button>
            ))}
          </div>
        )}

        {addingAddress ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Label">
                <input
                  value={addressForm.label}
                  onChange={(e) => setAddressForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="Shop — Nashik"
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                />
              </Field>
              <Field label="Address line">
                <input
                  value={addressForm.address_line1}
                  onChange={(e) =>
                    setAddressForm((f) => ({ ...f, address_line1: e.target.value }))
                  }
                  placeholder="Street, area"
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                />
              </Field>
              <Field label="City">
                <input
                  value={addressForm.city}
                  onChange={(e) => setAddressForm((f) => ({ ...f, city: e.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm"
                />
              </Field>
              <Field label="Pincode">
                <input
                  value={addressForm.pincode}
                  onChange={(e) => setAddressForm((f) => ({ ...f, pincode: e.target.value }))}
                  placeholder="6 digits"
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm tabular-nums"
                />
              </Field>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => void addAddress()}
                disabled={savingAddress}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300"
              >
                {savingAddress ? "Saving…" : "Save address"}
              </button>
              <button
                onClick={() => setAddingAddress(false)}
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setAddingAddress(true)}
            className="rounded-lg border-[1.5px] border-dashed border-slate-300 px-3.5 py-2 text-sm text-slate-500 hover:border-slate-400 hover:text-slate-700"
          >
            + {addresses.length === 0 ? "Add a pickup address" : "Add another address"}
          </button>
        )}
      </div>

      {/* The server's refusal reasons, per line. */}
      {gateIssues.length > 0 && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-bold text-red-700">This request is not ready to submit:</p>
          <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-red-700">
            {gateIssues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {/*
        The totals bar — a fixed footer, per the prototype (scrNewRequest:584).

        `fixed`, offset by the sidebar. It is pinned to the viewport bottom but
        starts at `md:left-64` — the 256px CRM sidebar width, matching
        LayoutWrapper's `md:ml-64` — so it spans exactly the content column and
        never runs under the sidebar (the old `fixed left-0 right-0` did, which is
        why "Total units" was once clipped). On phones the sidebar is an
        off-canvas drawer, so `left-0` is correct there. The page reserves
        `pb-32` up top so the last card is never hidden behind this bar, and the
        inner row is capped at `max-w-5xl mx-auto` to line up with the page
        column above.
      */}
      <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-slate-200 bg-white px-6 py-3.5 shadow-[0_-4px_18px_rgba(15,23,42,0.06)] md:left-64">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <div className="flex gap-8">
            <Stat label="Total units" value={String(totalUnits)} />
            <Stat label="Estimated value" value={inr(estimatedValue)} accent />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void saveDraft()}
              disabled={savingDraft || !requestId}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
            >
              {savingDraft ? "Saving…" : "Save draft"}
            </button>
            <button
              onClick={() => void submit()}
              disabled={submitting || !requestId}
              className="rounded-lg bg-green-600 px-5 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            >
              {submitting ? "Submitting…" : "Submit request"}
            </button>
          </div>
        </div>
      </div>

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

function trim(v: string) {
  return String(Number(Number(v).toFixed(2)));
}

/**
 * Sentence case, not SHOUTING.
 *
 * This started as the design prototype's `text-[11.5px] font-bold uppercase
 * tracking-wide` micro-label, which looks striking in a standalone mockup and
 * looks like a different application when dropped into this one — every other
 * form in the portal uses a plain sentence-case label. A page that announces
 * itself as foreign is a page users distrust.
 */
function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-xs font-semibold text-slate-600">{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/**
 * A single-file attach control for a proof document (M04).
 *
 * Shows the attached file's NAME once uploaded, not a generic tick. A dealer
 * attaching an ID proof to five battery lines needs to see which file went where —
 * "✓ uploaded" on all five tells them nothing and is exactly how the wrong scan
 * ends up against the wrong battery.
 *
 * Accepts a PDF as well as an image: an ID card or a receipt is very often a scan,
 * and refusing PDFs would only push dealers into photographing their screens.
 */
function ProofUpload({
  fileName,
  previewUrl,
  isPdf,
  uploading,
  placeholder,
  onPick,
  onView,
  onClear,
}: {
  fileName: string | null;
  previewUrl: string | null;
  isPdf: boolean;
  uploading: boolean;
  placeholder: string;
  onPick: (file: File) => void;
  onView: () => void;
  onClear: () => void;
}) {
  if (uploading) {
    return (
      <div className="flex flex-1 items-center rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-sm text-slate-400">
        Uploading…
      </div>
    );
  }

  if (fileName) {
    return (
      <div className="flex flex-1 items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-1.5">
        {/* A thumbnail, not a tick. An admin — and the dealer — needs to see WHICH
            document went where; "✓ uploaded" on five battery lines tells you
            nothing and is exactly how the wrong scan ends up on the wrong battery. */}
        <button
          type="button"
          onClick={onView}
          title="View"
          className="h-9 w-9 shrink-0 overflow-hidden rounded border border-green-300 bg-white"
        >
          {isPdf || !previewUrl ? (
            <span className="flex h-full w-full items-center justify-center text-[9px] font-bold text-green-700">
              PDF
            </span>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt=""
              className="h-full w-full cursor-zoom-in object-cover"
            />
          )}
        </button>

        <span
          className="min-w-0 flex-1 truncate text-xs font-medium text-green-800"
          title={fileName}
        >
          {fileName}
        </span>

        <button
          type="button"
          onClick={onClear}
          className="shrink-0 pr-1 text-xs font-semibold text-green-700 hover:underline"
        >
          Replace
        </button>
      </div>
    );
  }

  return (
    <label className="flex flex-1 cursor-pointer items-center rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-sm text-slate-400 hover:border-slate-400 hover:text-slate-600">
      <input
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          // Reset, or picking the same file twice in a row fires no change event.
          e.target.value = "";
        }}
      />
      ⇧ {placeholder}
    </label>
  );
}

function SpecPill({ value, filled }: { value: string; filled: boolean }) {
  return (
    <span
      className={`rounded-md px-2.5 py-1.5 text-xs font-bold ${
        filled ? "bg-blue-50 text-blue-600" : "bg-slate-100 text-slate-400"
      }`}
    >
      {value}
    </span>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div
        className={`text-xl font-extrabold tabular-nums ${
          accent ? "text-green-600" : "text-slate-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
