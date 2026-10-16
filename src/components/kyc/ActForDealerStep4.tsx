"use client";

// ID 183 Phase 2 — Step 4 in the CRM "Act for dealer" panel (Admin / Sales
// Head): the product selection draft and the pre-sanction documents, run as
// the FILE's dealer. It reuses the dealer's own Step 4 product picker
// (useProductCart + ProductCartSections), pointed at the file's dealer's stock
// (/api/inventory/dealer/<file dealer>), and saves through the dealer's own
// routes (product-selection/draft, pre-sanction-doc) — which run the
// act-for-dealer checks, write "Done by <name> for <dealer>" and tell the
// dealer. Like the dealer's page, the product cart is for a cash file only
// (a finance file picks stock at Step 5, which stays with the dealer); the
// cash sale itself is the dealer's. Product photos are the dealer's (his
// stock) and are not shown.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  CartPricingSummary,
  ProductCartSections,
  useProductCart,
} from "@/components/dealer-portal/lead-wizard/product-cart";
import type { PriorSelection } from "@/components/dealer-portal/lead-wizard/product-cart";

type BucketItem = { url: string; name: string; type: string; size: number };

interface Step4Access {
  allowed: boolean;
  paymentMode?: "cash" | "finance";
  dealerId?: string | null;
  category?: string | null;
  productId?: string | null;
  readOnly?: boolean;
  reason?: string;
  priorSelection?: PriorSelection | null;
}

const MAX_DOCS = 10;

export default function ActForDealerStep4({
  leadId,
  seenHeader,
  seen,
  disabled,
  onDone,
}: {
  leadId: string;
  /** The panel's "dealer's last action seen" header — the dealer wins a clash. */
  seenHeader: string;
  seen: string;
  disabled: boolean;
  /** Reload the panel after a step (the record and the note change). */
  onDone: () => Promise<void> | void;
}) {
  const base = `/api/lead/${encodeURIComponent(leadId)}`;
  const [access, setAccess] = useState<Step4Access | null>(null);
  const [docs, setDocs] = useState<BucketItem[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [combine, setCombine] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base}/step-4-access`, { cache: "no-store" });
      const json = await res.json().catch(() => null);
      const data = (json?.success ? json.data : null) as Step4Access | null;
      setAccess(data ?? { allowed: false, reason: json?.error?.message ?? "Step 4 is not open on this file." });
      setDocs(Array.isArray(data?.priorSelection?.pre_sanction_doc_urls) ? data!.priorSelection!.pre_sanction_doc_urls! : []);
    } catch {
      setAccess({ allowed: false, reason: "Could not load Step 4." });
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const isCash = access?.paymentMode === "cash";
  const readOnly = disabled || !!access?.readOnly;
  const cart = useProductCart({
    leadId,
    // The FILE's dealer's stock — Admin / Sales Head read any dealer's inventory.
    dealerId: access?.allowed && isCash ? access.dealerId ?? null : null,
    category: access?.category ?? null,
    scopeProducts: [],
    prior: access?.priorSelection ?? null,
    readOnly,
    includeSerials: {
      battery: access?.priorSelection?.battery_serial ?? null,
      charger: access?.priorSelection?.charger_serial ?? null,
    },
    draftKeyPrefix: "act-for-dealer-step4",
    onError: (m) => toast.error(m),
  });

  async function send(key: string, url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    setBusy(key);
    try {
      const headers = new Headers(init.headers);
      headers.set(seenHeader, seen);
      const res = await fetch(url, { ...init, headers });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const ok = res.ok && (json?.success === true || json?.ok === true);
      if (!ok) {
        const err = json?.error as { message?: string } | string | undefined;
        toast.error((typeof err === "string" ? err : err?.message) || "That step was refused");
        return null;
      }
      return json;
    } catch {
      toast.error("Network error — try again");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const draftBody = (preSanctionDocs: BucketItem[]) =>
    JSON.stringify({
      ...(isCash ? cart.toSubmitPayload() : {}),
      category: access?.category ?? undefined,
      subCategory: access?.productId ?? undefined,
      preSanctionDocs,
    });

  async function saveDraft() {
    const ok = await send("draft", `${base}/product-selection/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: draftBody(docs),
    });
    if (ok) toast.success("Step 4 draft saved for the dealer");
    await load();
    await onDone();
  }

  /** Commit the bucket to the file; with no selection row yet, save it as a draft. */
  async function commitDocs(next: BucketItem[]): Promise<boolean> {
    const patched = await send("docs", `${base}/pre-sanction-doc`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: next }),
    });
    if (!patched) return false;
    if (patched.persisted === false) {
      const drafted = await send("docs", `${base}/product-selection/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: draftBody(next),
      });
      if (!drafted) return false;
    }
    setDocs(next);
    return true;
  }

  async function uploadDocs() {
    if (!files.length) return;
    const adding = combine ? 1 : files.length;
    if (docs.length + adding > MAX_DOCS) {
      toast.error(`Up to ${MAX_DOCS} pre-sanction items only (the file has ${docs.length}).`);
      return;
    }
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    fd.append("mode", combine ? "combine" : "separate");
    const up = await send("upload", `${base}/pre-sanction-doc`, { method: "POST", body: fd });
    if (up && Array.isArray(up.items)) {
      if (await commitDocs([...docs, ...(up.items as BucketItem[])])) {
        toast.success("Pre-sanction documents added for the dealer");
        setFiles([]);
      }
    }
    await onDone();
  }

  async function removeDoc(i: number) {
    if (await commitDocs(docs.filter((_, j) => j !== i))) toast.success("Document removed");
    await onDone();
  }

  if (!access) return <p className="text-xs text-gray-500">Loading Step 4…</p>;
  if (!access.allowed) return <p className="text-xs text-gray-500">{access.reason ?? "Step 4 is not open on this file yet."}</p>;

  return (
    <div className="space-y-4">
      {access.readOnly && (
        <p className="rounded bg-gray-50 p-2 text-xs text-gray-600">
          {access.reason ?? "The Step 4 selection is already sent — only the pre-sanction documents can change."}
        </p>
      )}

      {isCash ? (
        <div className="space-y-4">
          <p className="text-xs text-gray-600">
            Cash file — pick the products from the dealer&apos;s stock and save the draft. The dealer confirms the cash sale.
          </p>
          <ProductCartSections cart={cart} show={{ photos: false }} />
          <CartPricingSummary cart={cart} inventoryNote="Saved as the dealer's draft; the dealer confirms the sale" />
          <button
            type="button"
            disabled={readOnly || !!busy}
            onClick={() => void saveDraft()}
            className="rounded bg-gray-900 px-3 py-1.5 text-white disabled:opacity-50"
          >
            {busy === "draft" ? "Saving…" : "Save Step 4 draft"}
          </button>
        </div>
      ) : (
        <p className="text-xs text-gray-600">
          Finance file — the lender pick is below; the stock is picked at Step 5 by the dealer.
        </p>
      )}

      <div>
        <h4 className="mb-1 text-xs font-semibold text-gray-900">Pre-sanction documents ({docs.length}/{MAX_DOCS})</h4>
        <ul className="mb-2 space-y-1 text-xs text-gray-700">
          {docs.length === 0 && <li className="text-gray-500">None yet.</li>}
          {docs.map((d, i) => (
            <li key={`${d.url}-${i}`} className="flex items-center gap-2">
              <a href={d.url} target="_blank" rel="noreferrer" className="text-indigo-700 hover:underline">
                {d.name}
              </a>
              <button
                type="button"
                disabled={disabled || !!busy}
                onClick={() => void removeDoc(i)}
                className="text-red-600 disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} className="text-xs" />
          <label className="flex items-center gap-1 text-xs text-gray-600">
            <input type="checkbox" checked={combine} onChange={(e) => setCombine(e.target.checked)} /> Combine into one PDF
          </label>
          <button
            type="button"
            disabled={disabled || !files.length || !!busy}
            onClick={() => void uploadDocs()}
            className="rounded bg-gray-900 px-3 py-1.5 text-white disabled:opacity-50"
          >
            {busy === "upload" || busy === "docs" ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}
